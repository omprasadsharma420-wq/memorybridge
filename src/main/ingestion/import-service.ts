import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, readdir, rename, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute } from 'node:path'
import { AsyncUnzipInflate, strFromU8, Unzip, type UnzipFile } from 'fflate'
import { createId } from '../../shared/ids'
import {
  chatSchema,
  importRecordSchema,
  messageSchema,
  providerMemorySchema,
  type Chat,
  type ImportRecord,
  type Message
} from '../../shared/schemas'
import { deterministicTitle, slugify } from '../../shared/text'
import { safeErrorCategory } from '../../shared/security'
import { AppError } from '../errors'
import { VaultRepository } from '../storage/repository'
import { VaultManager } from '../storage/vault'

export const IMPORT_LIMITS = {
  maxArchiveBytes: 512 * 1024 * 1024,
  maxEntryBytes: 100 * 1024 * 1024,
  maxTotalDecompressedBytes: 1024 * 1024 * 1024,
  maxZipEntries: 50_000,
  maxCompressionRatio: 250
} as const
export interface ImportSafetyLimits {
  maxArchiveBytes: number
  maxEntryBytes: number
  maxTotalDecompressedBytes: number
  maxZipEntries: number
  maxCompressionRatio: number
}
const CONNECTOR_VERSION = 'chatgpt-export@2'
const SUPPORTED_EXTENSIONS = new Set(['.zip', '.json', '.jsonl', '.md', '.markdown', '.txt'])

interface CanonicalImport {
  connectorId: 'chatgpt-export' | 'generic-file'
  conversations: Array<{ chat: Chat; messages: Message[] }>
  providerMemories: Array<{
    statement: string
    sourceLabel: string
    sourceType:
      | 'provider_saved_memory'
      | 'custom_instruction'
      | 'project_instruction'
      | 'workspace_instruction'
      | 'provider_summary'
      | 'other'
    providerRecordId: string | null
    providerUpdatedAt: string | null
    providerScopeReference: string | null
  }>
  warnings: string[]
  discoveredConversations: number
  branchesHandled: number
  malformedConversations: number
  skippedEntries: number
}

export interface ImportProgress {
  phase: 'reading' | 'decompressing' | 'parsing' | 'persisting' | 'validating' | 'complete'
  processedBytes: number
  totalBytes: number
  completedConversations: number
  totalConversations: number
}

export interface ParseOptions {
  signal?: AbortSignal
  onProgress?: (progress: ImportProgress) => void
  limits?: ImportSafetyLimits
}

interface ImportOptions extends ParseOptions {
  retainArchive?: boolean
}

export interface ImportPreview {
  sourcePath: string
  connectorId: string
  conversations: number
  messages: number
  providerMemories: number
  warnings: string[]
}

export class ImportService {
  constructor(
    private readonly vault: VaultManager,
    private readonly repository: VaultRepository,
    private readonly limits: ImportSafetyLimits = IMPORT_LIMITS
  ) {}

  async preview(sourcePath: string, options: ParseOptions = {}): Promise<ImportPreview> {
    const parsed = await parseSource(sourcePath, { ...options, limits: this.limits })
    return {
      sourcePath,
      connectorId: parsed.connectorId,
      conversations: parsed.conversations.length,
      messages: parsed.conversations.reduce(
        (sum, conversation) => sum + conversation.messages.length,
        0
      ),
      providerMemories: parsed.providerMemories.length,
      warnings: parsed.warnings
    }
  }

