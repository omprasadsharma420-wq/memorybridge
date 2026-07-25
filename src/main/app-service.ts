import { app, dialog, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { basename } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { platform, release } from 'node:os'
import type {
  BootstrapState,
  ChatTurnResult,
  CreateChatInput,
  CreateProjectInput,
  DiagnosticResult,
  MemoryActionInput,
  ProcessingResult,
  ProviderMemoryActionInput,
  RetryMessageInput,
  SearchInput,
  SearchResult,
  SendMessageInput,
  UpdateChatInput,
  UpdateProjectInput,
  VaultStatus
} from '../shared/contracts'
import type {
  AppSettings,
  Chat,
  ImportRecord,
  Memory,
  MemoryEvidence,
  Message,
  Project,
  ProviderMemory,
  SettingsPatch,
  TopicSegment
} from '../shared/schemas'
import { safeErrorCategory } from '../shared/security'
import { ChatService } from './chat-service'
import { ConfigStore } from './config-store'
import { AppError } from './errors'
import { SafeLogger } from './logger'
import { MemoryEngine } from './memory/memory-engine'
import { CONNECTORS } from './ingestion/connectors'
import { ImportService, type ImportPreview } from './ingestion/import-service'
import { CredentialStore } from './providers/credential-store'
import { MockProvider } from './providers/mock-provider'
import { OpenAICompatibleProvider } from './providers/openai-compatible-provider'
import type { AIProvider } from './providers/provider'
import { RetrievalEngine } from './retrieval/retrieval-engine'
import { atomicWriteJson } from './storage/file-utils'
import { VaultRepository, type RebuildStats } from './storage/repository'
import { VaultManager } from './storage/vault'

export class AppService {
  readonly vault = new VaultManager()
  private readonly config: ConfigStore
  private readonly credentials: CredentialStore
  private readonly logger: SafeLogger
  private settings!: AppSettings
  private repository: VaultRepository | null = null
  private memoryEngine: MemoryEngine | null = null
  private chatService: ChatService | null = null
  private importService: ImportService | null = null
  private readonly pendingImports = new Map<string, string>()
  private readonly processingControllers = new Map<string, AbortController>()
  private window: BrowserWindow | null = null
  private readonly mockProvider = new MockProvider()

  constructor(userDataPath = app.getPath('userData')) {
    this.config = new ConfigStore(userDataPath)
    this.credentials = new CredentialStore(userDataPath)
    this.logger = new SafeLogger(join(userDataPath, 'logs'))
  }

  setWindow(window: BrowserWindow | null): void {
    this.window = window
  }

  async initialize(): Promise<void> {
    this.settings = await this.config.load()
    if (this.settings.lastVaultPath) {
      const registered = this.settings.registeredVaults.find(
        (item) => item.path === this.settings.lastVaultPath
      )
      if (!registered) return
      try {
        await this.vault.open(this.settings.lastVaultPath)
        if (this.vault.identity.vault_id !== registered.vault_id) {
          this.vault.disconnect()
          return
        }
        if ((await this.vault.status()).writable) await this.initializeRepository()
      } catch (error) {
        await this.logger.write({
          event: 'vault.auto_open_failed',
          category: safeErrorCategory(error)
        })
        this.vault.disconnect()
      }
    }
  }

  async bootstrap(): Promise<BootstrapState> {
    const vault = await this.vault.status()
    return {
      vault,
      settings: this.settings,
      hasStoredApiKey: await this.credentials.has(),
      projects: vault.connected && this.repository ? await this.repository.listProjects() : [],
      chats: vault.connected && this.repository ? await this.repository.listChats() : []
    }
  }

  async createVault(path: string): Promise<BootstrapState> {
    this.closeRepository()
    this.vault.disconnect()
    await this.vault.create(path)
    await this.rememberVault()
    this.settings = this.config.get()
    await this.initializeRepository()
    await this.logger.write({ event: 'vault.created' })
    return this.bootstrap()
  }

  async openVault(path: string): Promise<BootstrapState> {
    this.closeRepository()
    this.vault.disconnect()
    await this.vault.open(path)
    await this.rememberVault()
    this.settings = this.config.get()
    if ((await this.vault.status()).writable) await this.initializeRepository()
    await this.logger.write({ event: 'vault.opened' })
    return this.bootstrap()
  }

  async createProject(input: CreateProjectInput): Promise<Project> {
    return this.repo.createProject(input.name, input.description)
  }

  async updateProject(input: UpdateProjectInput): Promise<Project> {
    return this.repo.updateProject(input.projectId, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {})
    })
  }

  async createChat(input: CreateChatInput): Promise<Chat> {
    return this.repo.createChat(input.projectId)
  }

  async updateChat(input: UpdateChatInput): Promise<Chat> {
    return this.repo.updateChat(input.chatId, {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {})
    })
  }

  async listChats(): Promise<Chat[]> {
    return this.repo.listChats()
  }

  async getMessages(chatId: string): Promise<Message[]> {
    return this.repo.readMessages(chatId)
  }

  async getMessageRange(chatId: string, afterSequence: number, limit: number): Promise<Message[]> {
    return this.repo.readMessageRange(chatId, { afterSequence, limit })
  }

  async sendMessage(input: SendMessageInput): Promise<ChatTurnResult> {
    const started = Date.now()
    try {
      const result = await this.chat.sendMessage(input.chatId, input.content)
      await this.log({
        event: 'chat.turn_finished',
        category: result.assistantMessage.error_category,
        provider: result.assistantMessage.provider,
        model: result.assistantMessage.model,
        chatId: input.chatId,
        messageId: result.assistantMessage.message_id,
        durationMs: Date.now() - started
      })
      return result
    } catch (error) {
      await this.log({
        event: 'chat.turn_failed',
        category: safeErrorCategory(error),
        chatId: input.chatId,
        durationMs: Date.now() - started
      })
      throw error
    }
  }

  async retryMessage(input: RetryMessageInput): Promise<ChatTurnResult> {
    const result = await this.chat.retryMessage(input.chatId, input.userMessageId)
    await this.log({
      event: 'chat.retry_finished',
      category: result.assistantMessage.error_category,
      provider: result.assistantMessage.provider,
      model: result.assistantMessage.model,
      chatId: input.chatId,
      messageId: result.assistantMessage.message_id
    })
    return result
  }

  stopGeneration(chatId: string): void {
    this.chat.stop(chatId)
  }

  async listMemories(chatId?: string): Promise<Memory[]> {
    return this.repo.listMemories(chatId)
  }

  async memoryAction(input: MemoryActionInput): Promise<Memory[]> {
    let result: Memory[]
    if (input.action === 'edit') {
      result = await this.memory.applyAction(input.memoryId, {
        kind: 'edit',
        statement: input.statement,
        ...(input.type ? { type: input.type } : {})
      })
    } else if (input.action === 'supersede') {
      result = await this.memory.applyAction(input.memoryId, {
        kind: 'supersede',
        replacementId: input.replacementId
      })
    } else if (input.action === 'merge') {
      result = await this.memory.applyAction(input.memoryId, {
        kind: 'merge',
        targetId: input.targetId
      })
    } else if (input.action === 'set_scope') {
      if (input.scope.kind === 'project') await this.repo.getProject(input.scope.project_id)
      result = await this.memory.applyAction(input.memoryId, {
        kind: 'set_scope',
        scope: input.scope
      })
    } else if (input.action === 'resolve_conflict') {
      result = await this.memory.applyAction(input.memoryId, {
        kind: 'resolve_conflict',
        resolution: input.resolution
      })
    } else {
      result = await this.memory.applyAction(input.memoryId, { kind: input.action })
    }
    if (input.action === 'edit' || input.action === 'merge') {
      await this.memory.regenerateEmbedding(
        input.action === 'merge' ? input.targetId : input.memoryId,
        await this.getProvider(),
        this.settings
      )
      result = await this.repo.listMemories()
    }
    return result
  }

  search(input: SearchInput): SearchResult[] {
    return this.repo.search(input)
  }

  async updateSettings(patch: SettingsPatch): Promise<AppSettings> {
    this.settings = await this.config.update(patch)
    return this.settings
  }

  async saveApiKey(apiKey: string): Promise<void> {
    await this.credentials.save(apiKey)
  }

  async clearApiKey(): Promise<void> {
    await this.credentials.clear()
  }

  async testConnection(): Promise<{
    ok: boolean
    message: string
    capabilities: ReturnType<AIProvider['capabilities']>
  }> {
    const provider = await this.getProvider()
    const health = await provider.validateConfiguration()
    return { ...health, capabilities: provider.capabilities() }
  }

  async rebuildIndex(): Promise<RebuildStats> {
    return this.repo.rebuildIndex()
  }

  async rerunExtraction(chatId: string): Promise<Memory[]> {
    return (await this.reprocessChat(chatId)).memories
  }

  async reprocessSegment(topicId: string): Promise<ProcessingResult> {
    const topic = this.repo.listTopics().find((item) => item.topic_id === topicId)
    if (!topic) throw new AppError('TOPIC_NOT_FOUND', 'The selected topic no longer exists.')
    return this.processChats('segment', topicId, [await this.repo.getChat(topic.chat_id)], {
      topicId,
      force: true
    })
  }

  async reprocessChat(chatId: string): Promise<ProcessingResult> {
    return this.processChats('chat', chatId, [await this.repo.getChat(chatId)])
  }

  async reprocessProject(projectId: string): Promise<ProcessingResult> {
    await this.repo.getProject(projectId)
    const topicChatIds = new Set(
      this.repo
        .listTopics()
        .filter((topic) => topic.project_id === projectId)
        .map((topic) => topic.chat_id)
    )
    const chats = (await this.repo.listChats()).filter(
      (chat) => chat.project_id === projectId || topicChatIds.has(chat.chat_id)
    )
    return this.processChats('project', projectId, chats)
  }

  async reprocessVault(): Promise<ProcessingResult> {
    return this.processChats('vault', this.vault.identity.vault_id, await this.repo.listChats())
  }

  private async processChats(
    scope: ProcessingResult['scope'],
    scopeId: string,
    chats: Chat[],
    options: { topicId?: string; force?: boolean } = {}
  ): Promise<ProcessingResult> {
    this.processingControllers.get(scopeId)?.abort()
    const controller = new AbortController()
    this.processingControllers.set(scopeId, controller)
    const combined: ProcessingResult = {
      scope,
      chats: chats.length,
      segments: 0,
      processedSegments: 0,
      skippedSegments: 0,
      failedSegments: 0,
      memories: []
    }
    const provider = await this.getProvider()
    let completedChats = 0
    try {
      for (const chat of chats) {
        if (controller.signal.aborted) break
        await this.repo.setChatProcessingState(chat.chat_id, 'processing')
        const result = await this.memory.reprocessChat(
          chat.chat_id,
          provider,
          this.settings,
          controller.signal,
          (completedSegments, totalSegments) =>
            this.window?.webContents.send('processing:progress', {
              scope,
              scopeId,
              chatId: chat.chat_id,
              status: 'running',
              completedChats,
              totalChats: chats.length,
              completedSegments:
                combined.processedSegments + combined.skippedSegments + completedSegments,
              totalSegments: combined.segments + totalSegments
            }),
          options.topicId && chat.chat_id === chats[0]?.chat_id ? options : {}
        )
        combined.segments += result.segments
        combined.processedSegments += result.processedSegments
        combined.skippedSegments += result.skippedSegments
        combined.failedSegments += result.failedSegments
        combined.memories.push(...result.memories)
        completedChats += 1
        await this.repo.setChatProcessingState(
          chat.chat_id,
          controller.signal.aborted
            ? 'cancelled'
            : result.failedSegments > 0
              ? 'needs_review'
              : 'processed'
        )
      }
      const cancelled = controller.signal.aborted
      this.window?.webContents.send('processing:progress', {
        scope,
        scopeId,
        chatId: null,
        status: cancelled ? 'cancelled' : combined.failedSegments ? 'failed' : 'complete',
        completedChats,
        totalChats: chats.length,
        completedSegments: combined.processedSegments + combined.skippedSegments,
        totalSegments: combined.segments
      })
      return combined
    } catch (error) {
      for (const chat of chats.slice(completedChats)) {
        await this.repo.setChatProcessingState(chat.chat_id, 'failed')
      }
      this.window?.webContents.send('processing:progress', {
        scope,
        scopeId,
        chatId: null,
        status: 'failed',
        completedChats,
        totalChats: chats.length,
        completedSegments: combined.processedSegments + combined.skippedSegments,
        totalSegments: combined.segments
      })
      throw error
    } finally {
      if (this.processingControllers.get(scopeId) === controller)
        this.processingControllers.delete(scopeId)
    }
  }

  cancelReprocessing(scopeId: string): void {
    this.processingControllers.get(scopeId)?.abort()
  }

  async providerMemoryAction(input: ProviderMemoryActionInput): Promise<ProviderMemory[]> {
    const memory = await this.repo.getProviderMemory(input.providerMemoryId)
    if (input.action === 'confirm') {
      memory.state = 'active'
      memory.user_confirmed = true
    } else if (input.action === 'edit') {
      memory.statement = input.statement
      memory.content_hash = createHash('sha256').update(input.statement).digest('hex')
      memory.state = 'active'
      memory.user_confirmed = true
    } else if (input.action === 'reject') {
      memory.state = 'rejected'
      memory.user_confirmed = false
    } else if (input.action === 'delete') {
      memory.state = 'deleted'
      memory.user_confirmed = false
    } else {
      const replacement = await this.repo.getProviderMemory(input.replacementId)
      if (!sameProviderScope(memory, replacement)) {
        throw new AppError(
          'PROVIDER_MEMORY_SCOPE_MISMATCH',
          'Provider memories can only supersede records in the same scope.'
        )
      }
      memory.state = 'superseded'
      memory.superseded_by = replacement.provider_memory_id
      replacement.state = replacement.user_confirmed ? 'active' : 'needs_review'
      await this.repo.saveProviderMemory(replacement)
    }
    await this.repo.saveProviderMemory(memory)
    return this.repo.listProviderMemories()
  }

  listConnectors(): Array<{
    id: string
    name: string
    description: string
    capabilities: Record<string, boolean>
  }> {
    return CONNECTORS.map((connector) => ({
      ...connector,
      capabilities: { ...connector.capabilities }
    }))
  }

  async chooseImport(): Promise<
    (Omit<ImportPreview, 'sourcePath'> & { token: string; fileName: string }) | null
  > {
    const selection = await dialog.showOpenDialog({
      title: 'Choose a conversation export',
      properties: ['openFile'],
      filters: [
        {
          name: 'Conversation exports',
          extensions: ['zip', 'json', 'jsonl', 'md', 'markdown', 'txt']
        }
      ]
    })
    const sourcePath = selection.filePaths[0]
    if (selection.canceled || !sourcePath) return null
    const preview = await this.ingestion.preview(sourcePath)
    const token = randomUUID()
    this.pendingImports.set(token, sourcePath)
    return {
      token,
      fileName: basename(sourcePath),
      connectorId: preview.connectorId,
      conversations: preview.conversations,
      messages: preview.messages,
      providerMemories: preview.providerMemories,
      warnings: preview.warnings
    }
  }

  async executeImport(token: string): Promise<ImportRecord> {
    const sourcePath = this.pendingImports.get(token)
    if (!sourcePath) throw new AppError('IMPORT_TOKEN_INVALID', 'Choose the import file again.')
    this.pendingImports.delete(token)
    return this.ingestion.import(sourcePath)
  }

  async scanImportInbox(): Promise<ImportRecord[]> {
    return this.ingestion.scanInbox()
  }

  listTopics(chatId?: string): TopicSegment[] {
    return this.repo.listTopics(chatId)
  }

  listEvidence(memoryId?: string): MemoryEvidence[] {
    return this.repo.listEvidence(memoryId)
  }

  listProviderMemories(): ProviderMemory[] {
    return this.repo.listProviderMemories()
  }

  getMcpConfiguration(): {
    command: string
    args: string[]
    env: Record<string, string>
    transport: 'stdio'
  } {
    return {
      command: process.execPath,
      args: [join(app.getAppPath(), 'out', 'main', 'mcp-server.js'), '--vault', this.vault.root],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      transport: 'stdio'
    }
  }

  async exportDiagnostics(): Promise<DiagnosticResult> {
    const result = await dialog.showSaveDialog({
      title: 'Export MemoryBridge diagnostics',
      defaultPath: `memorybridge-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath)
      throw new AppError('EXPORT_CANCELLED', 'Diagnostic export was cancelled.')
    const vaultStatus = await this.vault.status()
    await atomicWriteJson(result.filePath, {
      application: 'MemoryBridge',
      applicationVersion: app.getVersion(),
      exportedAt: new Date().toISOString(),
      platform: platform(),
      osRelease: release(),
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      provider: this.settings.provider,
      models: {
        chat: this.settings.chatModel,
        extraction: this.settings.extractionModel,
        embedding: this.settings.embeddingModel
      },
      memoryExtractionEnabled: this.settings.memoryExtractionEnabled,
      semanticIndexingEnabled: this.settings.semanticIndexingEnabled,
      vault: {
        connected: vaultStatus.connected,
        writable: vaultStatus.writable,
        vaultId: vaultStatus.manifest?.vault_id ?? null,
        schemaVersion: vaultStatus.manifest?.schema_version ?? null
      },
      hasStoredApiKey: await this.credentials.has(),
      recentSafeEvents: await this.logger.recent(50),
      excludes: [
        'transcripts',
        'message content',
        'memory statements',
        'credentials',
        'vault paths'
      ]
    })
    return { path: result.filePath }
  }

  async pollVaultStatus(): Promise<VaultStatus> {
    const status = await this.vault.status()
    this.window?.webContents.send('vault:status', status)
    return status
  }

  close(): void {
    this.closeRepository()
    this.vault.disconnect()
  }

  private async initializeRepository(): Promise<void> {
    this.repository = new VaultRepository(this.vault)
    await this.repository.initialize()
    this.memoryEngine = new MemoryEngine(this.repository)
    this.importService = new ImportService(this.vault, this.repository)
    const retrieval = new RetrievalEngine(this.repository)
    this.chatService = new ChatService(
      this.repository,
      this.memoryEngine,
      retrieval,
      () => this.settings,
      () => this.getProvider(),
      (message) => this.window?.webContents.send('chat:stream', message)
    )
  }

  private async rememberVault(): Promise<void> {
    const now = new Date().toISOString()
    const registeredVaults = this.settings.registeredVaults.filter(
      (item) => item.vault_id !== this.vault.identity.vault_id
    )
    registeredVaults.push({
      vault_id: this.vault.identity.vault_id,
      path: this.vault.root,
      registered_at: now,
      last_opened_at: now
    })
    this.settings = await this.config.update({
      lastVaultPath: this.vault.root,
      registeredVaults
    })
  }

  private closeRepository(): void {
    this.repository?.close()
    this.repository = null
    this.memoryEngine = null
    this.chatService = null
    this.importService = null
    this.pendingImports.clear()
    for (const controller of this.processingControllers.values()) controller.abort()
    this.processingControllers.clear()
  }

  private async getProvider(): Promise<AIProvider> {
    if (this.settings.mockMode || this.settings.provider === 'mock') return this.mockProvider
    const apiKey = await this.credentials.load()
    if (!apiKey) throw new AppError('API_KEY_MISSING', 'Enter an API key or enable mock mode.')
    return new OpenAICompatibleProvider({
      apiBaseUrl: this.settings.apiBaseUrl,
      apiKey,
      timeoutMs: this.settings.requestTimeoutMs,
      maxRetries: this.settings.maxRetries
    })
  }

  private async log(event: Parameters<SafeLogger['write']>[0]): Promise<void> {
    try {
      await this.logger.write(event)
    } catch {
      // Logging is deliberately non-blocking and contains no conversation content.
    }
  }

  private get repo(): VaultRepository {
    if (!this.repository)
      throw new AppError('VAULT_DISCONNECTED', 'Connect a vault to continue.', true)
    return this.repository
  }

  private get memory(): MemoryEngine {
    if (!this.memoryEngine)
      throw new AppError('VAULT_DISCONNECTED', 'Connect a vault to continue.', true)
    return this.memoryEngine
  }

  private get chat(): ChatService {
    if (!this.chatService)
      throw new AppError('VAULT_DISCONNECTED', 'Connect a vault to continue.', true)
    return this.chatService
  }

  private get ingestion(): ImportService {
    if (!this.importService)
      throw new AppError('VAULT_DISCONNECTED', 'Connect a writable vault to import.', true)
    return this.importService
  }
}

function sameProviderScope(left: ProviderMemory, right: ProviderMemory): boolean {
  if (left.scope.kind !== right.scope.kind) return false
  if (left.scope.kind === 'global' && right.scope.kind === 'global') return true
  if (left.scope.kind === 'project' && right.scope.kind === 'project')
    return left.scope.project_id === right.scope.project_id
  if (left.scope.kind === 'conversation' && right.scope.kind === 'conversation')
    return left.scope.chat_id === right.scope.chat_id
  return false
}
