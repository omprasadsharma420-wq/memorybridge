import { describe, expect, it } from 'vitest'
import { createId } from '../../src/shared/ids'
import type { Memory } from '../../src/shared/schemas'
import { cosineSimilarity, hybridScore } from '../../src/main/retrieval/retrieval-engine'
import { RetrievalEngine } from '../../src/main/retrieval/retrieval-engine'
import { createHarness } from '../helpers'

const now = new Date().toISOString()
const projectId = createId('project')

describe('hybrid retrieval ranking', () => {
  it('combines keyword, semantic, project, confirmation, and pin signals', () => {
    const memory = makeMemory()
    const strong = hybridScore('initial batch quantity', memory, projectId, [1, 0], [1, 0])
    const weak = hybridScore(
      'holiday itinerary',
      { ...memory, pinned: false, user_confirmed: false },
      null,
      [1, 0],
      [0, 1]
    )
    expect(strong).toBeGreaterThan(weak)
  })

  it('excludes superseded, rejected, disputed, and deleted memories by default', () => {
    for (const state of ['superseded', 'rejected', 'disputed', 'deleted'] as const) {
      expect(hybridScore('batch', { ...makeMemory(), state }, projectId)).toBe(-1)
    }
  })

  it('computes cosine similarity safely', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0)
    expect(cosineSimilarity([], [])).toBe(0)
  })

  it('falls back to cited transcript excerpts when structured memories are insufficient', async () => {
    const harness = await createHarness({ memoryExtractionEnabled: false })
    try {
      const project = await harness.repository.createProject('Materials research')
      const sourceChat = await harness.repository.createChat(project.project_id)
      await harness.chatService.sendMessage(
        sourceChat.chat_id,
        'The cobalt findings are archived in the supplier research folder.'
      )
      const currentChat = await harness.repository.createChat(project.project_id)
      const items = await new RetrievalEngine(harness.repository).retrieve(
        'What were the cobalt findings?',
        project.project_id,
        harness.settings,
        harness.provider,
        currentChat.chat_id
      )
      expect(items.some((item) => item.kind === 'transcript')).toBe(true)
      expect(items.every((item) => item.sourceChatId !== currentChat.chat_id)).toBe(true)
      expect(items.find((item) => item.kind === 'transcript')?.sourceMessageIds[0]).toMatch(/^msg_/)
    } finally {
      await harness.cleanup()
    }
  })
})

function makeMemory(): Memory {
  return {
    memory_id: createId('mem'),
    type: 'decision',
    statement: 'The initial batch quantity is 1,000 units.',
    project_id: projectId,
    chat_id: createId('chat'),
    source_message_ids: [createId('msg')],
    state: 'confirmed',
    confidence: 0.95,
    created_at: now,
    updated_at: now,
    effective_at: now,
    supersedes: [],
    superseded_by: null,
    entities: ['Batch'],
    tags: ['batch', 'quantity'],
    user_confirmed: true,
    pinned: true
  }
}
