import { createHash } from 'node:crypto'
import { readFile, readdir, rename } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
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

const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
const MAX_ENTRY_BYTES = 100 * 1024 * 1024
const MAX_ZIP_ENTRIES = 50_000
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
  }>
  warnings: string[]
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
    private readonly repository: VaultRepository
  ) {}

  async preview(sourcePath: string): Promise<ImportPreview> {
    const parsed = await parseSource(sourcePath)
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

  async import(sourcePath: string): Promise<ImportRecord> {
    await this.vault.assertConnected()
    const bytes = await readFile(sourcePath)
    if (bytes.byteLength > MAX_ARCHIVE_BYTES)
      throw new AppError('IMPORT_TOO_LARGE', 'The selected import is larger than 512 MB.')
    const archiveHash = createHash('sha256').update(bytes).digest('hex')
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

    const parsed = await parseBytes(sourcePath, bytes)
    const priorCompleted = new Set(
      Array.isArray(previous?.checkpoint.completedIndexes)
        ? previous.checkpoint.completedIndexes.filter(
            (value): value is number => Number.isInteger(value) && value >= 0
          )
        : []
    )
    const record = importRecordSchema.parse({
      import_id: createId('import'),
      connector_id: parsed.connectorId,
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
      checkpoint: { nextConversation: 0, completedIndexes: [...priorCompleted], failedIndexes: [] },
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
        failedIndexes
      }
      record.imported_count = imported
      record.changed_count = changed
      record.skipped_count = skipped
      record.error_count = errors
      record.error_messages = errorMessages.slice(0, 100)
      await this.repository.saveImportRecord(record)
    }
    const existingProviderHashes = new Set(
      this.repository
        .listProviderMemories()
        .map((memory) => `${memory.provider}:${memory.content_hash}`)
    )
    for (const item of parsed.providerMemories) {
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
          scope: { kind: 'global' },
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
      status: errors ? (imported || changed ? 'partial' : 'failed') : 'complete',
      completed_at: new Date().toISOString(),
      imported_count: imported,
      changed_count: changed,
      skipped_count: skipped,
      error_count: errors,
      review_count: parsed.providerMemories.length + parsed.warnings.length,
      error_category: errors ? 'conversation-import-failed' : null,
      error_messages: errorMessages.slice(0, 100)
    })
    await this.repository.saveImportRecord(completed)
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
          archive_hash: createHash('sha256')
            .update(await readFile(source))
            .digest('hex'),
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

async function parseSource(sourcePath: string): Promise<CanonicalImport> {
  const bytes = await readFile(sourcePath)
  if (bytes.byteLength > MAX_ARCHIVE_BYTES)
    throw new AppError('IMPORT_TOO_LARGE', 'The selected import is larger than 512 MB.')
  return parseBytes(sourcePath, bytes)
}

async function parseBytes(sourcePath: string, bytes: Uint8Array): Promise<CanonicalImport> {
  const extension = extname(sourcePath).toLowerCase()
  if (!SUPPORTED_EXTENSIONS.has(extension))
    throw new AppError('IMPORT_UNSUPPORTED', 'Choose a ZIP, JSON, JSONL, Markdown, or text file.')
  if (extension === '.zip') return parseChatGptZip(bytes, sourcePath)
  return parseGeneric(strFromU8(bytes), extension, sourcePath)
}

function parseChatGptZip(bytes: Uint8Array, sourcePath: string): CanonicalImport {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes, {
      filter: (file) => file.originalSize <= MAX_ENTRY_BYTES
    })
  } catch {
    throw new AppError('IMPORT_MALFORMED_ZIP', 'The ChatGPT export ZIP could not be read.')
  }
  const names = Object.keys(files)
  if (names.length > MAX_ZIP_ENTRIES)
    throw new AppError('IMPORT_TOO_MANY_FILES', 'The ZIP contains too many files to import safely.')
  const conversationsName = names.find((name) => /(^|\/)conversations\.json$/i.test(name))
  if (!conversationsName)
    throw new AppError('IMPORT_CHATGPT_MISSING', 'The ZIP does not contain conversations.json.')
  let raw: unknown
  try {
    raw = JSON.parse(strFromU8(files[conversationsName]!))
  } catch {
    throw new AppError('IMPORT_MALFORMED_JSON', 'conversations.json is not valid JSON.')
  }
  if (!Array.isArray(raw))
    throw new AppError('IMPORT_INVALID_SHAPE', 'conversations.json must contain an array.')
  const warnings: string[] = []
  const conversations = raw.flatMap((value, index) => {
    try {
      return [canonicalizeChatGptConversation(asRecord(value), sourcePath, index)]
    } catch {
      warnings.push(`Conversation ${index + 1} was malformed and skipped.`)
      return []
    }
  })
  const memoriesName = names.find((name) => /(^|\/)memories\.json$/i.test(name))
  const providerMemories = memoriesName ? parseProviderMemories(files[memoriesName]!) : []
  return { connectorId: 'chatgpt-export', conversations, providerMemories, warnings }
}

