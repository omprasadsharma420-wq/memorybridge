import { describe, expect, it } from 'vitest'
import { createId } from '../../src/shared/ids'
import type { Memory, Project } from '../../src/shared/schemas'
import { classifyProject } from '../../src/main/memory/project-classifier'

describe('conservative project classification', () => {
  const now = '2026-07-23T00:00:00.000Z'
  const alpha: Project = {
    project_id: createId('project'),
    name: 'Atlas Launch',
    description: 'Atlas packaging, wholesale rollout, and Kathmandu launch',
    slug: 'atlas-launch',
    created_at: now,
    updated_at: now
  }
  const beta: Project = {
    project_id: createId('project'),
    name: 'Atlas Research',
    description: 'Atlas competitor interviews and pricing research',
    slug: 'atlas-research',
    created_at: now,
    updated_at: now
  }

  it('uses an exact project name even when projects share vocabulary', () => {
    expect(
      classifyProject('Finalize the Atlas Launch wholesale packaging.', [alpha, beta])
    ).toMatchObject({
      projectId: alpha.project_id,
      reason: expect.stringContaining('Exact project-name')
    })
  })

  it('uses distinctive project memory and leaves ambiguous text unassigned', () => {
    const memory = projectMemory(
      alpha.project_id,
      'The Kathmandu wholesale packaging code is ATL-77.'
    )
    expect(
      classifyProject('Prepare ATL-77 wholesale packaging for Kathmandu.', [alpha, beta], [memory])
        ?.projectId
    ).toBe(alpha.project_id)
    expect(classifyProject('Review the Atlas project notes.', [alpha, beta], [memory])).toBeNull()
  })

  it('normalizes Unicode and diacritics without inventing weak assignments', () => {
    const nepali: Project = {
      ...alpha,
      project_id: createId('project'),
      name: 'काठमाडौँ Café',
      description: 'नेपाल उत्पादन अभियान',
      slug: 'kathmandu-cafe'
    }
    expect(classifyProject('काठमाडौँ Cafe नेपाल उत्पादन तयारी', [alpha, nepali])?.projectId).toBe(
      nepali.project_id
    )
    expect(classifyProject('unrelated generic notes', [alpha, nepali])).toBeNull()
  })
})

function projectMemory(projectId: string, statement: string): Memory {
  const now = new Date().toISOString()
  return {
    memory_id: createId('mem'),
    type: 'project_state',
    statement,
    project_id: projectId,
    chat_id: createId('chat'),
    source_message_ids: [createId('msg')],
    state: 'active',
    confidence: 0.9,
    created_at: now,
    updated_at: now,
    effective_at: now,
    supersedes: [],
    superseded_by: null,
    entities: [],
    tags: [],
    user_confirmed: false,
    pinned: false
  }
}
