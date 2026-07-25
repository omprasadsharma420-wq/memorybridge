import { z } from 'zod'

const isoDate = z.string().datetime({ offset: true })
const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[a-f0-9-]{16,}$`))

export const vaultIdSchema = id('vault')
export const projectIdSchema = id('project')
export const chatIdSchema = id('chat')
export const messageIdSchema = id('msg')
export const memoryIdSchema = id('mem')
export const extractionIdSchema = id('extract')
export const evidenceIdSchema = id('evidence')
export const topicIdSchema = id('topic')
export const importIdSchema = id('import')
export const providerMemoryIdSchema = id('pmem')

export const vaultManifestSchema = z.object({
  vault_id: vaultIdSchema,
  schema_version: z.number().int().min(1).max(2),
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
  updated_at: isoDate,
  source_provider: z.string().min(1).default('native'),
  source_conversation_id: z.string().max(500).nullable().default(null),
  original_title: z.string().max(500).nullable().default(null),
  workspace: z.string().max(500).nullable().default(null),
  model_ids: z.array(z.string().max(200)).default([]),
  branch_count: z.number().int().nonnegative().default(1),
  attachment_count: z.number().int().nonnegative().default(0),
  citation_count: z.number().int().nonnegative().default(0),
  sync_state: z.enum(['local', 'imported', 'current', 'changed', 'failed']).default('local'),
  processing_state: z
    .enum(['unprocessed', 'processing', 'processed', 'needs_review', 'failed', 'cancelled'])
    .default('unprocessed'),
  import_origin: z.string().max(1000).nullable().default(null),
  content_hash: z.string().max(128).nullable().default(null),
  raw_metadata: z.record(z.string(), z.unknown()).default({})
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
  retrieved_context_ids: z.array(z.union([memoryIdSchema, messageIdSchema])).default([]),
  provider_message_id: z.string().max(500).nullable().default(null).optional(),
  parent_message_id: z.string().max(500).nullable().default(null).optional(),
  branch_id: z.string().max(500).nullable().default(null).optional(),
  content_blocks: z.array(z.record(z.string(), z.unknown())).default([]).optional(),
  attachments: z.array(z.record(z.string(), z.unknown())).default([]).optional(),
  tool_events: z.array(z.record(z.string(), z.unknown())).default([]).optional(),
  citations: z.array(z.record(z.string(), z.unknown())).default([]).optional(),
  raw_metadata: z.record(z.string(), z.unknown()).default({}).optional(),
  content_hash: z.string().max(128).nullable().default(null).optional()
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
  'rejected_option',
  'correction',
  'constraint',
  'deadline',
  'person',
  'organization',
  'artifact',
  'unresolved_conflict'
])

export const memoryStateSchema = z.enum([
  'candidate',
  'active',
  'confirmed',
  'completed',
  'superseded',
  'rejected',
  'disputed',
  'deleted',
  'needs_review'
])

export const memoryScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('global') }),
  z.object({ kind: z.literal('project'), project_id: projectIdSchema }),
  z.object({ kind: z.literal('conversation'), chat_id: chatIdSchema })
])

export const confirmationSourceSchema = z.enum([
  'none',
  'explicit_user_action',
  'deterministic_user_acceptance',
  'imported_provider_memory'
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
  pinned: z.boolean().default(false),
  scope: memoryScopeSchema.optional(),
  confirmation_source: confirmationSourceSchema.default('none').optional(),
  evidence_ids: z.array(evidenceIdSchema).default([]).optional(),
  source_chat_ids: z.array(chatIdSchema).default([]).optional(),
  valid_from: isoDate.nullable().default(null).optional(),
  valid_until: isoDate.nullable().default(null).optional(),
  temporal_precision: z
    .enum(['exact', 'day', 'month', 'year', 'unknown'])
    .default('unknown')
    .optional(),
  embedding_state: z.enum(['missing', 'current', 'stale', 'failed']).default('missing').optional(),
  embedding_content_hash: z.string().max(128).nullable().default(null).optional(),
  source_provider: z.string().min(1).default('native').optional(),
  source_type: z
    .enum(['auto_extracted', 'manual', 'provider_memory'])
    .default('auto_extracted')
    .optional()
})

export const evidenceRoleSchema = z.enum([
  'supports',
  'confirms',
  'contradicts',
  'supersedes',
  'completes'
])

export const memoryEvidenceSchema = z.object({
  evidence_id: evidenceIdSchema,
  memory_id: memoryIdSchema,
  chat_id: chatIdSchema,
  message_id: messageIdSchema,
  provider: z.string().min(1),
  exact_excerpt: z.string().max(4000),
  start_offset: z.number().int().nonnegative().nullable().default(null),
  end_offset: z.number().int().nonnegative().nullable().default(null),
  segment_id: topicIdSchema.nullable().default(null),
  evidence_role: evidenceRoleSchema.default('supports'),
  created_at: isoDate,
  source_available: z.boolean().default(true).optional()
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
  error_category: z.string().optional(),
  checkpoint: z.number().int().nonnegative().default(0).optional(),
  total_segments: z.number().int().nonnegative().default(1).optional()
})

export const topicSegmentSchema = z.object({
  topic_id: topicIdSchema,
  chat_id: chatIdSchema,
  project_id: projectIdSchema.nullable(),
  ordinal: z.number().int().nonnegative(),
  label: z.string().min(1).max(200),
  start_message_id: messageIdSchema,
  end_message_id: messageIdSchema,
  message_ids: z.array(messageIdSchema).min(1),
  started_at: isoDate,
  ended_at: isoDate,
  entities: z.array(z.string().max(120)).default([]),
  character_count: z.number().int().nonnegative(),
  content_hash: z.string().max(128),
  project_confidence: z.number().min(0).max(1).nullable().default(null).optional(),
  project_reason: z.string().max(500).nullable().default(null).optional()
})

export const importRecordSchema = z.object({
  import_id: importIdSchema,
  connector_id: z.string().min(1).max(120),
  connector_version: z.string().min(1).max(120).default('unknown'),
  source_path: z.string().max(2000),
  archive_hash: z.string().max(128),
  status: z.enum([
    'previewed',
    'running',
    'complete',
    'partial',
    'failed',
    'unchanged',
    'cancelled'
  ]),
  started_at: isoDate,
  completed_at: isoDate.nullable().default(null),
  conversation_count: z.number().int().nonnegative().default(0),
  message_count: z.number().int().nonnegative().default(0),
  imported_count: z.number().int().nonnegative().default(0),
  changed_count: z.number().int().nonnegative().default(0),
  skipped_count: z.number().int().nonnegative().default(0),
  error_count: z.number().int().nonnegative().default(0),
  review_count: z.number().int().nonnegative().default(0),
  discovered_count: z.number().int().nonnegative().default(0),
  branches_handled: z.number().int().nonnegative().default(0),
  malformed_count: z.number().int().nonnegative().default(0),
  skipped_entry_count: z.number().int().nonnegative().default(0),
  validation_status: z.enum(['not_run', 'passed', 'warnings', 'failed']).default('not_run'),
  validation_issues: z.array(z.string().max(1000)).max(100).default([]),
  checkpoint: z.record(z.string(), z.unknown()).default({}),
  error_category: z.string().max(120).nullable().default(null),
  error_messages: z.array(z.string().max(1000)).max(100).default([])
})

export const providerMemorySourceTypeSchema = z.enum([
  'provider_saved_memory',
  'custom_instruction',
  'project_instruction',
  'workspace_instruction',
  'provider_summary',
  'other'
])

const providerMemoryStateSchema = z.preprocess(
  (value) => (value === 'imported' ? 'needs_review' : value === 'reviewed' ? 'active' : value),
  z.enum(['active', 'superseded', 'rejected', 'deleted', 'needs_review'])
)

export const providerMemorySchema = z.object({
  provider_memory_id: providerMemoryIdSchema,
  provider: z.string().min(1),
  provider_record_id: z.string().max(500).nullable().default(null),
  source_type: providerMemorySourceTypeSchema.default('provider_saved_memory'),
  statement: z.string().min(1).max(4000),
  source_label: z.string().min(1).max(500),
  scope: z.union([
    memoryScopeSchema,
    z.object({
      kind: z.literal('provider'),
      level: z.enum(['project', 'workspace', 'conversation', 'unknown']),
      reference: z.string().max(500).nullable().default(null)
    })
  ]),
  state: providerMemoryStateSchema.default('needs_review'),
  user_confirmed: z.boolean().default(false),
  imported_at: isoDate,
  provider_updated_at: isoDate.nullable().default(null),
  raw_source_reference: z.string().max(2000).nullable().default(null),
  superseded_by: providerMemoryIdSchema.nullable().default(null),
  content_hash: z.string().max(128)
})

export const processingSegmentCheckpointSchema = z.object({
  topic_id: topicIdSchema,
  content_hash: z.string().max(128),
  state: z.enum(['pending', 'running', 'complete', 'failed', 'cancelled']),
  attempts: z.number().int().nonnegative().default(0),
  error_category: z.string().max(120).nullable().default(null),
  updated_at: isoDate
})

export const processingCheckpointSchema = z.object({
  schema_version: z.literal(1),
  chat_id: chatIdSchema,
  segments: z.record(z.string(), processingSegmentCheckpointSchema).default({}),
  updated_at: isoDate
})

export const registeredVaultSchema = z.object({
  vault_id: vaultIdSchema,
  path: z.string().min(1),
  registered_at: isoDate,
  last_opened_at: isoDate
})

export const appSettingsSchema = z.object({
  lastVaultPath: z.string().nullable().default(null),
  registeredVaults: z.array(registeredVaultSchema).max(100).default([]),
  provider: z.enum(['mock', 'openai-compatible']).default('mock'),
  apiBaseUrl: z.url().default('https://api.openai.com/v1'),
  chatModel: z.string().min(1).default('gpt-4.1-mini'),
  extractionModel: z.string().min(1).default('gpt-4.1-mini'),
  embeddingModel: z.string().min(1).default('text-embedding-3-small'),
  providerCapabilities: z
    .object({
      authentication: z.boolean(),
      chat: z.boolean(),
      streaming: z.boolean(),
      structuredOutput: z.boolean(),
      embeddings: z.boolean(),
      modelListing: z.boolean(),
      cancellation: z.boolean()
    })
    .default({
      authentication: false,
      chat: false,
      streaming: false,
      structuredOutput: false,
      embeddings: false,
      modelListing: false,
      cancellation: true
    }),
  providerCapabilitiesUpdatedAt: isoDate.nullable().default(null),
  onboardingCompleted: z.boolean().default(false),
  processingMode: z.enum(['offline', 'ai', 'demo']).default('demo'),
  requestTimeoutMs: z.number().int().min(1000).max(300000).default(60000),
  maxRetries: z.number().int().min(0).max(5).default(2),
  mockMode: z.boolean().default(true),
  memoryExtractionEnabled: z.boolean().default(true),
  semanticIndexingEnabled: z.boolean().default(false),
  maximumRetrievedMemories: z.number().int().min(0).max(50).default(8),
  retrievalCharacterBudget: z.number().int().min(0).max(50000).default(6000),
  recentChatCharacterBudget: z.number().int().min(0).max(100000).default(12000),
  transcriptExcerptCharacterBudget: z.number().int().min(0).max(50000).default(4000),
  extractionCharacterBudget: z.number().int().min(1000).max(250000).default(30000),
  segmentationCharacterBudget: z.number().int().min(1000).max(250000).default(50000),
  embeddingCharacterBudget: z.number().int().min(100).max(50000).default(8000),
  outputTokenBudget: z.number().int().min(128).max(100000).default(4096),
  includeConversationScope: z.boolean().default(true)
})

export const settingsPatchSchema = appSettingsSchema
  .partial()
  .omit({ lastVaultPath: true, registeredVaults: true })

export type VaultManifest = z.infer<typeof vaultManifestSchema>
export type Project = z.infer<typeof projectSchema>
export type Chat = z.infer<typeof chatSchema>
export type Message = z.infer<typeof messageSchema>
export type MessageStatus = z.infer<typeof messageStatusSchema>
export type Memory = z.infer<typeof memorySchema>
export type MemoryType = z.infer<typeof memoryTypeSchema>
export type MemoryState = z.infer<typeof memoryStateSchema>
export type MemoryScope = z.infer<typeof memoryScopeSchema>
export type ConfirmationSource = z.infer<typeof confirmationSourceSchema>
export type MemoryEvidence = z.infer<typeof memoryEvidenceSchema>
export type MemoryCandidate = z.infer<typeof memoryCandidateSchema>
export type ExtractionOutput = z.infer<typeof extractionOutputSchema>
export type ExtractionRun = z.infer<typeof extractionRunSchema>
export type TopicSegment = z.infer<typeof topicSegmentSchema>
export type ImportRecord = z.infer<typeof importRecordSchema>
export type ProviderMemory = z.infer<typeof providerMemorySchema>
export type ProcessingCheckpoint = z.infer<typeof processingCheckpointSchema>
export type RegisteredVault = z.infer<typeof registeredVaultSchema>
export type AppSettings = z.infer<typeof appSettingsSchema>
export type SettingsPatch = z.infer<typeof settingsPatchSchema>
