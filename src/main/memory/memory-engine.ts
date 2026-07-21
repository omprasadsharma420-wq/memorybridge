import { createId } from '../../shared/ids'
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
    const allMessages = sourceMessages ?? (await this.repository.readMessages(chatId))
    const messages = allMessages.slice(-12)
    const existing = await this.repository.listMemories()
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

      let candidates = output.candidates.filter((candidate) =>
        candidate.source_message_ids.every((messageId) => sourceIds.has(messageId))
      )
      if (settings.semanticIndexingEnabled && candidates.length > 0) {
        candidates = await applySemanticDuplicateHints(
          candidates,
          existing,
          chat.project_id,
          provider,
          settings.embeddingModel,
          this.repository
        )
      }
      const rejectedCount = output.candidates.length - candidates.length
      const reconciliation = reconcileMemories(existing, candidates, {
        chatId,
        projectId: chat.project_id
      })
      for (const memory of reconciliation.memories) memorySchema.parse(memory)
      await this.persistAll(reconciliation.memories)
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
            reconciliation.added.map((memory) => memory.statement),
            settings.embeddingModel
          )
          reconciliation.added.forEach((memory, index) => {
            const vector = vectors[index]
            if (vector)
              this.repository.storeEmbedding(memory.memory_id, settings.embeddingModel, vector)
          })
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
  ): Promise<Memory[]> {
    const memories = await this.repository.listMemories()
    const memory = memories.find((item) => item.memory_id === memoryId)
    if (!memory) return memories
    const now = new Date().toISOString()
    if (action.kind === 'confirm')
      Object.assign(memory, { state: 'confirmed', user_confirmed: true, updated_at: now })
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
        updated_at: now
      })
    }
    if (action.kind === 'supersede') {
      const replacement = memories.find((item) => item.memory_id === action.replacementId)
      if (replacement) {
        memory.state = 'superseded'
        memory.superseded_by = replacement.memory_id
        memory.updated_at = now
        replacement.supersedes = [...new Set([...replacement.supersedes, memory.memory_id])]
        replacement.updated_at = now
      }
    }
    if (action.kind === 'merge') {
      const target = memories.find((item) => item.memory_id === action.targetId)
      if (target && target.memory_id !== memory.memory_id) {
        target.source_message_ids = [
          ...new Set([...target.source_message_ids, ...memory.source_message_ids])
        ]
        target.confidence = Math.max(target.confidence, memory.confidence)
        target.updated_at = now
        memory.state = 'superseded'
        memory.superseded_by = target.memory_id
        memory.updated_at = now
      }
    }
    await this.persistAll(memories)
    return this.repository.listMemories()
  }

  private async persistAll(memories: Memory[]): Promise<void> {
    const chats = await this.repository.listChats()
    for (const chat of chats) {
      await this.repository.replaceChatMemories(
        chat.chat_id,
        memories.filter((memory) => memory.chat_id === chat.chat_id)
      )
    }
  }
}

async function applySemanticDuplicateHints(
  candidates: MemoryCandidate[],
  existing: Memory[],
  projectId: string | null,
  provider: AIProvider,
  model: string,
  repository: VaultRepository
): Promise<MemoryCandidate[]> {
  try {
    const candidateVectors = await provider.embed(
      candidates.map((candidate) => candidate.statement),
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
