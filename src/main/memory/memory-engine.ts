import { createId } from '../../shared/ids'
import { createHash } from 'node:crypto'
import {
  extractionOutputSchema,
  memorySchema,
  type AppSettings,
  type ExtractionRun,
  type Memory,
  type MemoryCandidate,
  type Message
} from '../../shared/schemas'
import { safeErrorCategory } from '../../shared/security'
import type { AIProvider } from '../providers/provider'
import { cosineSimilarity } from '../retrieval/retrieval-engine'
import { VaultRepository } from '../storage/repository'
import { deterministicCandidates } from './deterministic-extractor'
import { keywordSimilarity, reconcileMemories } from './reconciler'
import { canRelateMemories, effectiveScope, scopeForConversation } from './scope'
import { segmentConversation } from './segmenter'

const EXTRACTION_SYSTEM_PROMPT = `You extract only durable, evidence-backed memory from a conversation.
Distinguish proposals from decisions, plans from completed work, and rejected options from active plans.
Every candidate must cite only the supplied message IDs. Return no greetings, filler, unsupported implications,
or assistant suggestions not explicitly accepted by the user.`

export class MemoryEngine {
  constructor(private readonly repository: VaultRepository) {}

  async extractTurn(
    chatId: string,
    provider: AIProvider,
    settings: AppSettings,
    sourceMessages?: Message[]
  ): Promise<Memory[]> {
    if (!settings.memoryExtractionEnabled) return []
    const chat = await this.repository.getChat(chatId)
    const allMessages = (sourceMessages ?? (await this.repository.readMessages(chatId))).filter(
      (message) => message.status === 'complete'
    )
    const messages = boundMessages(allMessages, settings.extractionCharacterBudget)
    const existing = this.repository.listActiveMemories(
      chat.project_id,
      chatId,
      settings.includeConversationScope
    )
    const sourceIds = new Set(messages.map((message) => message.message_id))
    const runBase = {
      extraction_id: createId('extract'),
      chat_id: chatId,
      provider: provider.id,
      model: settings.extractionModel,
      created_at: new Date().toISOString(),
      source_message_ids: [...sourceIds]
    }

    try {
      const output =
        provider.id === 'mock'
          ? extractionOutputSchema.parse({
              candidates: deterministicCandidates(
                messages.map((message) => ({
                  role: message.role,
                  messageId: message.message_id,
                  content: message.content
                })),
                existing
              )
            })
          : await provider.generateStructured({
              model: settings.extractionModel,
              schema: extractionOutputSchema,
              schemaName: 'memory_candidates',
              messages: [
                { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
                ...relatedMemoryPrompt(existing, messages),
                ...messages.map((message) => ({
                  role: message.role,
                  content: `[${message.message_id}] ${message.content}`
                }))
              ]
            })

      let candidates = output.candidates
        .filter((candidate) =>
          candidate.source_message_ids.every((messageId) => sourceIds.has(messageId))
        )
        .map((candidate) =>
          validateCandidate(
            candidate,
            existing,
            messages,
            chat.project_id,
            chatId,
            provider.id === 'mock'
          )
        )
      if (settings.semanticIndexingEnabled && candidates.length > 0) {
        candidates = await applySemanticDuplicateHints(
          candidates,
          existing,
          chat.project_id,
          provider,
          settings.embeddingModel,
          this.repository,
          settings.embeddingCharacterBudget
        )
      }
      const rejectedCount = output.candidates.length - candidates.length
      const reconciliation = reconcileMemories(existing, candidates, {
        chatId,
        projectId: chat.project_id,
        confirmationSource: provider.id === 'mock' ? 'deterministic_user_acceptance' : 'none'
      })
      const evidence = reconciliation.changed.flatMap((memory) =>
        messages
          .filter((message) => memory.source_message_ids.includes(message.message_id))
          .map((message) => {
            const evidenceId = createId('evidence')
            memory.evidence_ids = [...new Set([...(memory.evidence_ids ?? []), evidenceId])]
            memory.source_chat_ids = [
              ...new Set([...(memory.source_chat_ids ?? []), message.chat_id])
            ]
            return {
              evidence_id: evidenceId,
              memory_id: memory.memory_id,
              chat_id: message.chat_id,
              message_id: message.message_id,
              provider: message.provider,
              exact_excerpt: message.content.slice(0, 4000),
              start_offset: 0,
              end_offset: Math.min(message.content.length, 4000),
              created_at: new Date().toISOString()
            }
          })
      )
      for (const memory of reconciliation.memories) memorySchema.parse(memory)
      await this.persistChanged(reconciliation.changed)
      await this.repository.saveEvidence(evidence)
      const run: ExtractionRun = {
        ...runBase,
        status: rejectedCount > 0 && candidates.length === 0 ? 'invalid' : 'complete',
        candidate_count: candidates.length,
        ...(rejectedCount > 0 ? { error_category: 'invalid-source-reference' } : {})
      }
      await this.repository.saveExtractionRun(run)

      if (settings.semanticIndexingEnabled && reconciliation.added.length > 0) {
        try {
          const vectors = await provider.embed(
            reconciliation.added.map((memory) =>
              memory.statement.slice(0, settings.embeddingCharacterBudget)
            ),
            settings.embeddingModel
          )
          reconciliation.added.forEach((memory, index) => {
            const vector = vectors[index]
            if (vector) {
              const contentHash = createHash('sha256').update(memory.statement).digest('hex')
              this.repository.storeEmbedding(
                memory.memory_id,
                settings.embeddingModel,
                vector,
                contentHash
              )
              memory.embedding_state = 'current'
              memory.embedding_content_hash = contentHash
            }
          })
          await this.persistChanged(reconciliation.added)
        } catch {
          // Semantic indexing is optional; keyword indexing remains complete.
        }
      }
      return reconciliation.added
    } catch (error) {
      await this.repository.saveExtractionRun({
        ...runBase,
        status: 'failed',
        candidate_count: 0,
        error_category: safeErrorCategory(error)
      })
      return []
    }
  }

  async applyAction(
    memoryId: string,
    action:
      | { kind: 'confirm' | 'reject' | 'delete' | 'pin' | 'unpin' }
      | { kind: 'edit'; statement: string; type?: Memory['type'] }
      | { kind: 'supersede'; replacementId: string }
      | { kind: 'merge'; targetId: string }
      | { kind: 'set_scope'; scope: Memory['scope'] }
  ): Promise<Memory[]> {
    const memories = await this.repository.listMemories()
    const memory = memories.find((item) => item.memory_id === memoryId)
    if (!memory) return memories
    const now = new Date().toISOString()
    if (action.kind === 'confirm')
      Object.assign(memory, {
        state: 'confirmed',
        user_confirmed: true,
        confirmation_source: 'explicit_user_action',
        updated_at: now
      })
    if (action.kind === 'reject') Object.assign(memory, { state: 'rejected', updated_at: now })
    if (action.kind === 'delete') Object.assign(memory, { state: 'deleted', updated_at: now })
    if (action.kind === 'pin') Object.assign(memory, { pinned: true, updated_at: now })
    if (action.kind === 'unpin') Object.assign(memory, { pinned: false, updated_at: now })
    if (action.kind === 'edit') {
      Object.assign(memory, {
        statement: action.statement,
        ...(action.type ? { type: action.type } : {}),
        state: 'confirmed',
        user_confirmed: true,
        confirmation_source: 'explicit_user_action',
        updated_at: now
      })
    }
    if (action.kind === 'supersede') {
      const replacement = memories.find((item) => item.memory_id === action.replacementId)
      if (replacement && canRelateMemories(memory, replacement)) {
        memory.state = 'superseded'
        memory.superseded_by = replacement.memory_id
        memory.updated_at = now
        replacement.supersedes = [...new Set([...replacement.supersedes, memory.memory_id])]
        replacement.updated_at = now
      }
    }
    if (action.kind === 'merge') {
      const target = memories.find((item) => item.memory_id === action.targetId)
      if (target && target.memory_id !== memory.memory_id && canRelateMemories(memory, target)) {
        target.source_message_ids = [
          ...new Set([...target.source_message_ids, ...memory.source_message_ids])
        ]
        target.confidence = Math.max(target.confidence, memory.confidence)
        target.evidence_ids = [
          ...new Set([...(target.evidence_ids ?? []), ...(memory.evidence_ids ?? [])])
        ]
        target.source_chat_ids = [
          ...new Set([
            ...(target.source_chat_ids ?? [target.chat_id]),
            ...(memory.source_chat_ids ?? [memory.chat_id])
          ])
        ]
        target.updated_at = now
        memory.state = 'superseded'
        memory.superseded_by = target.memory_id
        memory.updated_at = now
      }
    }
    if (action.kind === 'set_scope' && action.scope) {
      memory.scope = action.scope
      memory.project_id = action.scope.kind === 'project' ? action.scope.project_id : null
      if (action.scope.kind === 'global') {
        memory.user_confirmed = true
        memory.state = 'confirmed'
        memory.confirmation_source = 'explicit_user_action'
      }
      memory.updated_at = now
      memory.supersedes = memory.supersedes.filter((targetId) => {
        const target = memories.find((item) => item.memory_id === targetId)
        return Boolean(target && canRelateMemories(memory, target))
      })
    }
    const changed = memories.filter((item) => item.updated_at === now)
    for (const item of changed) {
      if (action.kind === 'edit' || (action.kind === 'merge' && item.memory_id !== memoryId)) {
        item.embedding_state = 'stale'
        item.embedding_content_hash = null
        this.repository.invalidateEmbedding(item.memory_id)
      }
    }
    await this.persistChanged(changed)
    return this.repository.listMemories()
  }

  async reprocessChat(
    chatId: string,
    provider: AIProvider,
    settings: AppSettings,
    signal?: AbortSignal,
    onProgress?: (completed: number, total: number) => void
  ): Promise<{
    segments: number
    processedSegments: number
    skippedSegments: number
    memories: Memory[]
  }> {
    const chat = await this.repository.getChat(chatId)
    const messages = (await this.repository.readMessages(chatId)).filter(
      (message) => message.status === 'complete'
    )
    const segments = segmentConversation(chatId, messages, {
      projectId: chat.project_id,
      characterBudget: settings.segmentationCharacterBudget
    })
    const priorHashes = new Set(
      this.repository.listTopics(chatId).map((topic) => topic.content_hash)
    )
    await this.repository.replaceTopics(chatId, segments)
    const added: Memory[] = []
    let processedSegments = 0
    let skippedSegments = 0
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!
      if (signal?.aborted) break
      if (priorHashes.has(segment.content_hash)) {
        skippedSegments += 1
        onProgress?.(index + 1, segments.length)
        continue
      }
      const source = messages.filter((message) => segment.message_ids.includes(message.message_id))
      added.push(...(await this.extractTurn(chatId, provider, settings, source)))
      processedSegments += 1
      onProgress?.(index + 1, segments.length)
    }
    return {
      segments: segments.length,
      processedSegments,
      skippedSegments,
      memories: added
    }
  }