function canonicalizeChatGptConversation(
  value: Record<string, unknown>,
  sourcePath: string,
  index: number
): { chat: Chat; messages: Message[] } {
  const providerId = stringValue(value.id) ?? `archive-${index}`
  const title = stringValue(value.title) ?? 'Imported ChatGPT conversation'
  const mapping = asRecord(value.mapping)
  const nodes = Object.entries(mapping)
    .map(([nodeId, raw]) => ({ nodeId, node: asRecord(raw) }))
    .filter(({ node }) => Object.keys(asRecord(node.message)).length > 0)
  const createdFallback = toIso(value.create_time)
  const chatId = createId('chat')
  const messages = nodes
    .map(({ nodeId, node }, ordinal) =>
      canonicalizeChatGptMessage(chatId, nodeId, node, ordinal, createdFallback)
    )
    .filter((message): message is Message => Boolean(message))
    .sort(
      (left, right) =>
        left.created_at.localeCompare(right.created_at) || left.sequence - right.sequence
    )
    .map((message, sequence) => ({ ...message, sequence }))
  if (messages.length === 0) throw new Error('Conversation has no supported messages.')
  const createdAt = messages[0]?.created_at ?? createdFallback
  const updatedAt = messages.at(-1)?.updated_at ?? toIso(value.update_time, createdAt)
  const contentHash = createHash('sha256')
    .update(
      messages.map((message) => `${message.provider_message_id}:${message.content_hash}`).join('|')
    )
    .digest('hex')
  const chat = chatSchema.parse({
    chat_id: chatId,
    project_id: null,
    title,
    slug: slugify(title, 'chat'),
    created_at: createdAt,
    updated_at: updatedAt,
    source_provider: 'chatgpt',
    source_conversation_id: providerId,
    original_title: title,
    model_ids: [
      ...new Set(messages.map((message) => message.model).filter((model) => model !== 'unknown'))
    ],
    branch_count: countBranches(nodes.map(({ node }) => node)),
    attachment_count: messages.reduce(
      (sum, message) => sum + (message.attachments?.length ?? 0),
      0
    ),
    citation_count: messages.reduce((sum, message) => sum + (message.citations?.length ?? 0), 0),
    sync_state: 'imported',
    processing_state: 'unprocessed',
    import_origin: basename(sourcePath),
    content_hash: contentHash,
    raw_metadata: boundedMetadata(value, ['conversation_template_id', 'gizmo_id', 'is_archived'])
  })
  return { chat, messages }
}

function canonicalizeChatGptMessage(
  chatId: string,
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
    message_id: createId('msg'),
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
    branch_id: nodeId,
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
      warnings: []
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
  return { connectorId: 'generic-file', conversations, providerMemories: [], warnings }
}

function canonicalizeGenericConversation(
  value: Record<string, unknown>,
  sourcePath: string,
  index: number
): { chat: Chat; messages: Message[] } {
  const values = Array.isArray(value.messages) ? value.messages : []
  if (!values.length) throw new Error('No messages')
  const chatId = createId('chat')
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
      message_id: createId('msg'),
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
  const providerId = stringValue(value.id) ?? `${basename(sourcePath)}:${index}`
  return {
    chat: chatSchema.parse({
      chat_id: chatId,
      project_id: null,
      title,
      slug: slugify(title, 'chat'),
      created_at: messages[0]!.created_at,
      updated_at: messages.at(-1)!.updated_at,
      source_provider: stringValue(value.provider) ?? 'generic',
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
              providerUpdatedAt: nullableIso(item.updated_at ?? item.update_time)
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

function nullableIso(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const parsed = toIso(value, '')
  return parsed || null
}

function safeImportMessage(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/[\r\n]+/g, ' ').slice(0, 1000)
  return 'Unknown import failure.'
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
function countBranches(nodes: Record<string, unknown>[]): number {
  return Math.max(
    1,
    nodes.reduce(
      (sum, node) =>
        sum + Math.max(0, (Array.isArray(node.children) ? node.children.length : 0) - 1),
      1
    )
  )
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
