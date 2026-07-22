import { createHash } from 'node:crypto'
import { createId } from '../../shared/ids'
import type { Message, TopicSegment } from '../../shared/schemas'
import { deterministicTitle, keywords } from '../../shared/text'

export interface SegmentationOptions {
  projectId: string | null
  characterBudget?: number
  overlapMessages?: number
}

export function segmentConversation(
  chatId: string,
  messages: Message[],
  options: SegmentationOptions
): TopicSegment[] {
  const eligible = messages.filter((message) => message.status === 'complete')
  if (eligible.length === 0) return []
  const budget = options.characterBudget ?? 12_000
  const overlap = Math.max(0, Math.min(options.overlapMessages ?? 1, 3))
  const groups: Message[][] = []
  let current: Message[] = []
  let characters = 0

  for (const message of eligible) {
    const previous = current.at(-1)
    const timeGap = previous
      ? Date.parse(message.created_at) - Date.parse(previous.created_at) > 6 * 60 * 60 * 1000
      : false
    const topicShift = current.length >= 4 && keywordOverlap(current, message) < 0.08
    const overBudget = current.length > 0 && characters + message.content.length > budget
    if (timeGap || topicShift || overBudget) {
      groups.push(current)
      current = overlap ? current.slice(-overlap) : []
      characters = current.reduce((sum, item) => sum + item.content.length, 0)
    }
    current.push(message)
    characters += message.content.length
  }
  if (current.length) groups.push(current)

  return groups.map((group, ordinal) => {
    const content = group.map((message) => message.content).join('\n')
    const first = group[0]!
    const last = group.at(-1)!
    return {
      topic_id: createId('topic'),
      chat_id: chatId,
      project_id: options.projectId,
      ordinal,
      label: deterministicTitle(content, 80),
      start_message_id: first.message_id,
      end_message_id: last.message_id,
      message_ids: group.map((message) => message.message_id),
      started_at: first.created_at,
      ended_at: last.created_at,
      entities: extractEntities(content),
      character_count: content.length,
      content_hash: createHash('sha256').update(content).digest('hex')
    }
  })
}

function keywordOverlap(current: Message[], next: Message): number {
  const prior = keywords(
    current
      .slice(-4)
      .map((message) => message.content)
      .join(' ')
  )
  const incoming = keywords(next.content)
  if (!prior.size || !incoming.size) return 1
  const overlap = [...incoming].filter((word) => prior.has(word)).length
  return overlap / incoming.size
}

function extractEntities(input: string): string[] {
  const matches = input.match(/[\p{Lu}][\p{Letter}\p{Number}-]{2,}/gu) ?? []
  return [...new Set(matches)].slice(0, 30)
}
