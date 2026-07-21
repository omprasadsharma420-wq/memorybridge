import { dirname, join } from 'node:path'
import { z } from 'zod'
import { appendJsonLine, ensureDirectory, readJsonLines } from './storage/file-utils'
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

const safeLogRecordSchema = z.object({
  timestamp: z.string(),
  event: z.string(),
  category: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  chatId: z.string().optional(),
  messageId: z.string().optional(),
  durationMs: z.number().optional(),
  retryCount: z.number().optional()
})

export type SafeLogRecord = z.infer<typeof safeLogRecordSchema>

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

  async recent(limit = 50): Promise<SafeLogRecord[]> {
    const { values } = await readJsonLines(this.path, safeLogRecordSchema)
    return values.slice(-limit)
  }
}
