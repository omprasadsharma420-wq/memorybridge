import { describe, expect, it } from 'vitest'
import { segmentConversation } from '../../src/main/memory/segmenter'
import { createId } from '../../src/shared/ids'
import type { Message } from '../../src/shared/schemas'

describe('topic segmentation', () => {
  it('handles thousands of complete messages with bounded segments and stable ordering', () => {
    const chatId = createId('chat')
    const started = Date.parse('2026-01-01T00:00:00.000Z')
    const messages: Message[] = Array.from({ length: 2_000 }, (_, sequence) => {
      const timestamp = new Date(started + sequence * 1_000).toISOString()
      return {
        message_id: createId('msg'),
        chat_id: chatId,
        role: sequence % 2 ? 'assistant' : 'user',
        content: `MemoryBridge migration decision ${sequence} keeps SQLite indexing local and bounded.`,
        created_at: timestamp,
        updated_at: timestamp,
        provider: 'fixture',
        model: 'fixture',
        status: 'complete',
        sequence,
        retrieved_memory_ids: [],
        retrieved_context_ids: []
      }
    })

    const topics = segmentConversation(chatId, messages, {
      projectId: null,
      characterBudget: 12_000,
      overlapMessages: 1
    })

    expect(topics.length).toBeGreaterThan(1)
    expect(topics.length).toBeLessThan(20)
    expect(topics[0]?.start_message_id).toBe(messages[0]?.message_id)
    expect(topics.at(-1)?.end_message_id).toBe(messages.at(-1)?.message_id)
    expect(topics.every((topic, ordinal) => topic.ordinal === ordinal)).toBe(true)
    expect(topics.every((topic) => topic.character_count < 12_500)).toBe(true)
  })
})
