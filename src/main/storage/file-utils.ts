import { constants } from 'node:fs'
import {
  access,
  appendFile,
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat
} from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ZodType } from 'zod'
import { AppError } from '../errors'

export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

export function resolveInside(root: string, ...parts: string[]): string {
  const absoluteRoot = resolve(root)
  const target = resolve(absoluteRoot, ...parts)
  const rel = relative(absoluteRoot, target)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new AppError('PATH_TRAVERSAL', 'The requested path leaves the connected vault.')
  }
  return target
}

export async function atomicWriteText(path: string, content: string): Promise<void> {
  await ensureDirectory(dirname(path))
  const temporary = `${path}.tmp-${randomUUID()}`
  const backup = `${path}.bak`
  const handle = await open(temporary, 'wx')
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }

  try {
    await rename(temporary, path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EEXIST' && code !== 'EPERM') {
      await rm(temporary, { force: true })
      throw error
    }
    try {
      await copyFile(path, backup)
    } catch (backupError) {
      if ((backupError as NodeJS.ErrnoException).code !== 'ENOENT') throw backupError
    }
    await rm(path, { force: true })
    await rename(temporary, path)
  }
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`)
}

export async function readValidatedJson<T>(path: string, schema: ZodType<T>): Promise<T> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    try {
      raw = await readFile(`${path}.bak`, 'utf8')
    } catch {
      throw error
    }
  }
  return schema.parse(JSON.parse(raw))
}

export async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await ensureDirectory(dirname(path))
  const handle = await open(path, 'a')
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function readJsonLines<T>(
  path: string,
  schema: ZodType<T>
): Promise<{ values: T[]; malformedLines: number[] }> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { values: [], malformedLines: [] }
    throw error
  }
  const values: T[] = []
  const malformedLines: number[] = []
  const lines = raw.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line?.trim()) continue
    try {
      values.push(schema.parse(JSON.parse(line)))
    } catch {
      malformedLines.push(index + 1)
    }
  }
  return { values, malformedLines }
}

export async function isWritableDirectory(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK)
    const probe = resolve(path, `.memorybridge-write-${randomUUID()}.tmp`)
    await appendFile(probe, '')
    const handle = await open(probe, 'r+')
    await handle.sync()
    await handle.close()
    await rm(probe, { force: true })
    return true
  } catch {
    return false
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export { readFile }
