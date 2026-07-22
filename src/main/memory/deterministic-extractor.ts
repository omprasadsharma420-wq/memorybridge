import type { Memory, MemoryCandidate, MemoryType } from '../../shared/schemas'
import { excerpt, keywords, normalizeForComparison, normalizeWhitespace } from '../../shared/text'

interface SourceMessage {
  role: string
  messageId: string
  content: string
}

export function deterministicCandidates(
  messages: SourceMessage[],
  existing: Memory[]
): MemoryCandidate[] {
  const candidates: MemoryCandidate[] = []
  for (const message of messages.filter((item) => item.role === 'user')) {
    const sentences = message.content
      .split(/(?<=[.!?])\s+|\n+/)
      .map(normalizeWhitespace)
      .filter((sentence) => sentence.length > 3 && !sentence.startsWith('[mock:'))
    for (const sentence of sentences) {
      const lower = sentence.toLowerCase()
      const source = [message.messageId]

      if (isProposalOnly(lower)) continue
      if (
        /\b(?:have|has|had|did) not\s+(?:yet\s+)?(?:decided|agreed|confirmed|completed)\b/.test(
          lower
        )
      )
        continue

      if (/\bremember (?:that )?i prefer\b|\bi prefer\b|\bmy preference is\b/.test(lower)) {
        candidates.push(candidate('preference', sentence, source, 0.95, existing, true))
        continue
      }

      if (/\bdo not\b|\bdon't\b|\bnever\b/.test(lower)) {
        candidates.push(candidate('instruction', sentence, source, 0.94, existing, true))
        if (/\b(?:use|choose|adopt|store)\b/.test(lower)) {
          candidates.push(
            candidate('rejected_option', rejectedStatement(sentence), source, 0.9, existing, true)
          )
        }
        continue
      }

      if (/\bconsidered\b.+\b(?:decided|chose) not to\b/.test(lower)) {
        candidates.push(candidate('rejected_option', sentence, source, 0.96, existing, true))
        continue
      }

      if (/\b(?:have |has |we |i )?(?:decided|chose|selected|agreed)\b/.test(lower)) {
        const type: MemoryType = /\bagreed\b/.test(lower) ? 'agreement' : 'decision'
        candidates.push(candidate(type, sentence, source, 0.96, existing, true))
        continue
      }

      if (isCompleted(lower)) {
        candidates.push(
          candidate('completed_item', sentence, source, 0.96, existing, true, {
            represents_completed_work: true
          })
        )
        continue
      }

      if (/\b(?:plan to|will|committed to|promise to|intend to)\b/.test(lower)) {
        candidates.push(candidate('commitment', sentence, source, 0.84, existing, false))
        continue
      }

      if (/\b(?:confirmed|current status|currently|is blocked|depends on|supplier)\b/.test(lower)) {
        candidates.push(candidate('project_state', sentence, source, 0.83, existing, false))
        continue
      }

      if (
        /\bno longer correct\b|\bpreviously\b.+\bnow\b|\bchanged from\b|\bcorrection\b/.test(lower)
      ) {
        candidates.push(candidate('correction', sentence, source, 0.88, existing, true))
        continue
      }

      if (/\b(?:deadline|due(?: by| on)?|no later than)\b/.test(lower)) {
        candidates.push(candidate('deadline', sentence, source, 0.9, existing, false))
        continue
      }

      if (/\b(?:must|cannot|can't|limited to|at most|at least|budget cap)\b/.test(lower)) {
        candidates.push(candidate('constraint', sentence, source, 0.88, existing, false))
        continue
      }

      if (
        /\b(?:file|document|spreadsheet|repository|repo|prototype|contract|report)\b/.test(lower)
      ) {
        candidates.push(candidate('artifact', sentence, source, 0.76, existing, false))
        continue
      }

      if (sentence.endsWith('?') && sentence.length > 12) {
        candidates.push(
          candidate('open_question', sentence, source, 0.82, existing, false, { unresolved: true })
        )
        continue
      }

      if (/\b(?:is|are|costs?|contains?|requires?|uses?)\b/.test(lower) && sentence.length >= 18) {
        candidates.push(candidate('fact', sentence, source, 0.7, existing, false))
      }
    }
  }
  return deduplicateCandidates(candidates)
}

function candidate(
  type: MemoryType,
  statement: string,
  sourceMessageIds: string[],
  confidence: number,
  existing: Memory[],
  userConfirmed: boolean,
  patch: Partial<MemoryCandidate> = {}
): MemoryCandidate {
  const normalized = normalizeForComparison(statement)
  const duplicate = existing.find(
    (memory) => memory.type === type && normalizeForComparison(memory.statement) === normalized
  )
  const related = existing.filter(
    (memory) => keywordSimilarity(memory.statement, statement) >= 0.35
  )
  const hasChangeLanguage = /\b(no longer|instead|changed|now|revised|updated|rather than)\b/i.test(
    statement
  )
  const differentNumber = related.some((memory) => numbers(memory.statement) !== numbers(statement))
  const supersedes =
    hasChangeLanguage || differentNumber
      ? related
          .filter((memory) => !memory.user_confirmed || userConfirmed)
          .map((memory) => memory.memory_id)
      : []
  return {
    type,
    statement: excerpt(statement, 4000),
    source_message_ids: sourceMessageIds,
    confidence,
    entities: extractEntities(statement),
    tags: [...keywords(statement)].slice(0, 8),
    is_new: !duplicate,
    duplicate_of: duplicate?.memory_id ?? null,
    conflicts_with: null,
    supersedes,
    user_confirmed: userConfirmed,
    represents_completed_work: false,
    unresolved: false,
    ...patch
  }
}

function isProposalOnly(lower: string): boolean {
  return (
    /\b(?:could|might|maybe|may|what if|consider)\b/.test(lower) &&
    !/\b(?:decided|confirmed|completed|submitted|agreed)\b/.test(lower)
  )
}

function isCompleted(lower: string): boolean {
  return /\b(?:was|were|has been|have been|is now)?\s*(?:completed|submitted|delivered|implemented|finished|paid|resolved)\b/.test(
    lower
  )
}

function rejectedStatement(statement: string): string {
  return statement.replace(/^do not\s+/i, 'Rejected: ').replace(/^never\s+/i, 'Rejected: ')
}

function numbers(input: string): string {
  return (input.match(/[\d,.]+(?:\s*[-–]\s*[\d,.]+)?/g) ?? []).join('|')
}

function extractEntities(input: string): string[] {
  const entities = input.match(/[\p{Lu}][\p{Letter}\p{Number}-]{2,}/gu) ?? []
  return [...new Set(entities)].slice(0, 12)
}

function keywordSimilarity(left: string, right: string): number {
  const a = keywords(left)
  const b = keywords(right)
  if (a.size === 0 || b.size === 0) return 0
  const intersection = [...a].filter((word) => b.has(word)).length
  return intersection / new Set([...a, ...b]).size
}

function deduplicateCandidates(candidates: MemoryCandidate[]): MemoryCandidate[] {
  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    const key = `${candidate.type}:${normalizeForComparison(candidate.statement)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