  async import(sourcePath: string, options: ImportOptions = {}): Promise<ImportRecord> {
    await this.vault.assertConnected()
    const file = await stat(sourcePath)
    if (file.size > this.limits.maxArchiveBytes)
      throw new AppError('IMPORT_TOO_LARGE', 'The selected import is larger than 512 MB.')
    const archiveHash = await hashFile(sourcePath, options)
    const previous = this.repository.findImportByHash(archiveHash)
    const now = new Date().toISOString()
    if (previous?.status === 'complete' || previous?.status === 'unchanged') {
      const unchanged = importRecordSchema.parse({
        ...previous,
        import_id: createId('import'),
        status: 'unchanged',
        started_at: now,
        completed_at: now,
        imported_count: 0,
        changed_count: 0,
        skipped_count: previous.conversation_count
      })
      await this.repository.saveImportRecord(unchanged)
      return unchanged
    }

    const parsed = await parseSource(sourcePath, { ...options, limits: this.limits })
    const priorCompleted = new Set(
      Array.isArray(previous?.checkpoint.completedIndexes)
        ? previous.checkpoint.completedIndexes.filter(
            (value): value is number => Number.isInteger(value) && value >= 0
          )
        : []
    )
    const conversationKeys = parsed.conversations.map(
      ({ chat }) => `${chat.source_provider}:${chat.source_conversation_id ?? chat.chat_id}`
    )
    const record = importRecordSchema.parse({
      import_id: createId('import'),
      connector_id: parsed.connectorId,
      connector_version:
        parsed.connectorId === 'chatgpt-export' ? CONNECTOR_VERSION : 'generic-file@1',
      source_path: basename(sourcePath),
      archive_hash: archiveHash,
      status: 'running',
      started_at: now,
      conversation_count: parsed.conversations.length,
      message_count: parsed.conversations.reduce(
        (sum, conversation) => sum + conversation.messages.length,
        0
      ),
      review_count: parsed.providerMemories.length + parsed.warnings.length,
      discovered_count: parsed.discoveredConversations,
      branches_handled: parsed.branchesHandled,
      malformed_count: parsed.malformedConversations,
      skipped_entry_count: parsed.skippedEntries,
      checkpoint: {
        nextConversation: 0,
        completedIndexes: [...priorCompleted],
        failedIndexes: [],
        conversationKeys
      },
      error_messages: [...parsed.warnings]
    })
    await this.repository.saveImportRecord(record)
    let imported = 0
    let changed = 0
    let skipped = 0
    let errors = 0
    const errorMessages = [...parsed.warnings]
    const failedIndexes: number[] = []
    for (let index = 0; index < parsed.conversations.length; index += 1) {
      if (options.signal?.aborted) {
        errorMessages.push('Import cancelled by the user. Completed conversations were retained.')
        break
      }
      if (priorCompleted.has(index)) {
        skipped += 1
        continue
      }
      try {
        const result = await this.repository.upsertCanonicalConversation(
          parsed.conversations[index]!.chat,
          parsed.conversations[index]!.messages
        )
        if (result === 'imported') imported += 1
        else if (result === 'changed') changed += 1
        else skipped += 1
        priorCompleted.add(index)
      } catch (error) {
        errors += 1
        failedIndexes.push(index)
        errorMessages.push(`Conversation ${index + 1}: ${safeImportMessage(error)}`)
      }
      record.checkpoint = {
        nextConversation: index + 1,
        completedIndexes: [...priorCompleted],
        failedIndexes,
        conversationKeys
      }
      record.imported_count = imported
      record.changed_count = changed
      record.skipped_count = skipped
      record.error_count = errors
      record.error_messages = errorMessages.slice(0, 100)
      await this.repository.saveImportRecord(record)
      options.onProgress?.({
        phase: 'persisting',
        processedBytes: file.size,
        totalBytes: file.size,
        completedConversations: index + 1,
        totalConversations: parsed.conversations.length
      })
    }
    const cancelled = Boolean(options.signal?.aborted)
    const existingProviderHashes = new Set(
      this.repository
        .listProviderMemories()
        .map((memory) => `${memory.provider}:${memory.content_hash}`)
    )
    for (const item of cancelled ? [] : parsed.providerMemories) {
      const contentHash = createHash('sha256').update(item.statement).digest('hex')
      if (existingProviderHashes.has(`chatgpt:${contentHash}`)) continue
      await this.repository.saveProviderMemory(
        providerMemorySchema.parse({
          provider_memory_id: createId('pmem'),
          provider: 'chatgpt',
          provider_record_id: item.providerRecordId,
          source_type: item.sourceType,
          statement: item.statement,
          source_label: item.sourceLabel,
          scope: providerMemoryScope(item),
          state: 'needs_review',
          user_confirmed: false,
          imported_at: now,
          provider_updated_at: item.providerUpdatedAt,
          raw_source_reference: item.sourceLabel,
          superseded_by: null,
          content_hash: contentHash
        })
      )
      existingProviderHashes.add(`chatgpt:${contentHash}`)
    }
    const completed = importRecordSchema.parse({
      ...record,
      status: cancelled
        ? 'cancelled'
        : errors
          ? imported || changed
            ? 'partial'
            : 'failed'
          : 'complete',
      completed_at: new Date().toISOString(),
      imported_count: imported,
      changed_count: changed,
      skipped_count: skipped,
      error_count: errors,
      review_count: parsed.providerMemories.length + parsed.warnings.length,
      error_category: cancelled ? 'import-cancelled' : errors ? 'conversation-import-failed' : null,
      error_messages: errorMessages.slice(0, 100)
    })
    await this.repository.saveImportRecord(completed)
    options.onProgress?.({
      phase: 'complete',
      processedBytes: file.size,
      totalBytes: file.size,
      completedConversations: parsed.conversations.length,
      totalConversations: parsed.conversations.length
    })
    return completed
  }

