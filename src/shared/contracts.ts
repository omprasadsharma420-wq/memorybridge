import { z } from 'zod'
import {
  chatIdSchema,
  memoryIdSchema,
  memoryStateSchema,
  memoryTypeSchema,
  messageIdSchema,
  projectIdSchema,
  settingsPatchSchema,
  type AppSettings,
  type Chat,
  type Memory,
  type Message,
  type Project,
  type VaultManifest
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
  kind: 'chat' | 'message' | 'memory'
  id: string
  chatId: string
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
  memoryId: string
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

export const createProjectInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default('')
})
export const updateProjectInputSchema = createProjectInputSchema.partial().extend({
  projectId: projectIdSchema
})
export const createChatInputSchema = z.object({ projectId: projectIdSchema.nullable().default(null) })
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
export const searchInputSchema = z.object({
  query: z.string().trim().min(1).max(500),
  projectId: projectIdSchema.nullable().optional(),
  chatId: chatIdSchema.optional(),
  memoryType: memoryTypeSchema.optional(),
  state: memoryStateSchema.optional(),
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
  z.object({ memoryId: memoryIdSchema, action: z.literal('merge'), targetId: memoryIdSchema })
])
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
  sendMessage(input: SendMessageInput): Promise<ChatTurnResult>
  retryMessage(input: RetryMessageInput): Promise<ChatTurnResult>
  stopGeneration(chatId: string): Promise<void>
  listMemories(chatId?: string): Promise<Memory[]>
  memoryAction(input: MemoryActionInput): Promise<Memory[]>
  search(input: SearchInput): Promise<SearchResult[]>
  updateSettings(patch: unknown): Promise<AppSettings>
  saveApiKey(apiKey: string): Promise<void>
  clearApiKey(): Promise<void>
  testConnection(): Promise<{ ok: boolean; message: string }>
  rebuildIndex(): Promise<{ projects: number; chats: number; messages: number; memories: number }>
  rerunExtraction(chatId: string): Promise<Memory[]>
  exportDiagnostics(): Promise<DiagnosticResult>
  onStream(callback: (message: Message) => void): () => void
  onVaultStatus(callback: (status: VaultStatus) => void): () => void
}
