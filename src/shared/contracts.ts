import { z } from 'zod'
import {
  chatIdSchema,
  memoryIdSchema,
  memoryStateSchema,
  memoryScopeSchema,
  memoryTypeSchema,
  messageIdSchema,
  providerMemoryIdSchema,
  projectIdSchema,
  topicIdSchema,
  settingsPatchSchema,
  type AppSettings,
  type Chat,
  type Memory,
  type Message,
  type Project,
  type VaultManifest,
  type ImportRecord,
  type MemoryEvidence,
  type ProviderMemory,
  type TopicSegment
} from './schemas'

export interface VaultStatus {
  connected: boolean
  path: string | null
  writable: boolean
  freeBytes: number | null
  manifest: VaultManifest | null
  reason?: 'not-selected' | 'missing' | 'invalid' | 'read-only'
}

export interface SearchResult {
  kind: 'chat' | 'message' | 'memory' | 'provider_memory'
  id: string
  chatId: string | null
  projectId: string | null
  title: string
  excerpt: string
  memoryType: string | null
  state: string | null
  sourceMessageIds: string[]
  score: number
  createdAt: string
}

export interface RetrievedContextItem {
  contextId: string
  kind: 'memory' | 'transcript'
  memoryId: string | null
  statement: string
  memoryType: string
  projectId: string | null
  projectName: string | null
  sourceChatId: string
  sourceChatTitle: string
  sourceMessageIds: string[]
  sourceExcerpt: string
  timestamp: string
  state: string
  score: number
}

export interface ChatTurnResult {
  userMessage: Message
  assistantMessage: Message
  retrievedContext: RetrievedContextItem[]
  memories: Memory[]
}

export interface BootstrapState {
  vault: VaultStatus
  settings: AppSettings
  hasStoredApiKey: boolean
  projects: Project[]
  chats: Chat[]
}

export interface DiagnosticResult {
  path: string
}

export interface ConnectorCapabilitiesView {
  id: string
  name: string
  description: string
  capabilities: Record<string, boolean>
}

export interface ImportPreviewResult {
  token: string
  fileName: string
  connectorId: string
  conversations: number
  messages: number
  providerMemories: number
  warnings: string[]
}

export interface McpConfiguration {
  command: string
  args: string[]
  env: Record<string, string>
  transport: 'stdio'
}

export interface ProviderConnectionResult {
  ok: boolean
  message: string
  capabilities: {
    chat: boolean
    streaming: boolean
    structuredOutput: boolean
    embeddings: boolean
    modelListing: boolean
    cancellation: boolean
  }
}

export interface ProcessingProgress {
  scope: 'segment' | 'chat' | 'project' | 'vault'
  scopeId: string
  chatId: string | null
  status: 'running' | 'complete' | 'cancelled' | 'failed'
  completedChats: number
  totalChats: number
  completedSegments: number
  totalSegments: number
}

export interface ProcessingResult {
  scope: 'segment' | 'chat' | 'project' | 'vault'
  chats: number
  segments: number
  processedSegments: number
  skippedSegments: number
  failedSegments: number
  memories: Memory[]
}

export const importTokenInputSchema = z.object({ token: z.uuid() })
export type ImportTokenInput = z.infer<typeof importTokenInputSchema>

export const createProjectInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default('')
})
export const updateProjectInputSchema = createProjectInputSchema.partial().extend({
  projectId: projectIdSchema
})
export const createChatInputSchema = z.object({
  projectId: projectIdSchema.nullable().default(null)
})
export const updateChatInputSchema = z.object({
  chatId: chatIdSchema,
  title: z.string().trim().min(1).max(160).optional(),
  projectId: projectIdSchema.nullable().optional()
})
export const sendMessageInputSchema = z.object({
  chatId: chatIdSchema,
  content: z.string().trim().min(1).max(100000)
})
export const retryMessageInputSchema = z.object({
  chatId: chatIdSchema,
  userMessageId: messageIdSchema
})
export const chatOnlyInputSchema = z.object({ chatId: chatIdSchema })
export const messageRangeInputSchema = z.object({
  chatId: chatIdSchema,
  afterSequence: z.number().int().min(-1).default(-1),
  limit: z.number().int().min(1).max(1000).default(200)
})
export const memoryOnlyInputSchema = z.object({ memoryId: memoryIdSchema })
export const searchInputSchema = z.object({
  query: z.string().trim().min(1).max(500),
  projectId: projectIdSchema.nullable().optional(),
  chatId: chatIdSchema.optional(),
  memoryType: memoryTypeSchema.optional(),
  state: memoryStateSchema.optional(),
  provider: z.string().trim().min(1).max(120).optional(),
  sourceType: z.enum(['conversation', 'memory', 'provider_memory']).optional(),
  topicId: z.string().trim().min(1).max(120).optional(),
  confirmedOnly: z.boolean().default(false).optional(),
  allProjects: z.boolean().default(false).optional(),
  fromDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  toDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  includeHistory: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(30)
})
export const memoryActionInputSchema = z.discriminatedUnion('action', [
  z.object({ memoryId: memoryIdSchema, action: z.literal('confirm') }),
  z.object({ memoryId: memoryIdSchema, action: z.literal('reject') }),
  z.object({ memoryId: memoryIdSchema, action: z.literal('delete') }),
  z.object({ memoryId: memoryIdSchema, action: z.literal('pin') }),
  z.object({ memoryId: memoryIdSchema, action: z.literal('unpin') }),
  z.object({
    memoryId: memoryIdSchema,
    action: z.literal('edit'),
    statement: z.string().trim().min(1).max(4000),
    type: memoryTypeSchema.optional()
  }),
  z.object({
    memoryId: memoryIdSchema,
    action: z.literal('supersede'),
    replacementId: memoryIdSchema
  }),
  z.object({ memoryId: memoryIdSchema, action: z.literal('merge'), targetId: memoryIdSchema }),
  z.object({ memoryId: memoryIdSchema, action: z.literal('set_scope'), scope: memoryScopeSchema }),
  z.object({
    memoryId: memoryIdSchema,
    action: z.literal('resolve_conflict'),
    resolution: z.enum(['confirm', 'reject'])
  })
])
export const providerMemoryActionInputSchema = z.discriminatedUnion('action', [
  z.object({ providerMemoryId: providerMemoryIdSchema, action: z.literal('confirm') }),
  z.object({ providerMemoryId: providerMemoryIdSchema, action: z.literal('reject') }),
  z.object({ providerMemoryId: providerMemoryIdSchema, action: z.literal('delete') }),
  z.object({
    providerMemoryId: providerMemoryIdSchema,
    action: z.literal('edit'),
    statement: z.string().trim().min(1).max(4000)
  }),
  z.object({
    providerMemoryId: providerMemoryIdSchema,
    action: z.literal('supersede'),
    replacementId: providerMemoryIdSchema
  })
])
export const topicOnlyInputSchema = z.object({ topicId: topicIdSchema })
export const projectOnlyInputSchema = z.object({ projectId: projectIdSchema })
export const processingCancelInputSchema = z.object({ scopeId: z.string().min(1).max(500) })
export const apiKeyInputSchema = z.object({ apiKey: z.string().trim().min(8).max(1000) })
export const settingsInputSchema = settingsPatchSchema

