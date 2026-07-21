import { join } from 'node:path'
import { appSettingsSchema, type AppSettings, type SettingsPatch } from '../shared/schemas'
import {
  atomicWriteJson,
  ensureDirectory,
  pathExists,
  readValidatedJson
} from './storage/file-utils'

export class ConfigStore {
  private readonly configPath: string
  private settings: AppSettings = appSettingsSchema.parse({})

  constructor(private readonly userDataPath: string) {
    this.configPath = join(userDataPath, 'settings.json')
  }

  async load(): Promise<AppSettings> {
    await ensureDirectory(this.userDataPath)
    if (await pathExists(this.configPath)) {
      this.settings = await readValidatedJson(this.configPath, appSettingsSchema)
    } else {
      await this.persist()
    }
    return this.get()
  }

  get(): AppSettings {
    return { ...this.settings }
  }

  async update(patch: SettingsPatch & { lastVaultPath?: string | null }): Promise<AppSettings> {
    this.settings = appSettingsSchema.parse({ ...this.settings, ...patch })
    await this.persist()
    return this.get()
  }

  private async persist(): Promise<void> {
    await atomicWriteJson(this.configPath, this.settings)
  }
}