  async scanInbox(): Promise<ImportRecord[]> {
    const results: ImportRecord[] = []
    const inbox = this.vault.path('import-inbox')
    for (const entry of await readdir(inbox, { withFileTypes: true })) {
      if (!entry.isFile() || !SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue
      const source = this.vault.path('import-inbox', entry.name)
      try {
        const result = await this.import(source)
        results.push(result)
        await rename(source, this.vault.path('imported', `${result.import_id}--${entry.name}`))
      } catch (error) {
        const failedAt = new Date().toISOString()
        const failed = importRecordSchema.parse({
          import_id: createId('import'),
          connector_id: 'unknown',
          source_path: entry.name,
          archive_hash: await hashFile(source),
          status: 'failed',
          started_at: failedAt,
          completed_at: failedAt,
          error_count: 1,
          error_category: safeErrorCategory(error),
          error_messages: [safeImportMessage(error)]
        })
        await this.repository.saveImportRecord(failed)
        results.push(failed)
        await rename(
          source,
          this.vault.path('failed-imports', `${failed.import_id}--${entry.name}`)
        )
      }
    }
    return results
  }
}

async function parseSource(
  sourcePath: string,
  options: ParseOptions = {}
): Promise<CanonicalImport> {
  throwIfAborted(options.signal)
  const file = await stat(sourcePath)
  const limits = options.limits ?? IMPORT_LIMITS
  if (file.size > limits.maxArchiveBytes)
    throw new AppError('IMPORT_TOO_LARGE', 'The selected import is larger than 512 MB.')
  const extension = extname(sourcePath).toLowerCase()
  if (!SUPPORTED_EXTENSIONS.has(extension))
    throw new AppError('IMPORT_UNSUPPORTED', 'Choose a ZIP, JSON, JSONL, Markdown, or text file.')
  if (extension === '.zip') return parseChatGptZip(sourcePath, options)
  const bytes = await readFile(sourcePath)
  throwIfAborted(options.signal)
  options.onProgress?.({
    phase: 'parsing',
    processedBytes: bytes.byteLength,
    totalBytes: file.size,
    completedConversations: 0,
    totalConversations: 0
  })
  return parseGeneric(strFromU8(bytes), extension, sourcePath)
}

async function parseChatGptZip(
  sourcePath: string,
  options: ParseOptions
): Promise<CanonicalImport> {
  const entries = await readSelectedZipEntries(sourcePath, options)
  const conversations = entries.get('conversations.json')
  if (!conversations)
    throw new AppError('IMPORT_CHATGPT_MISSING', 'The ZIP does not contain conversations.json.')
  let raw: unknown
  try {
    raw = JSON.parse(strFromU8(conversations))
  } catch {
    throw new AppError('IMPORT_MALFORMED_JSON', 'conversations.json is not valid JSON.')
  }
  if (!Array.isArray(raw))
    throw new AppError('IMPORT_INVALID_SHAPE', 'conversations.json must contain an array.')
  const warnings: string[] = []
  let branchesHandled = 0
  let malformedConversations = 0
  const canonicalConversations = raw.flatMap((value, index) => {
    try {
      const result = canonicalizeChatGptConversation(asRecord(value), sourcePath, index)
      warnings.push(...result.warnings)
      branchesHandled += result.branchesHandled
      return result.conversations
    } catch (error) {
      malformedConversations += 1
      warnings.push(
        `Conversation ${index + 1} was malformed and skipped (${safeImportMessage(error)}).`
      )
      return []
    }
  })
  const memories = entries.get('memories.json')
  const providerMemories = memories ? parseProviderMemories(memories) : []
  options.onProgress?.({
    phase: 'parsing',
    processedBytes: (await stat(sourcePath)).size,
    totalBytes: (await stat(sourcePath)).size,
    completedConversations: canonicalConversations.length,
    totalConversations: raw.length
  })
  return {
    connectorId: 'chatgpt-export',
    conversations: canonicalConversations,
    providerMemories,
    warnings,
    discoveredConversations: raw.length,
    branchesHandled,
    malformedConversations,
    skippedEntries: 0
  }
}

async function readSelectedZipEntries(
  sourcePath: string,
  options: ParseOptions
): Promise<Map<'conversations.json' | 'memories.json', Uint8Array>> {
  const file = await stat(sourcePath)
  const limits = options.limits ?? IMPORT_LIMITS
  const selected = new Map<'conversations.json' | 'memories.json', Uint8Array>()
  const activeFiles = new Set<UnzipFile>()
  let entryCount = 0
  let declaredTotal = 0
  let processedBytes = 0
  let pendingSelected = 0
  let inputComplete = false
  let settled = false
  let resolveCompletion!: () => void
  let rejectCompletion!: (error: unknown) => void
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve
    rejectCompletion = reject
  })
  // ZIP callbacks can reject before the stream loop reaches its first await.
  // Attach a handler immediately so Node does not report a transient
  // unhandled rejection; callers still receive the original rejection below.
  void completion.catch(() => undefined)
  const finishIfReady = (): void => {
    if (!settled && inputComplete && pendingSelected === 0) {
      settled = true
      resolveCompletion()
    }
  }
  const fail = (error: unknown): void => {
    if (settled) return
    settled = true
    for (const active of activeFiles) active.terminate()
    rejectCompletion(error)
  }
  const unzip = new Unzip((entry) => {
    try {
      throwIfAborted(options.signal)
      entryCount += 1
      if (entryCount > limits.maxZipEntries) {
        throw new AppError(
          'IMPORT_TOO_MANY_FILES',
          'The ZIP contains too many files to import safely.'
        )
      }
      const normalizedName = normalizeZipEntryName(entry.name)
      if (entry.originalSize !== undefined) {
        if (entry.originalSize > limits.maxEntryBytes) {
          throw new AppError(
            'IMPORT_ENTRY_TOO_LARGE',
            `ZIP entry ${basename(normalizedName)} exceeds the 100 MB safety limit.`
          )
        }
        declaredTotal += entry.originalSize
        if (declaredTotal > limits.maxTotalDecompressedBytes) {
          throw new AppError(
            'IMPORT_EXPANSION_LIMIT',
            'The ZIP expands beyond the 1 GB cumulative safety limit.'
          )
        }
        if (
          entry.size &&
          entry.originalSize / Math.max(1, entry.size) > limits.maxCompressionRatio
        ) {
          throw new AppError(
            'IMPORT_COMPRESSION_RATIO',
            `ZIP entry ${basename(normalizedName)} has an unsafe compression ratio.`
          )
        }
      }
      const match = /(^|\/)(conversations|memories)\.json$/i.exec(normalizedName)
      if (!match) return
      const key = `${match[2]!.toLowerCase()}.json` as 'conversations.json' | 'memories.json'
      if (selected.has(key)) return
      pendingSelected += 1
      activeFiles.add(entry)
      const chunks: Uint8Array[] = []
      let expanded = 0
      entry.ondata = (error, chunk, final) => {
        if (error) {
          fail(new AppError('IMPORT_MALFORMED_ZIP', 'The ChatGPT export ZIP could not be read.'))
          return
        }
        try {
          throwIfAborted(options.signal)
          expanded += chunk.byteLength
          if (expanded > limits.maxEntryBytes)
            throw new AppError(
              'IMPORT_ENTRY_TOO_LARGE',
              `ZIP entry ${basename(normalizedName)} exceeds the 100 MB safety limit.`
            )
          if (chunk.byteLength) chunks.push(chunk)
          if (!final) return
          const output = new Uint8Array(expanded)
          let offset = 0
          for (const value of chunks) {
            output.set(value, offset)
            offset += value.byteLength
          }
          selected.set(key, output)
          activeFiles.delete(entry)
          pendingSelected -= 1
          finishIfReady()
        } catch (entryError) {
          fail(entryError)
        }
      }
      entry.start()
    } catch (error) {
      fail(error)
    }
  })
  unzip.register(AsyncUnzipInflate)
  const stream = createReadStream(sourcePath, { highWaterMark: 256 * 1024 })
  const abort = (): void => {
    stream.destroy(new Error('IMPORT_CANCELLED'))
  }
  options.signal?.addEventListener('abort', abort, { once: true })
  try {
    for await (const rawChunk of stream) {
      throwIfAborted(options.signal)
      if (settled) await completion
      const chunk = rawChunk instanceof Uint8Array ? rawChunk : new Uint8Array(rawChunk)
      processedBytes += chunk.byteLength
      unzip.push(chunk, false)
      options.onProgress?.({
        phase: 'decompressing',
        processedBytes,
        totalBytes: file.size,
        completedConversations: 0,
        totalConversations: 0
      })
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    inputComplete = true
    unzip.push(new Uint8Array(), true)
    finishIfReady()
    await completion
    if (entryCount === 0)
      throw new AppError('IMPORT_MALFORMED_ZIP', 'The ChatGPT export ZIP could not be read.')
  } catch (error) {
    const mapped = options.signal?.aborted
      ? new AppError('IMPORT_CANCELLED', 'The import was cancelled safely.', true)
      : error instanceof AppError
        ? error
        : new AppError('IMPORT_MALFORMED_ZIP', 'The ChatGPT export ZIP could not be read.')
    fail(mapped)
    await completion.catch(() => undefined)
    throw mapped
  } finally {
    options.signal?.removeEventListener('abort', abort)
    for (const active of activeFiles) active.terminate()
  }
  return selected
}

