import { randomUUID } from 'node:crypto'
import { copyFile, open, readFile, readdir, rm, statfs } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { hostname } from 'node:os'
import { BRAND } from '../../shared/brand'
import { createId } from '../../shared/ids'
import { vaultManifestSchema, type VaultManifest } from '../../shared/schemas'
import type { VaultStatus } from '../../shared/contracts'
import { AppError } from '../errors'
import {
  atomicWriteJson,
  ensureDirectory,
  isWritableDirectory,
  pathExists,
  readValidatedJson,
  resolveInside
} from './file-utils'

const VAULT_DIRECTORIES = [
  'projects',
  'chats',
  'unassigned',
  'attachments',
  'indexes',
  'prompts',
  'migrations',
  'backups',
  'logs',
  'evidence',
  'topics',
  'provider-memories',
  'processing',
  'import-inbox',
  'imported',
  'failed-imports',
  'import-records',
  'connector-state'
] as const

const LOCK_FILE = '.memorybridge.lock.json'
const LOCK_STALE_MS = 45_000
const HEARTBEAT_INTERVAL_MS = 15_000

interface VaultLock {
  vault_id: string
  pid: number
  machine_id: string
  application_version: string
  acquired_at: string
  heartbeat_at: string
  ownership_token: string
}

export class VaultManager {
  private rootPath: string | null = null
  private manifest: VaultManifest | null = null
  private readOnly = false
  private heartbeat: NodeJS.Timeout | null = null
  private heartbeatQueue: Promise<void> = Promise.resolve()
  private ownershipToken: string | null = null
  private heartbeatError: string | null = null

  constructor(
    private readonly timing: {
      heartbeatIntervalMs?: number
      lockStaleMs?: number
    } = {}
  ) {}

  get root(): string {
    if (!this.rootPath || !this.manifest) {
      throw new AppError('VAULT_DISCONNECTED', 'The memory vault is not connected.', true)
    }
    return this.rootPath
  }

  get identity(): VaultManifest {
    if (!this.manifest)
      throw new AppError('VAULT_DISCONNECTED', 'The memory vault is not connected.', true)
    return this.manifest
  }

  async create(rootPath: string): Promise<VaultStatus> {
    const root = resolve(rootPath)
    await ensureDirectory(root)
    if (!(await isWritableDirectory(root))) {
      throw new AppError('VAULT_READ_ONLY', 'The selected vault location is not writable.')
    }
    const manifestPath = join(root, BRAND.vaultManifest)
    if (await pathExists(manifestPath)) {
      throw new AppError('VAULT_EXISTS', 'This folder already contains a MemoryBridge vault.')
    }
    const entries = await readdir(root)
    if (entries.length > 0) {
      const conflicts = entries.filter((entry) =>
        VAULT_DIRECTORIES.includes(entry as (typeof VAULT_DIRECTORIES)[number])
      )
      if (conflicts.length > 0) {
        throw new AppError(
          'VAULT_FOLDER_CONFLICT',
          'The selected folder contains conflicting vault directories.'
        )
      }
    }
    const manifest: VaultManifest = {
      vault_id: createId('vault'),
      schema_version: 2,
      created_at: new Date().toISOString(),
      application: BRAND.name,
      application_version: BRAND.applicationVersion
    }
    await atomicWriteJson(manifestPath, manifest)
    for (const directory of VAULT_DIRECTORIES) await ensureDirectory(join(root, directory))
    this.rootPath = root
    this.manifest = vaultManifestSchema.parse(manifest)
    await this.acquireLock()
    return this.status()
  }

  async open(rootPath: string, allowReadOnlyOnConflict = true): Promise<VaultStatus> {
    const root = resolve(rootPath)
    const manifestPath = join(root, BRAND.vaultManifest)
    if (!(await pathExists(manifestPath))) {
      throw new AppError('VAULT_INVALID', 'The selected folder is not a MemoryBridge vault.')
    }
    let manifest = await readValidatedJson(manifestPath, vaultManifestSchema)
    if (!(await isWritableDirectory(root))) {
      throw new AppError('VAULT_READ_ONLY', 'The selected vault is not writable.')
    }
    for (const directory of VAULT_DIRECTORIES) await ensureDirectory(join(root, directory))
    if (manifest.schema_version === 1) {
      const backup = join(root, 'backups', `memorybridge.vault.pre-v2-${Date.now()}.json`)
      await copyFile(manifestPath, backup)
      manifest = { ...manifest, schema_version: 2 }
      await atomicWriteJson(manifestPath, manifest)
    }
    this.rootPath = root
    this.manifest = manifest
    try {
      await this.acquireLock()
    } catch (error) {
      if (
        !allowReadOnlyOnConflict ||
        !(error instanceof AppError) ||
        error.code !== 'VAULT_LOCKED'
      ) {
        this.rootPath = null
        this.manifest = null
        throw error
      }
      this.readOnly = true
    }
    return this.status()
  }

  async disconnect(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    const rootPath = this.rootPath
    const ownershipToken = this.ownershipToken
    this.ownershipToken = null
    await this.heartbeatQueue.catch(() => undefined)
    if (rootPath && ownershipToken && !this.readOnly) {
      const lockPath = join(rootPath, LOCK_FILE)
      const lock = await this.readLock(lockPath)
      if (lock?.ownership_token === ownershipToken) await rm(lockPath, { force: true })
    }
    this.rootPath = null
    this.manifest = null
    this.readOnly = false
    this.heartbeatError = null
    this.heartbeatQueue = Promise.resolve()
  }

