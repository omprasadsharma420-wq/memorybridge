import { describe, expect, it } from 'vitest'
import { createId } from '../../src/shared/ids'
import type { Memory } from '../../src/shared/schemas'
import { cosineSimilarity, hybridScore } from '../../src/main/retrieval/retrieval-engine'

const now = new Date().toISOString()
const projectId = createId('project')

describe('hybrid retrieval ranking', () => {
  it('combines keyword, semantic, project, confirmation, and pin signals', () => {
    const memory = makeMemory()
    const strong = hybridScore('initial batch quantity', memory, projectId, [1, 0], [1, 0])
    const weak = hybridScore('holiday itinerary', { ...memory, pinned: false, user_confirmed: false }, null, [1, 0], [0, 1])
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
})

function makeMemory(): Memory {
  return {
    memory_id: createId('mem'), type: 'decision', statement: 'The initial batch quantity is 1,000 units.',
    project_id: projectId, chat_id: createId('chat'), source_message_ids: [createId('msg')], state: 'confirmed',
    confidence: 0.95, created_at: now, updated_at: now, effective_at: now, supersedes: [], superseded_by: null,
    entities: ['Batch'], tags: ['batch', 'quantity'], user_confirmed: true, pinned: true
  }
}
