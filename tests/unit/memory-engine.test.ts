import { describe, expect, it } from 'vitest'
import { createId } from '../../src/shared/ids'
import type { Memory } from '../../src/shared/schemas'
import { deterministicCandidates } from '../../src/main/memory/deterministic-extractor'
import { findSemanticDuplicateId } from '../../src/main/memory/memory-engine'
import { findDuplicate, reconcileMemories } from '../../src/main/memory/reconciler'

const source = createId('msg')
const chatId = createId('chat')
const projectId = createId('project')

describe('memory extraction and reconciliation', () => {
  it('does not promote a proposal to a decision', () => {
    expect(
      deterministicCandidates(
        [{ role: 'user', messageId: source, content: 'We could use option A.' }],
        []
      )
    ).toEqual([])
  })

  it('recognizes decisions, plans, completions, preferences, and rejected options distinctly', () => {
    const messages = [
      'We have decided to use option A.',
      'We plan to submit the form tomorrow.',
      'The form was submitted today.',
      'Remember that I prefer concise reports.',
      'Do not use cloud storage.'
    ].map((content, index) => ({
      role: 'user',
      messageId: index === 0 ? source : createId('msg'),
      content
    }))
    const candidates = deterministicCandidates(messages, [])
    expect(candidates.map((candidate) => candidate.type)).toEqual([
      'decision',
      'commitment',
      'completed_item',
      'preference',
      'instruction',
      'rejected_option'
    ])
    expect(
      candidates.find((candidate) => candidate.type === 'completed_item')?.represents_completed_work
    ).toBe(true)
  })

  it('controls normalized duplicates and retains all evidence', () => {
    const candidate = deterministicCandidates(
      [{ role: 'user', messageId: source, content: 'We have decided to use Electron.' }],
      []
    )[0]!
    const first = reconcileMemories([], [candidate], {
      chatId,
      projectId,
      now: new Date().toISOString()
    })
    const anotherSource = createId('msg')
    const duplicate = { ...candidate, source_message_ids: [anotherSource] }
    expect(findDuplicate(first.memories, duplicate, projectId)).toBeDefined()
    const second = reconcileMemories(first.memories, [duplicate], {
      chatId,
      projectId,
      now: new Date().toISOString()
    })
    expect(second.memories).toHaveLength(1)
    expect(second.memories[0]?.source_message_ids).toEqual(
      expect.arrayContaining([source, anotherSource])
    )
  })

  it('uses semantic vectors to control paraphrased duplicates when available', () => {
    const existing = baseMemory({
      type: 'preference',
      statement: 'Reports should be concise and direct.'
    })
    const candidate = deterministicCandidates(
      [
        { role: 'user', messageId: source, content: 'Remember that I prefer brief direct reports.' }
      ],
      []
    )[0]!
    expect(
      findSemanticDuplicateId(
        candidate,
        [existing],
        projectId,
        [1, 0, 0],
        new Map([[existing.memory_id, [1, 0, 0]]])
      )
    ).toBe(existing.memory_id)
  })

  it('supersedes an older conflicting decision while preserving both records', () => {
    const firstCandidate = deterministicCandidates(
      [
        {
          role: 'user',
          messageId: source,
          content: 'We have decided the initial batch will contain 5,000 units.'
        }
      ],
      []
    )[0]!
    const first = reconcileMemories([], [firstCandidate], {
      chatId,
      projectId,
      now: '2026-01-01T00:00:00.000Z'
    })
    const secondCandidate = deterministicCandidates(
      [
        {
          role: 'user',
          messageId: createId('msg'),
          content: 'We have decided the initial batch will contain 1,000–1,500 units.'
        }
      ],
      first.memories
    )[0]!
    const second = reconcileMemories(first.memories, [secondCandidate], {
      chatId,
      projectId,
      now: '2026-01-02T00:00:00.000Z'
    })
    expect(second.memories).toHaveLength(2)
    const old = second.memories.find((memory) => memory.statement.includes('5,000'))
    const current = second.memories.find((memory) => memory.statement.includes('1,000'))
    expect(old?.state).toBe('superseded')
    expect(old?.superseded_by).toBe(current?.memory_id)
    expect(current?.state).toBe('active')
  })

  it('resolves a commitment when related work is completed', () => {
    const commitmentCandidate = deterministicCandidates(
      [{ role: 'user', messageId: source, content: 'We plan to submit the application tomorrow.' }],
      []
    )[0]!
    const first = reconcileMemories([], [commitmentCandidate], { chatId, projectId })
    const completedCandidate = deterministicCandidates(
      [
        {
          role: 'user',
          messageId: createId('msg'),
          content: 'The application was submitted this morning.'
        }
      ],
      first.memories
    )[0]!
    const second = reconcileMemories(first.memories, [completedCandidate], { chatId, projectId })
    expect(second.memories.find((memory) => memory.type === 'commitment')?.state).toBe('completed')
    expect(second.memories.find((memory) => memory.type === 'completed_item')?.state).toBe(
      'completed'
    )
  })

  it('does not silently supersede a confirmed memory with an unconfirmed candidate', () => {
    const confirmed = baseMemory({ user_confirmed: true, state: 'confirmed' })
    const candidate = {
      ...deterministicCandidates(
        [{ role: 'user', messageId: source, content: 'The quantity is now 10 units.' }],
        [confirmed]
      )[0]!,
      supersedes: [confirmed.memory_id],
      user_confirmed: false
    }
    const result = reconcileMemories([confirmed], [candidate], { chatId, projectId })
    expect(result.memories.find((memory) => memory.memory_id === confirmed.memory_id)?.state).toBe(
      'confirmed'
    )
    expect(result.added[0]?.state).toBe('disputed')
  })
})

function baseMemory(patch: Partial<Memory> = {}): Memory {
  const now = new Date().toISOString()
  return {
    memory_id: createId('mem'),
    type: 'fact',
    statement: 'The quantity is 5 units.',
    project_id: projectId,
    chat_id: chatId,
    source_message_ids: [source],
    state: 'active',
    confidence: 0.9,
    created_at: now,
    updated_at: now,
    effective_at: now,
    supersedes: [],
    superseded_by: null,
    entities: [],
    tags: ['quantity'],
    user_confirmed: false,
    pinned: false,
    ...patch
  }
}