function normalizeZipEntryName(name: string): string {
  const normalized = name.replaceAll('\\', '/')
  const parts = normalized.split('/')
  if (
    !normalized ||
    isAbsolute(normalized) ||
    /^[a-z]:/i.test(normalized) ||
    parts.some((part) => part === '..' || part.includes('\0'))
  ) {
    throw new AppError('IMPORT_UNSAFE_PATH', 'The ZIP contains an unsafe entry path.')
  }
  return parts.filter((part) => part && part !== '.').join('/')
}

function resolveBranchPath(
  nodes: Map<
    string,
    {
      nodeId: string
      node: Record<string, unknown>
      parentId: string | null
      children: string[]
    }
  >,
  leafId: string
): { leafId: string; nodeIds: string[]; issue: string | null } {
  const reverse: string[] = []
  const visited = new Set<string>()
  let current: string | null = leafId
  let issue: string | null = null
  while (current) {
    if (visited.has(current)) {
      issue = 'A parent cycle was detected; only the coherent suffix was retained for review.'
      break
    }
    visited.add(current)
    const node = nodes.get(current)
    if (!node) {
      issue = 'A parent link was missing; only the coherent suffix was retained for review.'
      break
    }
    reverse.push(current)
    if (node.parentId && !nodes.has(node.parentId)) {
      issue = 'A parent link was malformed; only the coherent suffix was retained for review.'
      break
    }
    current = node.parentId
  }
  return { leafId, nodeIds: reverse.reverse(), issue }
}

