import { app, dialog, type BrowserWindow } from 'electron'
import { join } from 'node:path'
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
import type { AppSettings, Chat, Memory, Message, Project, SettingsPatch } from '../shared/schemas'
import { safeErrorCategory } from '../shared/security'
import { ChatService } from './chat-service'
import { ConfigStore } from './config-store'
import { AppError } from './errors'
import { SafeLogger } from './logger'
import { MemoryEngine } from './memory/memory-engine'
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
      try {
        await this.vault.open(this.settings.lastVaultPath)
        await this.initializeRepository()
      } catch (error) {
        await this.logger.write({ event: 'vault.auto_open_failed', category: safeErrorCategory(error) })
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
    await this.vault.create(path)
    await this.config.update({ lastVaultPath: this.vault.root })
    this.settings = this.config.get()
    await this.initializeRepository()
    await this.logger.write({ event: 'vault.created' })
    return this.bootstrap()
  }

  async openVault(path: string): Promise<BootstrapState> {
    this.closeRepository()
    await this.vault.open(path)
    await this.config.update({ lastVaultPath: this.vault.root })
    this.settings = this.config.get()
    await this.initializeRepository()
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
    return this.memory.extractTurn(chatId, await this.getProvider(), this.settings)
  }

  async exportDiagnostics(): Promise<DiagnosticResult> {
    const result = await dialog.showSaveDialog({
      title: 'Export MemoryBridge diagnostics',
      defaultPath: `memorybridge-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) throw new AppError('EXPORT_CANCELLED', 'Diagnostic export was cancelled.')
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
      excludes: ['transcripts', 'message content', 'memory statements', 'credentials', 'vault paths']
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
  }

  private async initializeRepository(): Promise<void> {
    this.repository = new VaultRepository(this.vault)
    await this.repository.initialize()
    this.memoryEngine = new MemoryEngine(this.repository)
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

  private closeRepository(): void {
    this.repository?.close()
    this.repository = null
    this.memoryEngine = null
    this.chatService = null
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
    if (!this.repository) throw new AppError('VAULT_DISCONNECTED', 'Connect a vault to continue.', true)
    return this.repository
  }

  private get memory(): MemoryEngine {
    if (!this.memoryEngine) throw new AppError('VAULT_DISCONNECTED', 'Connect a vault to continue.', true)
    return this.memoryEngine
  }

  private get chat(): ChatService {
    if (!this.chatService) throw new AppError('VAULT_DISCONNECTED', 'Connect a vault to continue.', true)
    return this.chatService
  }
}
