import { createId } from '../../shared/ids'
import type { Memory, MemoryCandidate } from '../../shared/schemas'
import { keywords, normalizeForComparison } from '../../shared/text'
import { canRelateMemories, scopeForConversation } from './scope'

export interface ReconciliationResult {
  memories: Memory[]
  changed: Memory[]
  added: Memory[]
}

export function reconcileMemories(
  existingMemories: Memory[],
  candidates: MemoryCandidate[],
  context: {
    chatId: string
    projectId: string | null
    now?: string
    confirmationSource?: Memory['confirmation_source']
    sourceProvider?: string
  }
): ReconciliationResult {
  const now = context.now ?? new Date().toISOString()
  const memories = existingMemories.map((memory) => ({ ...memory }))
  const changed = new Map<string, Memory>()
  const added: Memory[] = []

  for (const candidate of candidates) {
    const explicitDuplicate = candidate.duplicate_of
      ? memories.find((memory) => memory.memory_id === candidate.duplicate_of)
      : undefined
    const likelyDuplicate =
      explicitDuplicate ?? findDuplicate(memories, candidate, context.projectId)
    if (likelyDuplicate) {
      const sourceIds = [
        ...new Set([...likelyDuplicate.source_message_ids, ...candidate.source_message_ids])
      ]
      const updated: Memory = {
        ...likelyDuplicate,
        source_message_ids: sourceIds,
        confidence: Math.max(likelyDuplicate.confidence, candidate.confidence),
        updated_at: now,
        user_confirmed: likelyDuplicate.user_confirmed || candidate.user_confirmed,
        confirmation_source: likelyDuplicate.user_confirmed
          ? likelyDuplicate.confirmation_source
          : candidate.user_confirmed
            ? (context.confirmationSource ?? 'none')
            : 'none',
        source_chat_ids: [
          ...new Set([
            ...(likelyDuplicate.source_chat_ids ?? [likelyDuplicate.chat_id]),
            context.chatId
          ])
        ]
      }
      replaceMemory(memories, updated)
      changed.set(updated.memory_id, updated)
      continue
    }

    const temporal = extractTemporal(candidate.statement, candidate.type, now)
    const newMemory: Memory = {
      memory_id: createId('mem'),
      type: candidate.type,
      statement: candidate.statement,
      project_id: context.projectId,
      chat_id: context.chatId,
      source_message_ids: [...new Set(candidate.source_message_ids)],
      state:
        candidate.type === 'rejected_option'
          ? 'rejected'
          : candidate.represents_completed_work
            ? 'completed'
            : candidate.conflicts_with
              ? 'disputed'
              : 'active',
      confidence: candidate.confidence,
      created_at: now,
      updated_at: now,
      effective_at: now,
      supersedes: [...candidate.supersedes],
      superseded_by: null,
      entities: candidate.entities,
      tags: candidate.tags,
      user_confirmed: candidate.user_confirmed,
      pinned: false,
      scope: scopeForConversation(context.projectId, context.chatId),
      confirmation_source: candidate.user_confirmed
        ? (context.confirmationSource ?? 'none')
        : 'none',
      evidence_ids: [],
      source_chat_ids: [context.chatId],
      valid_from: temporal.validFrom,
      valid_until: temporal.validUntil,
      temporal_precision: temporal.precision,
      embedding_state: 'missing',
      embedding_content_hash: null,
      source_provider: context.sourceProvider ?? 'native',
      source_type: 'auto_extracted'
    }
    if (candidate.unresolved) newMemory.state = 'needs_review'

    const supersededIds = new Set(candidate.supersedes)
    if (candidate.represents_completed_work) {
      for (const memory of memories) {
        if (
          memory.type === 'commitment' &&
          canRelateMemories(memory, newMemory) &&
          ['active', 'confirmed'].includes(memory.state) &&
          keywordSimilarity(memory.statement, candidate.statement) >= 0.15
        ) {
          supersededIds.add(memory.memory_id)
        }
      }
    }

    for (const memoryId of supersededIds) {
      const previous = memories.find((memory) => memory.memory_id === memoryId)
      if (!previous || !canRelateMemories(previous, newMemory)) continue
      if (previous.user_confirmed && !candidate.user_confirmed) {
        newMemory.state = 'disputed'
        continue
      }
      const updated: Memory = {
        ...previous,
        state:
          candidate.represents_completed_work && previous.type === 'commitment'
            ? 'completed'
            : 'superseded',
        superseded_by: newMemory.memory_id,
        updated_at: now
      }
      replaceMemory(memories, updated)
      changed.set(updated.memory_id, updated)
      if (!newMemory.supersedes.includes(previous.memory_id))
        newMemory.supersedes.push(previous.memory_id)
    }

    if (candidate.conflicts_with && newMemory.supersedes.length === 0) {
      const conflict = memories.find((memory) => memory.memory_id === candidate.conflicts_with)
      if (conflict && canRelateMemories(conflict, newMemory)) {
        const disputed = { ...conflict, state: 'disputed' as const, updated_at: now }
        replaceMemory(memories, disputed)
        changed.set(disputed.memory_id, disputed)
        newMemory.state = 'disputed'
      }
    }

    memories.push(newMemory)
    added.push(newMemory)
    changed.set(newMemory.memory_id, newMemory)
  }

  return { memories, changed: [...changed.values()], added }
}