function hasMessage(node: Record<string, unknown> | undefined): boolean {
  return Boolean(node && Object.keys(asRecord(node.message)).length)
}

function canonicalizeChatGptConversation(
  value: Record<string, unknown>,
  sourcePath: string,
  index: number
): {
  conversations: Array<{ chat: Chat; messages: Message[] }>
  warnings: string[]
  branchesHandled: number
} {
  const providerId = stringValue(value.id) ?? `archive-${index}`
  const title = stringValue(value.title) ?? 'Imported ChatGPT conversation'
  const mapping = asRecord(value.mapping)
  const nodes = new Map(
    Object.entries(mapping).map(([nodeId, raw]) => {
      const node = asRecord(raw)
      return [
        nodeId,
        {
          nodeId,
          node,
          parentId: stringValue(node.parent),
          children: Array.isArray(node.children)
            ? node.children.filter((child): child is string => typeof child === 'string')
            : []
        }
      ] as const
    })
  )
  if (nodes.size === 0) throw new Error('Conversation mapping is empty.')
  const currentNode = stringValue(value.current_node)
  const leaves = [...nodes.values()]
    .filter(({ nodeId }) => ![...nodes.values()].some((node) => node.parentId === nodeId))
    .map(({ nodeId }) => nodeId)
  const requestedLeaves = currentNode && nodes.has(currentNode) ? [currentNode] : leaves
  const resolved = requestedLeaves
    .slice(0, 100)
    .map((leaf) => resolveBranchPath(nodes, leaf))
    .filter((branch) => branch.nodeIds.some((nodeId) => hasMessage(nodes.get(nodeId)?.node)))
  if (resolved.length === 0) throw new Error('Conversation has no coherent supported branch.')
  const unresolved = !currentNode || !nodes.has(currentNode)
  const warnings: string[] = []
  if (unresolved) {
    warnings.push(
      `Conversation ${index + 1} had no resolvable current node; ${resolved.length} coherent branch path(s) were imported separately for review.`
    )
  }
  for (const branch of resolved) {
    if (branch.issue)
      warnings.push(`Conversation ${index + 1}, branch ${branch.leafId}: ${branch.issue}`)
  }
  const createdFallback = toIso(value.create_time)
  const conversations = resolved.flatMap((branch, branchIndex) => {
    const sourceConversationId =
      resolved.length === 1 && !unresolved ? providerId : `${providerId}::branch:${branch.leafId}`
    const chatId = stableId('chat', `chatgpt:${sourceConversationId}`)
    const messages = branch.nodeIds
      .map((nodeId, ordinal) => {
        const node = nodes.get(nodeId)
        return node
          ? canonicalizeChatGptMessage(
              chatId,
              sourceConversationId,
              branch.leafId,
              nodeId,
              node.node,
              ordinal,
              createdFallback
            )
          : null
      })
      .filter((message): message is Message => Boolean(message))
      .map((message, sequence) => ({ ...message, sequence }))
    if (messages.length === 0) return []
    const createdAt = messages[0]?.created_at ?? createdFallback
    const updatedAt = messages.at(-1)?.updated_at ?? toIso(value.update_time, createdAt)
    const contentHash = createHash('sha256')
      .update(
        messages
          .map((message) => `${message.provider_message_id}:${message.content_hash}`)
          .join('|')
      )
      .digest('hex')
    const branchTitle = resolved.length > 1 ? `${title} (branch ${branchIndex + 1})` : title
    const chat = chatSchema.parse({
      chat_id: chatId,
      project_id: null,
      title: branchTitle,
      slug: slugify(branchTitle, 'chat'),
      created_at: createdAt,
      updated_at: updatedAt,
      source_provider: 'chatgpt',
      source_conversation_id: sourceConversationId,
      original_title: title,
      model_ids: [
        ...new Set(messages.map((message) => message.model).filter((model) => model !== 'unknown'))
      ],
      branch_count: Math.max(1, leaves.length),
      attachment_count: messages.reduce(
        (sum, message) => sum + (message.attachments?.length ?? 0),
        0
      ),
      citation_count: messages.reduce((sum, message) => sum + (message.citations?.length ?? 0), 0),
      sync_state: 'imported',
      processing_state: unresolved || branch.issue ? 'needs_review' : 'unprocessed',
      import_origin: basename(sourcePath),
      content_hash: contentHash,
      raw_metadata: {
        ...boundedMetadata(value, ['conversation_template_id', 'gizmo_id', 'is_archived']),
        branch_resolution: unresolved ? 'separate_coherent_paths' : 'active_path',
        branch_leaf_id: branch.leafId,
        branch_path_node_ids: branch.nodeIds.slice(0, 500),
        branch_review_required: Boolean(unresolved || branch.issue),
        connector_version: CONNECTOR_VERSION
      }
    })
    return [{ chat, messages }]
  })
  return {
    conversations,
    warnings,
    branchesHandled: Math.max(0, conversations.length - 1) + (currentNode ? 1 : 0)
  }
}