export type CreateProjectInput = z.infer<typeof createProjectInputSchema>
export type UpdateProjectInput = z.infer<typeof updateProjectInputSchema>
export type CreateChatInput = z.infer<typeof createChatInputSchema>
export type UpdateChatInput = z.infer<typeof updateChatInputSchema>
export type SendMessageInput = z.infer<typeof sendMessageInputSchema>
export type RetryMessageInput = z.infer<typeof retryMessageInputSchema>
export type SearchInput = z.infer<typeof searchInputSchema>
export type MemoryActionInput = z.infer<typeof memoryActionInputSchema>
export type ProviderMemoryActionInput = z.infer<typeof providerMemoryActionInputSchema>

export interface MemoryBridgeApi {
  bootstrap(): Promise<BootstrapState>
  chooseAndCreateVault(): Promise<BootstrapState>
  chooseAndOpenVault(): Promise<BootstrapState>
  createProject(input: CreateProjectInput): Promise<Project>
  updateProject(input: UpdateProjectInput): Promise<Project>
  createChat(input: CreateChatInput): Promise<Chat>
  updateChat(input: UpdateChatInput): Promise<Chat>
  listChats(): Promise<Chat[]>
  getMessages(chatId: string): Promise<Message[]>
  getMessageRange(chatId: string, afterSequence?: number, limit?: number): Promise<Message[]>
  sendMessage(input: SendMessageInput): Promise<ChatTurnResult>
  retryMessage(input: RetryMessageInput): Promise<ChatTurnResult>
  stopGeneration(chatId: string): Promise<void>
  listMemories(chatId?: string): Promise<Memory[]>
  memoryAction(input: MemoryActionInput): Promise<Memory[]>
  search(input: SearchInput): Promise<SearchResult[]>
  updateSettings(patch: unknown): Promise<AppSettings>
  saveApiKey(apiKey: string): Promise<void>
  clearApiKey(): Promise<void>
  testConnection(): Promise<ProviderConnectionResult>
  rebuildIndex(): Promise<{ projects: number; chats: number; messages: number; memories: number }>
  rerunExtraction(chatId: string): Promise<Memory[]>
  reprocessSegment(topicId: string): Promise<ProcessingResult>
  reprocessChat(chatId: string): Promise<ProcessingResult>
  reprocessProject(projectId: string): Promise<ProcessingResult>
  reprocessVault(): Promise<ProcessingResult>
  cancelReprocessing(scopeId: string): Promise<void>
  listConnectors(): Promise<ConnectorCapabilitiesView[]>
  chooseImport(): Promise<ImportPreviewResult | null>
  executeImport(input: ImportTokenInput): Promise<ImportRecord>
  scanImportInbox(): Promise<ImportRecord[]>
  listTopics(chatId?: string): Promise<TopicSegment[]>
  listEvidence(memoryId?: string): Promise<MemoryEvidence[]>
  listProviderMemories(): Promise<ProviderMemory[]>
  providerMemoryAction(input: ProviderMemoryActionInput): Promise<ProviderMemory[]>
  getMcpConfiguration(): Promise<McpConfiguration>
  exportDiagnostics(): Promise<DiagnosticResult>
  onStream(callback: (message: Message) => void): () => void
  onVaultStatus(callback: (status: VaultStatus) => void): () => void
  onProcessingProgress(callback: (progress: ProcessingProgress) => void): () => void
}
