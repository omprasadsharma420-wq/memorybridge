import { safeStorage } from 'electron'
import { join } from 'node:path'
import { AppError } from '../errors'
import { atomicWriteText, pathExists, readFile } from '../storage/file-utils'

export class CredentialStore {
  private readonly path: string

  constructor(userDataPath: string) {
    this.path = join(userDataPath, 'provider-key.enc')
  }

  async save(apiKey: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new AppError(
        'SECURE_STORAGE_UNAVAILABLE',
        'Windows secure storage is unavailable. The key was not saved.'
      )
    }
    const encrypted = safeStorage.encryptString(apiKey.trim())
    await atomicWriteText(this.path, encrypted.toString('base64'))
  }

  async load(): Promise<string | null> {
    if (!(await pathExists(this.path)) || !safeStorage.isEncryptionAvailable()) return null
    const encoded = await readFile(this.path, 'utf8')
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'))
  }

  async has(): Promise<boolean> {
    return pathExists(this.path)
  }

  async clear(): Promise<void> {
    const { rm } = await import('node:fs/promises')
    await rm(this.path, { force: true })
  }
}