function canonicalizeChatGptMessage(
  chatId: string,
  sourceConversationId: string,
  branchId: string,
  nodeId: string,
  node: Record<string, unknown>,
  ordinal: number,
  fallback: string
): Message | null {
  const raw = asRecord(node.message)
  const author = asRecord(raw.author)
  const rawRole = stringValue(author.role) ?? 'assistant'
  const role = rawRole === 'user' || rawRole === 'system' ? rawRole : 'assistant'
  const content = asRecord(raw.content)
  const parts = Array.isArray(content.parts) ? content.parts : []
  const text = parts.map(partToText).filter(Boolean).join('\n') || stringValue(content.text) || ''
  if (!text.trim() && rawRole !== 'system') return null
  const createdAt = toIso(raw.create_time, fallback)
  const model = stringValue(asRecord(raw.metadata).model_slug) ?? 'unknown'
  return messageSchema.parse({
    message_id: stableId('msg', `chatgpt:${sourceConversationId}:${stringValue(raw.id) ?? nodeId}`),
    chat_id: chatId,
    role,
    content: text,
    created_at: createdAt,
    updated_at: toIso(raw.update_time, createdAt),
    provider: 'chatgpt',
    model,
    status: stringValue(raw.status) === 'in_progress' ? 'interrupted' : 'complete',
    sequence: ordinal,
    provider_message_id: stringValue(raw.id) ?? nodeId,
    parent_message_id: stringValue(node.parent),
    branch_id: branchId,
    content_blocks: parts.map((part) => ({ type: typeof part, value: boundedValue(part) })),
    attachments: arrayRecords(asRecord(raw.metadata).attachments),
    citations: arrayRecords(asRecord(raw.metadata).citations),
    raw_metadata: boundedMetadata(raw, ['recipient', 'end_turn', 'weight']),
    content_hash: createHash('sha256').update(text).digest('hex')
  })
}