  path(...parts: string[]): string {
    return resolveInside(this.root, ...parts)
  }

  async assertConnected(): Promise<void> {
    if (!this.rootPath || !this.manifest) {
      throw new AppError('VAULT_DISCONNECTED', 'The memory vault is not connected.', true)
    }
    const manifestPath = join(this.rootPath, BRAND.vaultManifest)
    if (!(await pathExists(manifestPath))) {
      await this.disconnect()
      throw new AppError(
        'VAULT_DISCONNECTED',
        'The memory vault is unavailable. Locate it to continue.',
        true
      )
    }
    if (this.readOnly || !(await isWritableDirectory(this.rootPath))) {
      throw new AppError('VAULT_READ_ONLY', 'The memory vault is connected but not writable.', true)
    }
  }

  async status(): Promise<VaultStatus> {
    if (!this.rootPath || !this.manifest) {
      return {
        connected: false,
        path: null,
        writable: false,
        freeBytes: null,
        manifest: null,
        reason: 'not-selected'
      }
    }
    if (!(await pathExists(join(this.rootPath, BRAND.vaultManifest)))) {
      const path = this.rootPath
      await this.disconnect()
      return {
        connected: false,
        path,
        writable: false,
        freeBytes: null,
        manifest: null,
        reason: 'missing'
      }
    }
    const writable = !this.readOnly && (await isWritableDirectory(this.rootPath))
    let freeBytes: number | null
    try {
      const filesystem = await statfs(this.rootPath, { bigint: true })
      const free = filesystem.bavail * filesystem.bsize
      freeBytes = free <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(free) : Number.MAX_SAFE_INTEGER
    } catch {
      freeBytes = null
    }
    return {
      connected: true,
      path: this.rootPath,
      writable,
      freeBytes,
      manifest: this.manifest,
      reason: writable ? undefined : this.readOnly ? 'locked' : 'read-only',
      heartbeatHealthy: this.heartbeatError === null,
      lockMessage: this.readOnly
        ? 'Locked by another MemoryBridge instance. Close it, then retry.'
        : this.heartbeatError
    }
  }

  private async acquireLock(): Promise<void> {
    const lockPath = join(this.root, LOCK_FILE)
    const now = new Date().toISOString()
    const ownershipToken = randomUUID()
    const lock: VaultLock = {
      vault_id: this.identity.vault_id,
      pid: process.pid,
      machine_id: hostname(),
      application_version: BRAND.applicationVersion,
      acquired_at: now,
      heartbeat_at: now,
      ownership_token: ownershipToken
    }
    try {
      const handle = await open(lockPath, 'wx')
      await handle.writeFile(`${JSON.stringify(lock, null, 2)}\n`, 'utf8')
      await handle.sync()
      await handle.close()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const existing = await this.readLock(lockPath)
      if (!this.isStale(existing)) {
        throw new AppError(
          'VAULT_LOCKED',
          'This vault is already open in another MemoryBridge instance.',
          true
        )
      }
      await rm(lockPath, { force: true })
      const handle = await open(lockPath, 'wx')
      await handle.writeFile(`${JSON.stringify(lock, null, 2)}\n`, 'utf8')
      await handle.sync()
      await handle.close()
    }
    this.readOnly = false
    this.ownershipToken = ownershipToken
    this.heartbeatError = null
    this.heartbeat = setInterval(() => {
      this.queueHeartbeat(lockPath, lock)
    }, this.timing.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS)
    this.heartbeat.unref()
  }

  private async readLock(path: string): Promise<VaultLock | null> {
    try {
      const value = JSON.parse(await readFile(path, 'utf8')) as Partial<VaultLock>
      return typeof value.pid === 'number' &&
        typeof value.heartbeat_at === 'string' &&
        typeof value.ownership_token === 'string'
        ? (value as VaultLock)
        : null
    } catch {
      return null
    }
  }

  private isStale(lock: VaultLock | null): boolean {
    if (!lock) return true
    if (Date.now() - Date.parse(lock.heartbeat_at) > (this.timing.lockStaleMs ?? LOCK_STALE_MS))
      return true
    if (lock.machine_id !== hostname()) return false
    try {
      process.kill(lock.pid, 0)
      return false
    } catch {
      return true
    }
  }

  private queueHeartbeat(lockPath: string, lock: VaultLock): void {
    const ownershipToken = lock.ownership_token
    this.heartbeatQueue = this.heartbeatQueue
      .catch(() => undefined)
      .then(async () => {
        if (this.ownershipToken !== ownershipToken) return
        const current = await this.readLock(lockPath)
        if (!current || current.ownership_token !== ownershipToken) {
          if (this.heartbeat) clearInterval(this.heartbeat)
          this.heartbeat = null
          this.heartbeatError = 'Vault lock ownership was lost. Reconnect the vault.'
          return
        }
        await atomicWriteJson(lockPath, {
          ...lock,
          heartbeat_at: new Date().toISOString()
        })
        this.heartbeatError = null
      })
      .catch(() => {
        this.heartbeatError =
          'The vault heartbeat could not be written. Check that the drive is connected.'
      })
  }
}
