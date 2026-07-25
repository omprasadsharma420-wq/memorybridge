import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import {
  IMPORT_LIMITS,
  ImportService,
  type ImportSafetyLimits
} from '../../src/main/ingestion/import-service'
import { createHarness } from '../helpers'

describe('stabilized ChatGPT importer', () => {
  it('follows current_node through nested branches without mixing alternate responses', async () => {
    const harness = await createHarness()
    try {
      const path = join(harness.directory, 'active-branch.zip')
      await writeFile(
        path,
        archive([
          conversation('branching', 'nested-a', {
            root: node(null, ['user'], null),
            user: node('root', ['alternate', 'active'], message('user', 'user', 'Question', 1)),
            alternate: node(
              'user',
              [],
              message('alternate', 'assistant', 'Contradictory alternate response', 2)
            ),
            active: node(
              'user',
              ['nested-user'],
              message('active', 'assistant', 'Selected response', 3)
            ),
            'nested-user': node(
              'active',
              ['nested-a'],
              message('nested-user', 'user', 'We accept the selected response.', 4)
            ),
            'nested-a': node(
              'nested-user',
              [],
              message('nested-a', 'assistant', 'Active branch continuation', 5)
            )
          })
        ])
      )
      const imports = new ImportService(harness.vault, harness.repository)
      expect(await imports.preview(path)).toMatchObject({ conversations: 1, messages: 4 })
      await imports.import(path)
      const chat = (await harness.repository.listChats()).find(
        (item) => item.source_conversation_id === 'branching'
      )!
      const text = (await harness.repository.readMessages(chat.chat_id))
        .filter((item) => item.status === 'complete')
        .map((item) => item.content)
      expect(text).toEqual([
        'Question',
        'Selected response',
        'We accept the selected response.',
        'Active branch continuation'
      ])
      expect(text).not.toContain('Contradictory alternate response')
    } finally {
      await harness.cleanup()
    }
  })

  it('imports unresolved alternatives as separate coherent chats and flags malformed parents', async () => {
    const harness = await createHarness()
    try {
      const path = join(harness.directory, 'unresolved-branches.zip')
      await writeFile(
        path,
        archive([
          {
            id: 'unresolved',
            title: 'Unresolved branches',
            mapping: {
              root: node(null, ['user'], null),
              user: node('root', ['left', 'right'], message('user', 'user', 'Choose', 1)),
              left: node('user', [], message('left', 'assistant', 'Left answer', 2)),
              right: node('missing-parent', [], message('right', 'assistant', 'Right answer', 3))
            }
          }
        ])
      )
      const imports = new ImportService(harness.vault, harness.repository)
      const preview = await imports.preview(path)
      expect(preview.conversations).toBe(2)
      expect(preview.warnings.join(' ')).toMatch(/separately for review|parent link/i)
      await imports.import(path)
      const chats = (await harness.repository.listChats()).filter((chat) =>
        chat.source_conversation_id?.startsWith('unresolved::branch:')
      )
      expect(chats).toHaveLength(2)
      for (const chat of chats) {
        const assistantAnswers = (await harness.repository.readMessages(chat.chat_id)).filter(
          (item) => item.role === 'assistant'
        )
        expect(assistantAnswers).toHaveLength(1)
        expect(chat.processing_state).toBe('needs_review')
      }
    } finally {
      await harness.cleanup()
    }
  })

  it('streams a multi-megabyte synthetic export with progress and event-loop yields', async () => {
    const harness = await createHarness()
    try {
      const path = join(harness.directory, 'large-synthetic.zip')
      const conversations = Array.from({ length: 240 }, (_, index) => {
        const id = `large-${index}`
        return conversation(id, `${id}-assistant`, {
          [`${id}-root`]: node(null, [`${id}-user`], null),
          [`${id}-user`]: node(
            `${id}-root`,
            [`${id}-assistant`],
            message(`${id}-user-message`, 'user', deterministicText(index, 9_000), 1)
          ),
          [`${id}-assistant`]: node(
            `${id}-user`,
            [],
            message(`${id}-assistant-message`, 'assistant', `Acknowledged ${index}.`, 2)
          )
        })
      })
      await writeFile(path, archive(conversations))
      const progress: string[] = []
      let yielded = false
      setImmediate(() => {
        yielded = true
      })
      const preview = await new ImportService(harness.vault, harness.repository).preview(path, {
        onProgress: (event) => progress.push(event.phase)
      })
      expect(preview).toMatchObject({ conversations: 240, messages: 480 })
      expect(progress).toContain('decompressing')
      expect(yielded).toBe(true)
    } finally {
      await harness.cleanup()
    }
  })

  it('enforces traversal, entry, cumulative, count, ratio, cancellation, and missing-data bounds', async () => {
    const harness = await createHarness()
    try {
      const limits = (patch: Partial<ImportSafetyLimits>): ImportSafetyLimits => ({
        ...IMPORT_LIMITS,
        ...patch
      })
      const traversal = join(harness.directory, 'traversal.zip')
      await writeFile(traversal, zipSync({ '../conversations.json': strToU8(JSON.stringify([])) }))
      await expect(
        new ImportService(harness.vault, harness.repository).preview(traversal)
      ).rejects.toThrow(/unsafe entry path/i)

      const many = join(harness.directory, 'many.zip')
      await writeFile(
        many,
        zipSync({
          'one.txt': strToU8('1'),
          'two.txt': strToU8('2'),
          'conversations.json': strToU8(JSON.stringify([]))
        })
      )
      await expect(
        new ImportService(harness.vault, harness.repository, limits({ maxZipEntries: 2 })).preview(
          many
        )
      ).rejects.toThrow(/too many files/i)

      const oversized = join(harness.directory, 'oversized.zip')
      await writeFile(
        oversized,
        zipSync({ 'conversations.json': strToU8(JSON.stringify([{ content: 'x'.repeat(500) }])) })
      )
      await expect(
        new ImportService(
          harness.vault,
          harness.repository,
          limits({ maxEntryBytes: 100 })
        ).preview(oversized)
      ).rejects.toThrow(/100 MB safety limit/i)

      await expect(
        new ImportService(
          harness.vault,
          harness.repository,
          limits({ maxTotalDecompressedBytes: 100 })
        ).preview(oversized)
      ).rejects.toThrow(/cumulative safety limit/i)

      const ratio = join(harness.directory, 'ratio.zip')
      await writeFile(
        ratio,
        zipSync({
          'conversations.json': strToU8(JSON.stringify([])),
          'high-ratio.txt': new Uint8Array(20_000)
        })
      )
      await expect(
        new ImportService(
          harness.vault,
          harness.repository,
          limits({ maxCompressionRatio: 2 })
        ).preview(ratio)
      ).rejects.toThrow(/compression ratio/i)

      const missing = join(harness.directory, 'missing.zip')
      await writeFile(missing, zipSync({ 'readme.txt': strToU8('no conversations') }))
      await expect(
        new ImportService(harness.vault, harness.repository).preview(missing)
      ).rejects.toThrow(/does not contain conversations/i)

      const cancelled = new AbortController()
      cancelled.abort()
      await expect(
        new ImportService(harness.vault, harness.repository).preview(oversized, {
          signal: cancelled.signal
        })
      ).rejects.toThrow(/cancelled safely/i)
    } finally {
      await harness.cleanup()
    }
  })
})

function archive(conversations: unknown[]): Uint8Array {
  return zipSync({ 'conversations.json': strToU8(JSON.stringify(conversations)) })
}

function conversation(
  id: string,
  currentNode: string,
  mapping: Record<string, unknown>
): Record<string, unknown> {
  return {
    id,
    title: id,
    create_time: 1_700_000_000,
    current_node: currentNode,
    mapping
  }
}

function node(parent: string | null, children: string[], value: unknown): Record<string, unknown> {
  return { parent, children, message: value }
}

function message(
  id: string,
  role: 'user' | 'assistant',
  content: string,
  time: number
): Record<string, unknown> {
  return {
    id,
    author: { role },
    create_time: 1_700_000_000 + time,
    content: { content_type: 'text', parts: [content] },
    status: 'finished_successfully',
    metadata: {}
  }
}

function deterministicText(seed: number, length: number): string {
  let state = seed + 1
  let output = ''
  for (let index = 0; index < length; index += 1) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    output += String.fromCharCode(33 + (state % 90))
  }
  return output
}
