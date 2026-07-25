import { randomUUID } from 'node:crypto'
import { lstat, open, readdir, rm, statfs } from 'node:fs/promises'
import { dirname, join, parse, relative, resolve, sep } from 'node:path'
import type { StorageProgress, VaultStorageStats } from '../../shared/contracts'
import { AppError } from '../errors'
import { VaultRepository } from './repository'
import { VaultManager } from './vault'

const YIELD_INTERVAL = 200

export class VaultCapacityService {
  private cached: VaultStorageStats | null = null

  constructor(
    private readonly vault: VaultManager,
    private readonly repository: VaultRepository
  ) {}

  async calculate(
    options: {
      refresh?: boolean
      signal?: AbortSignal
      onProgress?: (progress: StorageProgress) => void
    } = {}
  ): Promise<VaultStorageStats> {
    if (!options.refresh && this.cached) return this.cached
    await this.vault.assertConnected()
    const root = this.vault.root
    const totals = {
      totalVaultBytes: 0,
      transcriptBytes: 0,
      indexBytes: 0,
      structuredMemoryBytes: 0,
      evidenceBytes: 0,
      embeddingBytes: this.repository.embeddingPayloadBytes(),
      attachmentBytes: 0,
      importArchiveBytes: 0
    }
    let scannedFiles = 0
    const warnings: string[] = []
    const pending = [root]
    while (pending.length) {
      throwIfCancelled(options.signal)
      const directory = pending.pop()!
      let entries
      try {
        entries = await readdir(directory, { withFileTypes: true })
      } catch {
        warnings.push('One or more vault folders could not be inspected.')
        continue
      }
      for (const entry of entries) {
        throwIfCancelled(options.signal)
        const absolute = join(directory, entry.name)
        if (!isInside(root, absolute)) {
          warnings.push('A path outside the vault was skipped.')
          continue
        }
        if (entry.isSymbolicLink()) {
          warnings.push('A symbolic link was skipped to keep the scan inside the vault.')
          continue
        }
        if (entry.isDirectory()) {
          pending.push(absolute)
          continue
        }
        if (!entry.isFile()) continue
        try {
          const info = await lstat(absolute)
          const bytes = safeNumber(info.size)
          totals.totalVaultBytes += bytes
          addCategoryBytes(totals, relative(root, absolute), bytes)
          scannedFiles += 1
          options.onProgress?.({
            status: 'running',
            scannedFiles,
            scannedBytes: totals.totalVaultBytes
          })
          if (scannedFiles % YIELD_INTERVAL === 0)
            await new Promise<void>((resolveYield) => setImmediate(resolveYield))
        } catch {
          warnings.push('One or more vault files could not be inspected.')
        }
      }
    }
    const filesystem = await filesystemStats(root)
    const counts = this.repository.vaultCounts()
    const rootPath = parse(root).root
    const systemRoot = process.env.SystemDrive
      ? `${process.env.SystemDrive.replace(/[\\/]+$/, '')}${sep}`
      : null
    const calculated: VaultStorageStats = {
      vaultName: basenameForVolume(root),
      vaultId: this.vault.identity.vault_id,
      path: root,
      connectionStatus: 'connected',
      writeStatus: 'writable',
      storageType:
        systemRoot && rootPath.toLowerCase() === systemRoot.toLowerCase() ? 'internal' : 'unknown',
      volumeName: basenameForVolume(rootPath),
      filesystem: filesystem.filesystem,
      totalDeviceBytes: filesystem.total,
      freeDeviceBytes: filesystem.free,
      usedDeviceBytes:
        filesystem.total === null || filesystem.free === null
          ? null
          : Math.max(0, filesystem.total - filesystem.free),
      ...totals,
      projects: counts.projects,
      chats: counts.chats,
      messages: counts.messages,
      memories: counts.memories,
      calculatedAt: new Date().toISOString(),
      scannedFiles,
      warnings: [...new Set(warnings)]
    }
    this.cached = calculated
    options.onProgress?.({
      status: 'complete',
      scannedFiles,
      scannedBytes: totals.totalVaultBytes
    })
    return calculated
  }

  async verifyWritable(): Promise<{ ok: true; checkedAt: string }> {
    await this.vault.assertConnected()
    const path = this.vault.path(`.memorybridge-write-check-${randomUUID()}.tmp`)
    let handle
    try {
      handle = await open(path, 'wx')
      await handle.writeFile('MemoryBridge vault location verification\n', 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      await rm(path)
      return { ok: true, checkedAt: new Date().toISOString() }
    } catch {
      await handle?.close().catch(() => undefined)
      await rm(path, { force: true }).catch(() => undefined)
      throw new AppError(
        'VAULT_VERIFY_FAILED',
        'MemoryBridge could not create and remove a test file in this vault.',
        true
      )
    }
  }

  clearCache(): void {
    this.cached = null
  }
}

function addCategoryBytes(
  totals: {
    transcriptBytes: number
    indexBytes: number
    structuredMemoryBytes: number
    evidenceBytes: number
    attachmentBytes: number
    importArchiveBytes: number
  },
  relativePath: string,
  bytes: number
): void {
  const normalized = relativePath.replaceAll('\\', '/').toLowerCase()
  if (/^chats\/[^/]+\/transcript\.jsonl$/.test(normalized)) totals.transcriptBytes += bytes
  if (normalized.startsWith('indexes/')) totals.indexBytes += bytes
  if (
    normalized.startsWith('provider-memories/') ||
    /^chats\/[^/]+\/memories\.json$/.test(normalized) ||
    /^projects\/[^/]+\/project-memory\.json$/.test(normalized)
  )
    totals.structuredMemoryBytes += bytes
  if (normalized.startsWith('evidence/')) totals.evidenceBytes += bytes
  if (normalized.startsWith('attachments/')) totals.attachmentBytes += bytes
  if (
    normalized.startsWith('import-inbox/') ||
    normalized.startsWith('imported/') ||
    normalized.startsWith('failed-imports/')
  )
    totals.importArchiveBytes += bytes
}

async function filesystemStats(
  root: string
): Promise<{ total: number | null; free: number | null; filesystem: string | null }> {
  try {
    const value = await statfs(root, { bigint: true })
    return {
      total: bigintToSafeNumber(value.blocks * value.bsize),
      free: bigintToSafeNumber(value.bavail * value.bsize),
      filesystem: `0x${value.type.toString(16)}`
    }
  } catch {
    return { total: null, free: null, filesystem: null }
  }
}

function bigintToSafeNumber(value: bigint): number {
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value)
}

function safeNumber(value: number): number {
  return Number.isSafeInteger(value) ? value : Number.MAX_SAFE_INTEGER
}

function basenameForVolume(path: string): string {
  const normalized = resolve(path)
  return normalized === parse(normalized).root
    ? parse(normalized).root.replace(/[\\/]+$/, '')
    : normalized.slice(dirname(normalized).length + 1)
}

function isInside(root: string, candidate: string): boolean {
  const result = relative(resolve(root), resolve(candidate))
  return result === '' || (!result.startsWith('..') && !result.includes(`..${sep}`))
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new AppError('CAPACITY_CANCELLED', 'The storage calculation was cancelled safely.', true)
}
