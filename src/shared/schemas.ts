import { z } from 'zod'

const isoDate = z.string().datetime({ offset: true })
const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[a-f0-9-]{16,}$`))

export const vaultIdSchema = id('vault')
export const projectIdSchema = id('project')
export const chatIdSchema = id('chat')
export const messageIdSchema = id('msg')
export const memoryIdSchema = id('mem')
export const extractionIdSchema = id('extract')

export const vaultManifestSchema = z.object({
  vault_id: vaultIdSchema,
  schema_version: z.literal(1),
  created_at: isoDate,
  application: z.literal('MemoryBridge'),
  application_version: z.string().min(1)
})

export const projectSchema = z.object({
  project_id: projectIdSchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default(''),
  slug: z.string().min(1),
  created_at: isoDate,
  updated_at: isoDate
})

export const chatSchema = z.object({
  chat_id: chatIdSchema,
  project_id: projectIdSchema.nullable(),
  title: z.string().trim().min(1).max(160),
  slug: z.string().min(1),
  created_at: isoDate,
  updated_at: isoDate
})

export const messageStatusSchema = z.enum([
  'pending',
  'streaming',
  'complete',
  'interrupted',
  'failed',
  'cancelled'
])

export const messageSchema = z.object({
  message_id: messageIdSchema,
  chat_id: chatIdSchema,
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
  created_at: isoDate,
  updated_at: isoDate,
  provider: z.string().min(1),
  model: z.string().min(1),
  status: messageStatusSchema,
  sequence: z.number().int().nonnegative(),
  error_category: z.string().max(120).optional(),
  retrieved_memory_ids: z.array(memoryIdSchema).default([]),
  retrieved_context_ids: z.array(z.union([memoryIdSchema, messageIdSchema])).default([])
})

export const memoryTypeSchema = z.enum([
  'decision',
  'agreement',
  'completed_item',
  'fact',
  'preference',
  'instruction',
  'commitment',
  'open_question',
  'project_state',
  'rejected_option'
])

export const memoryStateSchema = z.enum([
  'candidate',
  'active',
  'confirmed',
  'completed',
  'superseded',
  'rejected',
  'disputed',
  'deleted'
])

export const memorySchema = z.object({
  memory_id: memoryIdSchema,
  type: memoryTypeSchema,
  statement: z.string().trim().min(1).max(4000),
  project_id: projectIdSchema.nullable(),
  chat_id: chatIdSchema,
  source_message_ids: z.array(messageIdSchema).min(1),
  state: memoryStateSchema,
  confidence: z.number().min(0).max(1),
  created_at: isoDate,
  updated_at: isoDate,
  effective_at: isoDate,
  supersedes: z.array(memoryIdSchema).default([]),
  superseded_by: memoryIdSchema.nullable().default(null),
  entities: z.array(z.string().trim().min(1).max(120)).default([]),
  tags: z.array(z.string().trim().min(1).max(80)).default([]),
  user_confirmed: z.boolean().default(false),
  pinned: z.boolean().default(false)
})

export const memoryCandidateSchema = z.object({
  type: memoryTypeSchema,
  statement: z.string().trim().min(1).max(4000),
  source_message_ids: z.array(messageIdSchema).min(1),
  confidence: z.number().min(0).max(1),
  entities: z.array(z.string().trim().min(1).max(120)).default([]),
  tags: z.array(z.string().trim().min(1).max(80)).default([]),
  is_new: z.boolean().default(true),
  duplicate_of: memoryIdSchema.nullable().default(null),
  conflicts_with: memoryIdSchema.nullable().default(null),
  supersedes: z.array(memoryIdSchema).default([]),
  user_confirmed: z.boolean().default(false),
  represents_completed_work: z.boolean().default(false),
  unresolved: z.boolean().default(false)
})

export const extractionOutputSchema = z.object({
  candidates: z.array(memoryCandidateSchema).max(25)
})

export const extractionRunSchema = z.object({
  extraction_id: extractionIdSchema,
  chat_id: chatIdSchema,
  provider: z.string().min(1),
  model: z.string().min(1),
  status: z.enum(['complete', 'failed', 'invalid']),
  created_at: isoDate,
  source_message_ids: z.array(messageIdSchema),
  candidate_count: z.number().int().nonnegative(),
  error_category: z.string().optional()
})

export const appSettingsSchema = z.object({
  lastVaultPath: z.string().nullable().default(null),
  provider: z.enum(['mock', 'openai-compatible']).default('mock'),
  apiBaseUrl: z.url().default('https://api.openai.com/v1'),
  chatModel: z.string().min(1).default('gpt-4.1-mini'),
  extractionModel: z.string().min(1).default('gpt-4.1-mini'),
  embeddingModel: z.string().min(1).default('text-embedding-3-small'),
  requestTimeoutMs: z.number().int().min(1000).max(300000).default(60000),
  maxRetries: z.number().int().min(0).max(5).default(2),
  mockMode: z.boolean().default(true),
  memoryExtractionEnabled: z.boolean().default(true),
  semanticIndexingEnabled: z.boolean().default(false),
  maximumRetrievedMemories: z.number().int().min(0).max(50).default(8),
  retrievalCharacterBudget: z.number().int().min(0).max(50000).default(6000)
})

export const settingsPatchSchema = appSettingsSchema.partial().omit({ lastVaultPath: true })

export type VaultManifest = z.infer<typeof vaultManifestSchema>
export type Project = z.infer<typeof projectSchema>
export type Chat = z.infer<typeof chatSchema>
export type Message = z.infer<typeof messageSchema>
export type MessageStatus = z.infer<typeof messageStatusSchema>
export type Memory = z.infer<typeof memorySchema>
export type MemoryType = z.infer<typeof memoryTypeSchema>
export type MemoryState = z.infer<typeof memoryStateSchema>
export type MemoryCandidate = z.infer<typeof memoryCandidateSchema>
export type ExtractionOutput = z.infer<typeof extractionOutputSchema>
export type ExtractionRun = z.infer<typeof extractionRunSchema>
export type AppSettings = z.infer<typeof appSettingsSchema>
export type SettingsPatch = z.infer<typeof settingsPatchSchema>