function parseGeneric(text: string, extension: string, sourcePath: string): CanonicalImport {
  if (extension === '.md' || extension === '.markdown' || extension === '.txt') {
    return {
      connectorId: 'generic-file',
      conversations: [textConversation(text, sourcePath)],
      providerMemories: [],
      warnings: [],
      discoveredConversations: 1,
      branchesHandled: 0,
      malformedConversations: 0,
      skippedEntries: 0
    }
  }
  let values: unknown[]
  try {
    values =
      extension === '.jsonl'
        ? text
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => JSON.parse(line) as unknown)
        : (() => {
            const parsed = JSON.parse(text) as unknown
            return Array.isArray(parsed) ? parsed : [parsed]
          })()
  } catch {
    throw new AppError('IMPORT_MALFORMED_JSON', 'The selected JSON or JSONL file is malformed.')
  }
  const looksLikeMessages = values.every((value) => stringValue(asRecord(value).content) !== null)
  const rawConversations = looksLikeMessages
    ? [{ title: basename(sourcePath), messages: values }]
    : values
  const warnings: string[] = []
  const conversations = rawConversations.flatMap((value, index) => {
    try {
      return [canonicalizeGenericConversation(asRecord(value), sourcePath, index)]
    } catch {
      warnings.push(`Record ${index + 1} was malformed and skipped.`)
      return []
    }
  })
  return {
    connectorId: 'generic-file',
    conversations,
    providerMemories: [],
    warnings,
    discoveredConversations: rawConversations.length,
    branchesHandled: 0,
    malformedConversations: rawConversations.length - conversations.length,
    skippedEntries: rawConversations.length - conversations.length
  }
}

function canonicalizeGenericConversation(
  value: Record<string, unknown>,
  sourcePath: string,
  index: number
): { chat: Chat; messages: Message[] } {
  const values = Array.isArray(value.messages) ? value.messages : []
  if (!values.length) throw new Error('No messages')
  const providerId = stringValue(value.id) ?? `${basename(sourcePath)}:${index}`
  const sourceProvider = stringValue(value.provider) ?? 'generic'
  const chatId = stableId('chat', `${sourceProvider}:${providerId}`)
  const title =
    stringValue(value.title) ??
    deterministicTitle(stringValue(asRecord(values[0]).content) ?? basename(sourcePath))
  const messages = values.map((raw, sequence) => {
    const item = asRecord(raw)
    const rawRole = stringValue(item.role) ?? 'user'
    const role = rawRole === 'assistant' || rawRole === 'system' ? rawRole : 'user'
    const content = stringValue(item.content) ?? JSON.stringify(item)
    const createdAt = toIso(item.created_at ?? item.timestamp)
    return messageSchema.parse({
      message_id: stableId(
        'msg',
        `${sourceProvider}:${providerId}:${stringValue(item.id) ?? sequence}`
      ),
      chat_id: chatId,
      role,
      content,
      created_at: createdAt,
      updated_at: createdAt,
      provider: stringValue(item.provider) ?? 'generic-import',
      model: stringValue(item.model) ?? 'unknown',
      status: 'complete',
      sequence,
      provider_message_id: stringValue(item.id),
      raw_metadata: boundedMetadata(item, ['name', 'type']),
      content_hash: createHash('sha256').update(content).digest('hex')
    })
  })
  return {
    chat: chatSchema.parse({
      chat_id: chatId,
      project_id: null,
      title,
      slug: slugify(title, 'chat'),
      created_at: messages[0]!.created_at,
      updated_at: messages.at(-1)!.updated_at,
      source_provider: sourceProvider,
      source_conversation_id: providerId,
      original_title: title,
      sync_state: 'imported',
      processing_state: 'unprocessed',
      import_origin: basename(sourcePath),
      content_hash: createHash('sha256')
        .update(messages.map((message) => message.content_hash).join('|'))
        .digest('hex'),
      raw_metadata: boundedMetadata(value, ['workspace', 'folder'])
    }),
    messages
  }
}

function textConversation(text: string, sourcePath: string): { chat: Chat; messages: Message[] } {
  if (!text.trim()) throw new AppError('IMPORT_EMPTY', 'The selected text file is empty.')
  return canonicalizeGenericConversation(
    { title: basename(sourcePath), messages: [{ role: 'user', content: text }] },
    sourcePath,
    0
  )
}