export function findDuplicate(
  memories: Memory[],
  candidate: MemoryCandidate,
  projectId: string | null
): Memory | undefined {
  const normalized = normalizeForComparison(candidate.statement)
  return memories.find((memory) => {
    if (
      memory.state === 'deleted' ||
      memory.project_id !== projectId ||
      memory.type !== candidate.type
    )
      return false
    if (candidate.supersedes.includes(memory.memory_id)) return false
    if (normalizeForComparison(memory.statement) === normalized) return true
    const entityOverlap = candidate.entities.some((entity) => memory.entities.includes(entity))
    return keywordSimilarity(memory.statement, candidate.statement) >= (entityOverlap ? 0.62 : 0.82)
  })
}

export function keywordSimilarity(left: string, right: string): number {
  const a = new Set([...keywords(left)].map(canonicalTaskWord))
  const b = new Set([...keywords(right)].map(canonicalTaskWord))
  if (!a.size || !b.size) return 0
  const intersection = [...a].filter((word) => b.has(word)).length
  return intersection / new Set([...a, ...b]).size
}

function canonicalTaskWord(word: string): string {
  if (word.endsWith('mitted')) return `${word.slice(0, -6)}mit`
  if (word.endsWith('pleted')) return `${word.slice(0, -3)}`
  if (word.endsWith('ied')) return `${word.slice(0, -3)}y`
  if (word.endsWith('ed') && word.length > 5) return word.slice(0, -2)
  if (word.endsWith('ing') && word.length > 6) return word.slice(0, -3)
  return word
}

function replaceMemory(memories: Memory[], updated: Memory): void {
  const index = memories.findIndex((memory) => memory.memory_id === updated.memory_id)
  if (index >= 0) memories[index] = updated
}

function extractTemporal(
  statement: string,
  type: Memory['type'],
  now: string
): {
  validFrom: string | null
  validUntil: string | null
  precision: NonNullable<Memory['temporal_precision']>
} {
  const day = /\b(\d{4}-\d{2}-\d{2})\b/.exec(statement)?.[1]
  if (day) {
    const timestamp = `${day}T00:00:00.000Z`
    if (!Number.isNaN(Date.parse(timestamp)))
      return {
        validFrom: type === 'deadline' ? null : timestamp,
        validUntil: type === 'deadline' ? timestamp : null,
        precision: 'day'
      }
  }
  if (/\btomorrow\b/i.test(statement)) {
    const date = new Date(now)
    date.setUTCDate(date.getUTCDate() + 1)
    const timestamp = `${date.toISOString().slice(0, 10)}T00:00:00.000Z`
    return {
      validFrom: type === 'deadline' ? null : timestamp,
      validUntil: type === 'deadline' ? timestamp : null,
      precision: 'day'
    }
  }
  return { validFrom: null, validUntil: null, precision: 'unknown' }
}