  private async persistChanged(memories: Memory[]): Promise<void> {
    const chatIds = [...new Set(memories.map((memory) => memory.chat_id))]
    for (const chatId of chatIds) {
      const current = await this.repository.listMemories(chatId)
      const updates = new Map(
        memories
          .filter((memory) => memory.chat_id === chatId)
          .map((memory) => [memory.memory_id, memory])
      )
      await this.repository.replaceChatMemories(chatId, [
        ...current.filter((memory) => !updates.has(memory.memory_id)),
        ...updates.values()
      ])
    }
  }
}

function boundMessages(messages: Message[], characterBudget: number): Message[] {
  const selected: Message[] = []
  let used = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (selected.length > 0 && used + message.content.length > characterBudget) break
    selected.push(message)
    used += message.content.length
  }
  return selected.reverse()
}

function validateCandidate(
  candidate: MemoryCandidate,
  existing: Memory[],
  messages: Message[],
  projectId: string | null,
  chatId: string,
  deterministic: boolean
): MemoryCandidate {
  const intendedScope = scopeForConversation(projectId, chatId)
  const eligibleTargets = new Set(
    existing
      .filter((memory) => {
        const scope = effectiveScope(memory)
        if (scope.kind !== intendedScope.kind) return false
        if (scope.kind === 'project' && intendedScope.kind === 'project')
          return scope.project_id === intendedScope.project_id
        if (scope.kind === 'conversation' && intendedScope.kind === 'conversation')
          return scope.chat_id === intendedScope.chat_id
        return scope.kind === 'global' && intendedScope.kind === 'global'
      })
      .filter((memory) => !['deleted', 'rejected'].includes(memory.state))
      .map((memory) => memory.memory_id)
  )
  const source = messages.filter((message) =>
    candidate.source_message_ids.includes(message.message_id)
  )
  const userSource = source
    .filter((message) => message.role === 'user')
    .map((message) => message.content)
    .join(' ')
  const hasCompletionEvidence =
    /\b(completed|submitted|delivered|implemented|finished|paid|resolved)\b/i.test(userSource)
  const uncertain = /\b(maybe|might|could|possibly|not sure|unconfirmed)\b/i.test(userSource)
  return {
    ...candidate,
    duplicate_of:
      candidate.duplicate_of && eligibleTargets.has(candidate.duplicate_of)
        ? candidate.duplicate_of
        : null,
    conflicts_with:
      candidate.conflicts_with && eligibleTargets.has(candidate.conflicts_with)
        ? candidate.conflicts_with
        : null,
    supersedes: candidate.supersedes.filter((memoryId) => eligibleTargets.has(memoryId)),
    user_confirmed:
      deterministic &&
      candidate.user_confirmed &&
      source.some((message) => message.role === 'user'),
    represents_completed_work: candidate.represents_completed_work && hasCompletionEvidence,
    unresolved: candidate.unresolved || uncertain
  }
}

