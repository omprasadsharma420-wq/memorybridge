import { readdir, rename } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { createId } from '../../shared/ids'
import {
  chatSchema,
  extractionRunSchema,
  memorySchema,
  messageSchema,
  projectSchema,
  type Chat,
  type ExtractionRun,
  type Memory,
  type Message,
  type Project
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
    }
    const stats = await this.rebuildIndex()
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
      ...(patch.projectId !== undefined ? { project_id: patch.projectId } : {}),
      updated_at: new Date().toISOString()
    })
    await atomicWriteJson(join(this.getChatDirectory(chatId), 'metadata.json'), updated)
    this.db.upsertChat(updated)
    const memories = await this.listMemories(chatId)
    if (patch.projectId !== undefined && memories.length > 0) {
      const reassigned = memories.map((memory) => ({
        ...memory,
        project_id: patch.projectId ?? null,
        updated_at: new Date().toISOString()
      }))
      await this.replaceChatMemories(chatId, reassigned)
    }
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

  async readMessages(chatId: string): Promise<Message[]> {
    const transcript = join(this.getChatDirectory(chatId), 'transcript.jsonl')
    const { values } = await readJsonLines(transcript, messageSchema)
    const latest = new Map<string, Message>()
    for (const snapshot of values) latest.set(snapshot.message_id, snapshot)
    return [...latest.values()].sort(
      (a, b) => a.sequence - b.sequence || a.created_at.localeCompare(b.created_at)
    )
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
    const validated = memories.map((memory) => memorySchema.parse(memory))
    await atomicWriteJson(join(this.getChatDirectory(chatId), 'memories.json'), {
      schema_version: 1,
      memories: validated
    })
    for (const memory of validated) this.db.upsertMemory(memory)
    await this.updateProjectMemoryFiles()
  }

  async saveExtractionRun(run: ExtractionRun): Promise<void> {
    const validated = extractionRunSchema.parse(run)
    await appendJsonLine(join(this.getChatDirectory(run.chat_id), 'extractions.jsonl'), validated)
    this.db.upsertExtractionRun(validated)
  }

  search(input: SearchInput): SearchResult[] {
    return this.db.search(input)
  }

  listActiveMemories(projectId?: string | null): Memory[] {
    return this.db.listActiveMemories(projectId)
  }

  storeEmbedding(memoryId: string, model: string, vector: number[]): void {
    this.db.storeEmbedding(memoryId, model, vector)
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
    return {
      projects: projects.length,
      chats: chats.length,
      messages: messageCount,
      memories: memoryCount
    }
  }

  async recoverInterruptedMessages(): Promise<number> {
    let count = 0
    for (const chat of await this.listChats()) {
      for (const message of await this.readMessages(chat.chat_id)) {
        if (message.role === 'assistant' && ['pending', 'streaming'].includes(message.status)) {
          await this.appendMessage({
            ...message,
            status: 'interrupted',
            updated_at: new Date().toISOString(),
            error_category: 'application-restart'
          })
          count += 1
        }
      }
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

  private async updateProjectMemoryFiles(): Promise<void> {
    const all = await this.listMemories()
    for (const project of await this.listProjects()) {
      const memoryIds = all
        .filter((memory) => memory.project_id === project.project_id && memory.state !== 'deleted')
        .map((memory) => memory.memory_id)
      await atomicWriteJson(
        join(this.getProjectDirectory(project.project_id), 'project-memory.json'),
        {
          schema_version: 1,
          memory_ids: memoryIds
        }
      )
    }
  }

  describeChatDirectory(chatId: string): string {
    return basename(this.getChatDirectory(chatId))
  }

  private get db(): IndexDatabase {
    if (!this.index) throw new Error('Vault repository has not been initialized.')
    return this.index
  }
}
