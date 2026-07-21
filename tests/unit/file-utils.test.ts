import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import {
  appendJsonLine,
  atomicWriteJson,
  readJsonLines,
  readValidatedJson,
  resolveInside
} from '../../src/main/storage/file-utils'

describe('safe file utilities', () => {
  it('atomically writes JSON and reads a backup if the primary is missing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'memorybridge-files-'))
    try {
      const path = join(directory, 'metadata.json')
      await atomicWriteJson(path, { value: 1 })
      expect(await readValidatedJson(path, z.object({ value: z.number() }))).toEqual({ value: 1 })
      await writeFile(`${path}.bak`, JSON.stringify({ value: 2 }))
      await rm(path)
      expect(await readValidatedJson(path, z.object({ value: z.number() }))).toEqual({ value: 2 })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('appends recoverable JSONL and reports malformed lines', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'memorybridge-jsonl-'))
    try {
      const path = join(directory, 'transcript.jsonl')
      await appendJsonLine(path, { value: 1 })
      await writeFile(path, `${await readFile(path, 'utf8')}{broken\n`, 'utf8')
      const result = await readJsonLines(path, z.object({ value: z.number() }))
      expect(result.values).toEqual([{ value: 1 }])
      expect(result.malformedLines).toEqual([2])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('prevents path traversal outside the vault', () => {
    expect(() => resolveInside('C:\\vault', '..', 'secret.txt')).toThrow(
      /leaves the connected vault/
    )
    expect(resolveInside('C:\\vault', 'chats', 'safe')).toContain('safe')
  })
})