async function applySemanticDuplicateHints(
  candidates: MemoryCandidate[],
  existing: Memory[],
  projectId: string | null,
  provider: AIProvider,
  model: string,
  repository: VaultRepository,
  characterBudget: number
): Promise<MemoryCandidate[]> {
  try {
    const candidateVectors = await provider.embed(
      candidates.map((candidate) => candidate.statement.slice(0, characterBudget)),
      model
    )
    const existingVectors = new Map(
      repository.getEmbeddings(model).map((embedding) => [embedding.memoryId, embedding.vector])
    )
    return candidates.map((candidate, index) => {
      if (candidate.duplicate_of) return candidate
      const vector = candidateVectors[index]
      if (!vector) return candidate
      const matchId = findSemanticDuplicateId(
        candidate,
        existing,
        projectId,
        vector,
        existingVectors
      )
      return matchId ? { ...candidate, is_new: false, duplicate_of: matchId } : candidate
    })
  } catch {
    return candidates
  }
}

export function findSemanticDuplicateId(
  candidate: MemoryCandidate,
  existing: Memory[],
  projectId: string | null,
  candidateVector: number[],
  existingVectors: Map<string, number[]>,
  threshold = 0.96
): string | null {
  return (
    existing
      .filter(
        (memory) =>
          memory.project_id === projectId &&
          memory.type === candidate.type &&
          memory.state !== 'deleted' &&
          sameNumbers(memory.statement, candidate.statement) &&
          existingVectors.has(memory.memory_id)
      )
      .map((memory) => ({
        memory,
        score: cosineSimilarity(candidateVector, existingVectors.get(memory.memory_id)!)
      }))
      .filter(({ score }) => score >= threshold)
      .sort((left, right) => right.score - left.score)[0]?.memory.memory_id ?? null
  )
}

function sameNumbers(left: string, right: string): boolean {
  const extract = (value: string): string => (value.match(/[\d,.]+/g) ?? []).join('|')
  return extract(left) === extract(right)
}

function relatedMemoryPrompt(
  existing: Memory[],
  messages: Message[]
): Array<{ role: 'system'; content: string }> {
  const conversation = messages.map((message) => message.content).join(' ')
  const related = existing
    .filter((memory) => !['deleted', 'rejected'].includes(memory.state))
    .map((memory) => ({ memory, score: keywordSimilarity(memory.statement, conversation) }))
    .filter(({ score }) => score >= 0.1)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
  if (related.length === 0) return []
  return [
    {
      role: 'system',
      content: `Potentially related existing memories for duplicate/conflict/supersession checks:\n${related
        .map(
          ({ memory }) =>
            `[${memory.memory_id}; ${memory.type}; ${memory.state}] ${memory.statement}`
        )
        .join('\n')}`
    }
  ]
}
