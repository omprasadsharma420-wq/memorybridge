import { dirname, join } from 'node:path'
import { appendJsonLine, ensureDirectory } from './storage/file-utils'
import { redactSecrets } from '../shared/security'

interface LogEvent {
  event: string
  category?: string
  provider?: string
  model?: string
  chatId?: string
  messageId?: string
  durationMs?: number
  retryCount?: number
}

export class SafeLogger {
  private readonly path: string

  constructor(directory: string) {
    this.path = join(directory, 'memorybridge.log.jsonl')
  }

  async write(event: LogEvent): Promise<void> {
    await ensureDirectory(dirname(this.path))
    const safe = Object.fromEntries(
      Object.entries(event).map(([key, value]) => [key, typeof value === 'string' ? redactSecrets(value).slice(0, 200) : value])
    )
    await appendJsonLine(this.path, { timestamp: new Date().toISOString(), ...safe })
  }
}
