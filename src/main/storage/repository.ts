import { readdir, rename } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { createId } from '../../shared/ids'
import {
  chatSchema,
  extractionRunSchema,
  memoryEvidenceSchema,
  memorySchema,
  messageSchema,
  topicSegmentSchema,
  importRecordSchema,
  providerMemorySchema,
  processingCheckpointSchema,
  projectSchema,
  type Chat,
  type ExtractionRun,
  type Memory,
  type Message,
  type Project,
  type MemoryEvidence,
  type TopicSegment,
  type ImportRecord,
  type ProviderMemory,
  type ProcessingCheckpoint
} from '../../shared/schemas'
import type { SearchInput, SearchResult } from '../../shared/contracts'
import { slugify } from '../../shared/text'
import { AppError } from '../errors'
import {
  appendJsonLine,
  atomicWriteJson,
  ensureDirectory,
  pathExists,
  readJsonLines,
  readValidatedJson
} from './file-utils'
import { IndexDatabase } from './index-database'
import { VaultManager } from './vault'

const memoryFileSchema = z.object({ schema_version: z.literal(1), memories: z.array(memorySchema) })
const transcriptPatchSchema = z.object({
  kind: z.literal('message_patch'),
  message_id: z.string(),
  content_delta: z.string().default(''),
  status: z.enum(['pending', 'streaming', 'complete', 'interrupted', 'failed', 'cancelled']),
  updated_at: z.string().datetime({ offset: true }),
  error_category: z.string().max(120).optional()
})
const transcriptRecordSchema = z.union([messageSchema, transcriptPatchSchema])

export interface RebuildStats {
  projects: number
  chats: number
  messages: number
  memories: number
}

export class VaultRepository {
  private index: IndexDatabase | null = null
  private readonly chatDirectories = new Map<string, string>()
  private readonly projectDirectories = new Map<string, string>()

  constructor(private readonly vault: VaultManager) {}

  async initialize(): Promise<RebuildStats> {
    await this.vault.assertConnected()
    this.index?.close()
    const indexPath = this.vault.path('indexes', 'memorybridge.sqlite')
    let rebuildRequired = !(await pathExists(indexPath))
    this.index = new IndexDatabase(indexPath)
    try {
      await this.index.open()
    } catch {
      this.index.close()
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      for (const suffix of ['', '-journal', '-wal', '-shm']) {
        const source = `${indexPath}${suffix}`
        if (await pathExists(source)) {
          await rename(
            source,
            this.vault.path('backups', `memorybridge.sqlite.corrupt-${stamp}${suffix}`)
          )
        }
      }
      this.index = new IndexDatabase(indexPath)
      await this.index.open()
      rebuildRequired = true
    }
    if (this.db.getVaultId() !== this.vault.identity.vault_id) rebuildRequired = true
    if (this.db.requiresContentRebuild()) rebuildRequired = true
    const stats = rebuildRequired
      ? await this.rebuildIndex()
      : { projects: 0, chats: 0, messages: 0, memories: 0 }
    this.db.setVaultId(this.vault.identity.vault_id)
    await this.recoverInterruptedMessages()
    return stats
  }

  close(): void {
    this.index?.close()
    this.index = null
  }

  async createProject(name: string, description = ''): Promise<Project> {
    await this.vault.assertConnected()
    const now = new Date().toISOString()
    const project = projectSchema.parse({
      project_id: createId('project'),
      name,
      description,
      slug: slugify(name, 'project'),
      created_at: now,
      updated_at: now
    })
    const directory = this.vault.path('projects', `${project.project_id}--${project.slug}`)
    await ensureDirectory(directory)
    await atomicWriteJson(join(directory, 'project.json'), project)
    await atomicWriteJson(join(directory, 'project-memory.json'), {
      schema_version: 1,
      memory_ids: []
    })
    this.projectDirectories.set(project.project_id, directory)
    this.db.upsertProject(project)
    return project
  }

  async updateProject(
    projectId: string,
    patch: { name?: string; description?: string }
  ): Promise<Project> {
    const project = await this.getProject(projectId)
    const updated = projectSchema.parse({
      ...project,
      ...patch,
      updated_at: new Date().toISOString()
    })
    await atomicWriteJson(join(this.getProjectDirectory(projectId), 'project.json'), updated)
    this.db.upsertProject(updated)
    return updated
  }

  async listProjects(): Promise<Project[]> {
    await this.discoverProjects()
    const projects: Project[] = []
    for (const directory of this.projectDirectories.values()) {
      projects.push(await readValidatedJson(join(directory, 'project.json'), projectSchema))
    }
    return projects.sort((a, b) => a.name.localeCompare(b.name))
  }

