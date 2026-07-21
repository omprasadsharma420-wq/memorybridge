import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { createId } from '../../src/shared/ids'
import { deterministicCandidates } from '../../src/main/memory/deterministic-extractor'

describe('extraction evaluation fixtures', () => {
  it('matches every explicit expected taxonomy label', async () => {
    const fixtures = JSON.parse(
      await readFile(new URL('../fixtures/extraction-evaluation.json', import.meta.url), 'utf8')
    ) as Array<{ text: string; expected: string[] }>
    for (const fixture of fixtures) {
      const actual = deterministicCandidates(
        [{ role: 'user', messageId: createId('msg'), content: fixture.text }],
        []
      ).map((candidate) => candidate.type)
      expect(actual, fixture.text).toEqual(fixture.expected)
    }
  })
})
