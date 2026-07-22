import { app, dialog, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { platform, release } from 'node:os'
import type {
  BootstrapState,
  ChatTurnResult,
  CreateChatInput,
  CreateProjectInput,
  DiagnosticResult,
  MemoryActionInput,
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
    if (input.action === 'edit') {
      return this.memory.applyAction(input.memoryId, {
        kind: 'edit',
        statement: input.statement,
        ...(input.type ? { type: input.type } : {})
      })
    }
    if (input.action === 'supersede') {
      return this.memory.applyAction(input.memoryId, {
        kind: 'supersede',
        replacementId: input.replacementId
      })
    }
    if (input.action === 'merge') {
      return this.memory.applyAction(input.memoryId, { kind: 'merge', targetId: input.targetId })
    }
    if (input.action === 'set_scope') {
      if (input.scope.kind === 'project') await this.repo.getProject(input.scope.project_id)
      return this.memory.applyAction(input.memoryId, { kind: 'set_scope', scope: input.scope })
    }
    return this.memory.applyAction(input.memoryId, { kind: input.action })
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

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    const provider = await this.getProvider()
    return provider.validateConfiguration()
  }

  async rebuildIndex(): Promise<RebuildStats> {
    return this.repo.rebuildIndex()
  }

  async rerunExtraction(chatId: string): Promise<Memory[]> {
    return (await this.reprocessChat(chatId)).memories
  }

  async reprocessChat(chatId: string): Promise<{
    segments: number
    processedSegments: number
    skippedSegments: number
    memories: Memory[]
  }> {
    this.processingControllers.get(chatId)?.abort()
    const controller = new AbortController()
    this.processingControllers.set(chatId, controller)
    await this.repo.setChatProcessingState(chatId, 'processing')
    try {
      const result = await this.memory.reprocessChat(
        chatId,
        await this.getProvider(),
        this.settings,
        controller.signal,
        (completedSegments, totalSegments) =>
          this.window?.webContents.send('processing:progress', {
            chatId,
            status: 'running',
            completedSegments,
            totalSegments
          })
      )
      const cancelled = controller.signal.aborted
      await this.repo.setChatProcessingState(chatId, cancelled ? 'cancelled' : 'processed')
      this.window?.webContents.send('processing:progress', {
        chatId,
        status: cancelled ? 'cancelled' : 'complete',
        completedSegments: result.processedSegments + result.skippedSegments,
        totalSegments: result.segments
      })
      return result
    } catch (error) {
      await this.repo.setChatProcessingState(chatId, 'failed')
      this.window?.webContents.send('processing:progress', {
        chatId,
        status: 'failed',
        completedSegments: 0,
        totalSegments: 0
      })
      throw error
    } finally {
      if (this.processingControllers.get(chatId) === controller)
        this.processingControllers.delete(chatId)
    }
  }

  cancelReprocessing(chatId: string): void {
    this.processingControllers.get(chatId)?.abort()
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