  async getProject(projectId: string): Promise<Project> {
    await this.discoverProjects()
    return readValidatedJson(
      join(this.getProjectDirectory(projectId), 'project.json'),
      projectSchema
    )
  }

  async createChat(projectId: string | null = null): Promise<Chat> {
    await this.vault.assertConnected()
    if (projectId) await this.getProject(projectId)
    const now = new Date().toISOString()
    const chat = chatSchema.parse({
      chat_id: createId('chat'),
      project_id: projectId,
      title: 'New chat',
      slug: 'new-chat',
      created_at: now,
      updated_at: now
    })
    const directory = this.vault.path('chats', `${chat.chat_id}--${chat.slug}`)
    await ensureDirectory(directory)
    await atomicWriteJson(join(directory, 'metadata.json'), chat)
    await atomicWriteJson(join(directory, 'memories.json'), { schema_version: 1, memories: [] })
    await appendJsonLine(join(directory, 'extractions.jsonl'), {
      kind: 'metadata',
      schema_version: 1,
      created_at: now
    })
    this.chatDirectories.set(chat.chat_id, directory)
    this.db.upsertChat(chat)
    return chat
  }

  async updateChat(
    chatId: string,
    patch: { title?: string; projectId?: string | null }
  ): Promise<Chat> {
    const chat = await this.getChat(chatId)
    if (patch.projectId) await this.getProject(patch.projectId)
    const updated = chatSchema.parse({
      ...chat,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.title !== undefined ? { slug: slugify(patch.title, 'chat') } : {}),
      ...(patch.projectId !== undefined ? { project_id: patch.projectId } : {}),
      updated_at: new Date().toISOString()
    })
    let directory = this.getChatDirectory(chatId)
    await atomicWriteJson(join(directory, 'metadata.json'), updated)
    if (updated.slug !== chat.slug) {
      const readableDirectory = this.vault.path('chats', `${updated.chat_id}--${updated.slug}`)
      if (!(await pathExists(readableDirectory))) {
        await rename(directory, readableDirectory)
        directory = readableDirectory
        this.chatDirectories.set(chatId, directory)
      }
    }
    this.db.upsertChat(updated)
    const memories = await this.listMemories(chatId)
    if (patch.projectId !== undefined && memories.length > 0) {
      const reassigned = memories.map((memory) => ({
        ...memory,
        project_id: patch.projectId ?? null,
        scope: patch.projectId
          ? ({ kind: 'project', project_id: patch.projectId } as const)
          : ({ kind: 'conversation', chat_id: chatId } as const),
        updated_at: new Date().toISOString()
      }))
      await this.replaceChatMemories(chatId, reassigned)
    }
    return updated
  }

  async setChatProcessingState(
    chatId: string,
    processingState: Chat['processing_state']
  ): Promise<Chat> {
    const chat = await this.getChat(chatId)
    const updated = chatSchema.parse({
      ...chat,
      processing_state: processingState,
      updated_at: new Date().toISOString()
    })
    await atomicWriteJson(join(this.getChatDirectory(chatId), 'metadata.json'), updated)
    this.db.upsertChat(updated)
    return updated
  }

  async listChats(): Promise<Chat[]> {
    await this.discoverChats()
    const chats: Chat[] = []
    for (const directory of this.chatDirectories.values()) {
      chats.push(await readValidatedJson(join(directory, 'metadata.json'), chatSchema))
    }
    return chats.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  }

  async getChat(chatId: string): Promise<Chat> {
    await this.discoverChats()
    return readValidatedJson(join(this.getChatDirectory(chatId), 'metadata.json'), chatSchema)
  }

  async appendMessage(message: Message): Promise<Message> {
    await this.vault.assertConnected()
    const validated = messageSchema.parse(message)
    const transcript = join(this.getChatDirectory(message.chat_id), 'transcript.jsonl')
    await appendJsonLine(transcript, validated)
    this.db.upsertMessage(validated)
    return validated
  }

  async appendMessagePatch(message: Message, contentDelta = ''): Promise<Message> {
    await this.vault.assertConnected()
    const validated = messageSchema.parse(message)
    await appendJsonLine(join(this.getChatDirectory(message.chat_id), 'transcript.jsonl'), {
      kind: 'message_patch',
      message_id: message.message_id,
      content_delta: contentDelta,
      status: message.status,
      updated_at: message.updated_at,
      ...(message.error_category ? { error_category: message.error_category } : {})
    })
    this.db.upsertMessage(validated)
    return validated
  }

  async readMessages(chatId: string): Promise<Message[]> {
    const transcript = join(this.getChatDirectory(chatId), 'transcript.jsonl')
    const { values } = await readJsonLines(transcript, transcriptRecordSchema)
    const latest = new Map<string, Message>()
    for (const record of values) {
      if ('kind' in record) {
        const previous = latest.get(record.message_id)
        if (!previous) continue
        latest.set(record.message_id, {
          ...previous,
          content: previous.content + record.content_delta,
          status: record.status,
          updated_at: record.updated_at,
          ...(record.error_category ? { error_category: record.error_category } : {})
        })
      } else {
        latest.set(record.message_id, record)
      }
    }
    return [...latest.values()].sort(
      (a, b) => a.sequence - b.sequence || a.created_at.localeCompare(b.created_at)
    )
  }

  async readMessageRange(
    chatId: string,
    options: { afterSequence?: number; limit?: number } = {}
  ): Promise<Message[]> {
    await this.getChat(chatId)
    return this.db.listMessageRange(chatId, options.afterSequence ?? -1, options.limit ?? 200)
  }

  async nextSequence(chatId: string): Promise<number> {
    const messages = await this.readMessages(chatId)
    return messages.length ? Math.max(...messages.map((message) => message.sequence)) + 1 : 0
  }

  async listMemories(chatId?: string): Promise<Memory[]> {
    await this.discoverChats()
    const directories = chatId
      ? [this.getChatDirectory(chatId)]
      : [...this.chatDirectories.values()]
    const memories: Memory[] = []
    for (const directory of directories) {
      const path = join(directory, 'memories.json')
      if (!(await pathExists(path))) continue
      memories.push(...(await readValidatedJson(path, memoryFileSchema)).memories)
    }
    return memories.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  }

  async replaceChatMemories(chatId: string, memories: Memory[]): Promise<void> {
    const previous = await this.listMemories(chatId)
    const validated = memories.map((memory) => memorySchema.parse(memory))
    await atomicWriteJson(join(this.getChatDirectory(chatId), 'memories.json'), {
      schema_version: 1,
      memories: validated
    })
    this.db.removeMissingChatMemories(
      chatId,
      validated.map((memory) => memory.memory_id)
    )
    for (const memory of validated) this.db.upsertMemory(memory)
    const projectIds = new Set(
      [...previous, ...validated]
        .map((memory) => memory.project_id)
        .filter((projectId): projectId is string => Boolean(projectId))
    )
    for (const projectId of projectIds) await this.updateProjectMemoryFile(projectId)
  }

  async saveEvidence(records: MemoryEvidence[]): Promise<void> {
    const messagesByChat = new Map<string, Set<string>>()
    for (const chatId of new Set(records.map((record) => record.chat_id))) {
      messagesByChat.set(
        chatId,
        new Set((await this.readMessages(chatId)).map((message) => message.message_id))
      )
    }
    const memoryIds = new Set((await this.listMemories()).map((memory) => memory.memory_id))
    for (const record of records) {
      const validated = memoryEvidenceSchema.parse(record)
      if (!memoryIds.has(validated.memory_id)) {
        throw new AppError('EVIDENCE_MEMORY_MISSING', 'Evidence must reference an existing memory.')
      }
      if (!messagesByChat.get(validated.chat_id)?.has(validated.message_id)) {
        throw new AppError(
          'EVIDENCE_MESSAGE_MISSING',
          'Evidence must reference an existing message in the expected conversation.'
        )
      }
      await appendJsonLine(this.vault.path('evidence', `${validated.memory_id}.jsonl`), validated)
      this.db.upsertEvidence(validated)
    }
  }

  listEvidence(memoryId?: string): MemoryEvidence[] {
    return this.db.listEvidence(memoryId)
  }

  async replaceTopics(chatId: string, topics: TopicSegment[]): Promise<void> {
    const validated = topics.map((topic) => topicSegmentSchema.parse(topic))
    await atomicWriteJson(this.vault.path('topics', `${chatId}.json`), {
      schema_version: 1,
      topics: validated
    })
    this.db.deleteTopicsForChat(chatId)
    for (const topic of validated) this.db.upsertTopic(topic)
  }

  listTopics(chatId?: string): TopicSegment[] {
    return this.db.listTopics(chatId)
  }

  async saveImportRecord(record: ImportRecord): Promise<void> {
    const validated = importRecordSchema.parse(record)
    await atomicWriteJson(
      this.vault.path('import-records', `${validated.import_id}.json`),
      validated
    )
    this.db.upsertImportRecord(validated)
  }

  findImportByHash(hash: string): ImportRecord | null {
    return this.db.findImportByHash(hash)
  }

  async saveProviderMemory(memory: ProviderMemory): Promise<void> {
    const validated = providerMemorySchema.parse(memory)
    await atomicWriteJson(
      this.vault.path('provider-memories', `${validated.provider_memory_id}.json`),
      validated
    )
    this.db.upsertProviderMemory(validated)
  }

  listProviderMemories(): ProviderMemory[] {
    return this.db.listProviderMemories()
  }

  async getProviderMemory(providerMemoryId: string): Promise<ProviderMemory> {
    const memory = this.listProviderMemories().find(
      (item) => item.provider_memory_id === providerMemoryId
    )
    if (!memory)
      throw new AppError('PROVIDER_MEMORY_NOT_FOUND', 'The provider memory no longer exists.')
    return memory
  }

  async loadProcessingCheckpoint(chatId: string): Promise<ProcessingCheckpoint> {
    await this.getChat(chatId)
    const path = this.vault.path('processing', `${chatId}.json`)
    if (await pathExists(path)) return readValidatedJson(path, processingCheckpointSchema)
    return processingCheckpointSchema.parse({
      schema_version: 1,
      chat_id: chatId,
      segments: {},
      updated_at: new Date().toISOString()
    })
  }

  async saveProcessingCheckpoint(checkpoint: ProcessingCheckpoint): Promise<void> {
    const validated = processingCheckpointSchema.parse(checkpoint)
    await atomicWriteJson(this.vault.path('processing', `${validated.chat_id}.json`), validated)
  }

  invalidateEmbedding(memoryId: string): void {
    this.db.invalidateEmbedding(memoryId)
  }

  async upsertCanonicalConversation(
    conversation: Chat,
    messages: Message[]
  ): Promise<'imported' | 'changed' | 'unchanged'> {
    await this.vault.assertConnected()
    const parsedChat = chatSchema.parse(conversation)
    const existing = (await this.listChats()).find(
      (chat) =>
        chat.source_provider === parsedChat.source_provider &&
        chat.source_conversation_id === parsedChat.source_conversation_id
    )
    if (existing?.content_hash && existing.content_hash === parsedChat.content_hash)
      return 'unchanged'
    const target = existing
      ? chatSchema.parse({ ...parsedChat, chat_id: existing.chat_id })
      : parsedChat
    let directory: string
    if (existing) {
      directory = this.getChatDirectory(existing.chat_id)
    } else {
      directory = this.vault.path('chats', `${target.chat_id}--${target.slug}`)
      await ensureDirectory(directory)
      await atomicWriteJson(join(directory, 'memories.json'), { schema_version: 1, memories: [] })
      await appendJsonLine(join(directory, 'extractions.jsonl'), {
        kind: 'metadata',
        schema_version: 1,
        created_at: target.created_at
      })
      this.chatDirectories.set(target.chat_id, directory)
    }
    await atomicWriteJson(join(directory, 'metadata.json'), target)
    this.db.upsertChat(target)
    const prior = new Map(
      (existing ? await this.readMessages(existing.chat_id) : []).map((message) => [
        message.provider_message_id ?? message.message_id,
        message
      ])
    )
    for (const incoming of messages) {
      const key = incoming.provider_message_id ?? incoming.message_id
      const previous = prior.get(key)
      const message = messageSchema.parse({
        ...incoming,
        chat_id: target.chat_id,
        ...(previous ? { message_id: previous.message_id, sequence: previous.sequence } : {})
      })
      const fingerprint = message.content_hash ?? message.content
      if ((previous?.content_hash ?? previous?.content) === fingerprint) continue
      await this.appendMessage(message)
    }
    return existing ? 'changed' : 'imported'
  }

  async saveExtractionRun(run: ExtractionRun): Promise<void> {
    const validated = extractionRunSchema.parse(run)
    await appendJsonLine(join(this.getChatDirectory(run.chat_id), 'extractions.jsonl'), validated)
    this.db.upsertExtractionRun(validated)
  }

  search(input: SearchInput): SearchResult[] {
    return this.db.search(input)
  }

  listActiveMemories(
    projectId: string | null,
    chatId?: string | null,
    includeConversation = true
  ): Memory[] {
    return this.db.listActiveMemories(projectId, chatId, includeConversation)
  }

  storeEmbedding(memoryId: string, model: string, vector: number[], contentHash: string): void {
    this.db.storeEmbedding(memoryId, model, vector, contentHash)
  }

  getEmbeddings(model: string): Array<{ memoryId: string; vector: number[] }> {
    return this.db.getEmbeddings(model)
  }

  async rebuildIndex(): Promise<RebuildStats> {
    await this.vault.assertConnected()
    await this.discoverProjects(true)
    await this.discoverChats(true)
    this.db.clearContent()
    const projects = await this.listProjects()
    for (const project of projects) this.db.upsertProject(project)
    const chats = await this.listChats()
    let messageCount = 0
    let memoryCount = 0
    for (const chat of chats) {
      this.db.upsertChat(chat)
      const messages = await this.readMessages(chat.chat_id)
      messageCount += messages.length
      for (const message of messages) this.db.upsertMessage(message)
      const memories = await this.listMemories(chat.chat_id)
      memoryCount += memories.length
      for (const memory of memories) this.db.upsertMemory(memory)
      const extractionPath = join(this.getChatDirectory(chat.chat_id), 'extractions.jsonl')
      const extractionRuns = await readJsonLines(extractionPath, extractionRunSchema)
      for (const run of extractionRuns.values) this.db.upsertExtractionRun(run)
    }
    for (const entry of await readdir(this.vault.path('evidence'), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      const records = await readJsonLines(
        this.vault.path('evidence', entry.name),
        memoryEvidenceSchema
      )
      for (const record of records.values) this.db.upsertEvidence(record)
    }
    for (const entry of await readdir(this.vault.path('topics'), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const topicFileSchema = z.object({
        schema_version: z.literal(1),
        topics: z.array(topicSegmentSchema)
      })
      const file = await readValidatedJson(this.vault.path('topics', entry.name), topicFileSchema)
      for (const topic of file.topics) this.db.upsertTopic(topic)
    }
    for (const entry of await readdir(this.vault.path('import-records'), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      this.db.upsertImportRecord(
        await readValidatedJson(this.vault.path('import-records', entry.name), importRecordSchema)
      )
    }
    for (const entry of await readdir(this.vault.path('provider-memories'), {
      withFileTypes: true
    })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      this.db.upsertProviderMemory(
        await readValidatedJson(
          this.vault.path('provider-memories', entry.name),
          providerMemorySchema
        )
      )
    }
    return {
      projects: projects.length,
      chats: chats.length,
      messages: messageCount,
      memories: memoryCount
    }
  }

  async recoverInterruptedMessages(): Promise<number> {
    let count = 0
    for (const message of this.db.listNonterminalMessages()) {
      await this.appendMessagePatch({
        ...message,
        status: 'interrupted',
        updated_at: new Date().toISOString(),
        error_category: 'application-restart'
      })
      count += 1
    }
    return count
  }

  private async discoverProjects(refresh = false): Promise<void> {
    if (this.projectDirectories.size > 0 && !refresh) return
    this.projectDirectories.clear()
    const root = this.vault.path('projects')
    await ensureDirectory(root)
    const entries = await readdir(root, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('project_')) continue
      const directory = join(root, entry.name)
      const metadata = join(directory, 'project.json')
      if (!(await pathExists(metadata))) continue
      const project = await readValidatedJson(metadata, projectSchema)
      this.projectDirectories.set(project.project_id, directory)
    }
  }

  private async discoverChats(refresh = false): Promise<void> {
    if (this.chatDirectories.size > 0 && !refresh) return
    this.chatDirectories.clear()
    const root = this.vault.path('chats')
    await ensureDirectory(root)
    const entries = await readdir(root, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('chat_')) continue
      const directory = join(root, entry.name)
      const metadata = join(directory, 'metadata.json')
      if (!(await pathExists(metadata))) continue
      const chat = await readValidatedJson(metadata, chatSchema)
      this.chatDirectories.set(chat.chat_id, directory)
    }
  }

  private getChatDirectory(chatId: string): string {
    const directory = this.chatDirectories.get(chatId)
    if (!directory) throw new AppError('CHAT_NOT_FOUND', `Chat ${chatId} does not exist.`)
    return directory
  }

  private getProjectDirectory(projectId: string): string {
    const directory = this.projectDirectories.get(projectId)
    if (!directory) throw new AppError('PROJECT_NOT_FOUND', `Project ${projectId} does not exist.`)
    return directory
  }

  private async updateProjectMemoryFile(projectId: string): Promise<void> {
    const memoryIds = this.db.listProjectMemoryIds(projectId)
    await atomicWriteJson(join(this.getProjectDirectory(projectId), 'project-memory.json'), {
      schema_version: 1,
      memory_ids: memoryIds
    })
  }

  describeChatDirectory(chatId: string): string {
    return basename(this.getChatDirectory(chatId))
  }

  private get db(): IndexDatabase {
    if (!this.index) throw new Error('Vault repository has not been initialized.')
    return this.index
  }
}
