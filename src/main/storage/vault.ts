import { readdir, statfs } from 'node:fs/promises'
import { join, resolve } from 'node:path'
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
  'logs'
] as const

export class VaultManager {
  private rootPath: string | null = null
  private manifest: VaultManifest | null = null

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
      schema_version: 1,
      created_at: new Date().toISOString(),
      application: BRAND.name,
      application_version: BRAND.applicationVersion
    }
    await atomicWriteJson(manifestPath, manifest)
    for (const directory of VAULT_DIRECTORIES) await ensureDirectory(join(root, directory))
    this.rootPath = root
    this.manifest = vaultManifestSchema.parse(manifest)
    return this.status()
  }

  async open(rootPath: string): Promise<VaultStatus> {
    const root = resolve(rootPath)
    const manifestPath = join(root, BRAND.vaultManifest)
    if (!(await pathExists(manifestPath))) {
      throw new AppError('VAULT_INVALID', 'The selected folder is not a MemoryBridge vault.')
    }
    const manifest = await readValidatedJson(manifestPath, vaultManifestSchema)
    if (!(await isWritableDirectory(root))) {
      throw new AppError('VAULT_READ_ONLY', 'The selected vault is not writable.')
    }
    for (const directory of VAULT_DIRECTORIES) await ensureDirectory(join(root, directory))
    this.rootPath = root
    this.manifest = manifest
    return this.status()
  }

  disconnect(): void {
    this.rootPath = null
    this.manifest = null
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
      this.disconnect()
      throw new AppError(
        'VAULT_DISCONNECTED',
        'The memory vault is unavailable. Locate it to continue.',
        true
      )
    }
    if (!(await isWritableDirectory(this.rootPath))) {
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
      this.disconnect()
      return {
        connected: false,
        path,
        writable: false,
        freeBytes: null,
        manifest: null,
        reason: 'missing'
      }
    }
    const writable = await isWritableDirectory(this.rootPath)
    let freeBytes: number | null = null
    try {
      const filesystem = await statfs(this.rootPath, { bigint: true })
      const free = filesystem.bavail * filesystem.bsize
      freeBytes = free <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(free) : Number.MAX_SAFE_INTEGER
    } catch {
      freeBytes = null
    }
    return {
      connected: writable,
      path: this.rootPath,
      writable,
      freeBytes,
      manifest: this.manifest,
      reason: writable ? undefined : 'read-only'
    }
  }
}