function parseProviderMemories(bytes: Uint8Array): CanonicalImport['providerMemories'] {
  try {
    const raw = JSON.parse(strFromU8(bytes)) as unknown
    const values = Array.isArray(raw) ? raw : []
    return values.flatMap((value, index) => {
      const item = asRecord(value)
      const statement = stringValue(item.content) ?? stringValue(item.statement)
      const sourceType = providerMemorySourceType(stringValue(item.type))
      return statement
        ? [
            {
              statement,
              sourceLabel: `ChatGPT export memory ${index + 1}`,
              sourceType,
              providerRecordId: stringValue(item.id),
              providerUpdatedAt: nullableIso(item.updated_at ?? item.update_time),
              providerScopeReference:
                stringValue(item.project_id) ??
                stringValue(item.workspace_id) ??
                stringValue(item.conversation_id) ??
                stringValue(item.source)
            }
          ]
        : []
    })
  } catch {
    return []
  }
}

function providerMemorySourceType(
  value: string | null
): CanonicalImport['providerMemories'][number]['sourceType'] {
  const normalized = value?.toLowerCase().replace(/[\s-]+/g, '_')
  if (normalized === 'custom_instruction') return 'custom_instruction'
  if (normalized === 'project_instruction') return 'project_instruction'
  if (normalized === 'workspace_instruction') return 'workspace_instruction'
  if (normalized === 'provider_summary' || normalized === 'summary') return 'provider_summary'
  if (normalized === 'provider_saved_memory' || normalized === 'memory' || !normalized)
    return 'provider_saved_memory'
  return 'other'
}

function providerMemoryScope(item: CanonicalImport['providerMemories'][number]):
  | { kind: 'global' }
  | {
      kind: 'provider'
      level: 'project' | 'workspace' | 'conversation' | 'unknown'
      reference: string | null
    } {
  if (item.sourceType === 'provider_saved_memory' || item.sourceType === 'custom_instruction')
    return { kind: 'global' }
  if (item.sourceType === 'project_instruction')
    return { kind: 'provider', level: 'project', reference: item.providerScopeReference }
  if (item.sourceType === 'workspace_instruction')
    return { kind: 'provider', level: 'workspace', reference: item.providerScopeReference }
  if (item.sourceType === 'provider_summary')
    return { kind: 'provider', level: 'conversation', reference: item.providerScopeReference }
  return { kind: 'provider', level: 'unknown', reference: item.providerScopeReference }
}

function nullableIso(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const parsed = toIso(value, '')
  return parsed || null
}

function safeImportMessage(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/[\r\n]+/g, ' ').slice(0, 1000)
  return 'Unknown import failure.'
}

async function hashFile(sourcePath: string, options: ParseOptions = {}): Promise<string> {
  const file = await stat(sourcePath)
  const hash = createHash('sha256')
  let processedBytes = 0
  const stream = createReadStream(sourcePath, { highWaterMark: 1024 * 1024 })
  const abort = (): void => {
    stream.destroy(new Error('IMPORT_CANCELLED'))
  }
  options.signal?.addEventListener('abort', abort, { once: true })
  try {
    for await (const chunk of stream) {
      throwIfAborted(options.signal)
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
      processedBytes += bytes.byteLength
      hash.update(bytes)
      options.onProgress?.({
        phase: 'reading',
        processedBytes,
        totalBytes: file.size,
        completedConversations: 0,
        totalConversations: 0
      })
    }
    return hash.digest('hex')
  } catch (error) {
    if (options.signal?.aborted)
      throw new AppError('IMPORT_CANCELLED', 'The import was cancelled safely.', true)
    throw error
  } finally {
    options.signal?.removeEventListener('abort', abort)
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new AppError('IMPORT_CANCELLED', 'The import was cancelled safely.', true)
}

function stableId(prefix: 'chat' | 'msg', seed: string): string {
  return `${prefix}_${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}
function partToText(value: unknown): string {
  return typeof value === 'string' ? value : (stringValue(asRecord(value).text) ?? '')
}
function toIso(value?: unknown, fallback = new Date().toISOString()): string {
  if (typeof value === 'number' && Number.isFinite(value))
    return new Date(value < 10_000_000_000 ? value * 1000 : value).toISOString()
  if (typeof value === 'string') {
    const date = new Date(value)
    if (!Number.isNaN(date.valueOf())) return date.toISOString()
  }
  return fallback
}
function arrayRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(asRecord).slice(0, 100) : []
}
function boundedMetadata(value: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(
    keys.filter((key) => key in value).map((key) => [key, boundedValue(value[key])])
  )
}
function boundedValue(value: unknown): unknown {
  const serialized = JSON.stringify(value)
  return serialized && serialized.length <= 8_000 ? value : '[metadata omitted: over 8 KB]'
}
