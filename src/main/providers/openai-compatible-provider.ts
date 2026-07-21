import { toJSONSchema } from 'zod'
import { redactSecrets } from '../../shared/security'
import { AppError } from '../errors'
import type {
  AIProvider,
  ChatRequest,
  ProviderHealth,
  StructuredGenerationRequest
} from './provider'

interface ProviderOptions {
  apiBaseUrl: string
  apiKey: string
  timeoutMs: number
  maxRetries: number
}

export class OpenAICompatibleProvider implements AIProvider {
  readonly id = 'openai-compatible'

  constructor(private readonly options: ProviderOptions) {}

  async *streamChat(request: ChatRequest): AsyncIterable<string> {
    const response = await this.fetchWithRetry(
      '/chat/completions',
      {
        method: 'POST',
        body: JSON.stringify({ model: request.model, messages: request.messages, stream: true })
      },
      request.signal
    )
    if (!response.body) throw new AppError('PROVIDER_EMPTY_STREAM', 'The provider returned no stream.', true)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue
        let parsed: unknown
        try {
          parsed = JSON.parse(data)
        } catch {
          continue
        }
        const content = extractDelta(parsed)
        if (content) yield content
      }
    }
  }

  async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
    const response = await this.fetchWithRetry(
      '/chat/completions',
      {
        method: 'POST',
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          stream: false,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: request.schemaName,
              strict: true,
              schema: toJSONSchema(request.schema)
            }
          }
        })
      },
      request.signal
    )
    const body = (await response.json()) as Record<string, unknown>
    const content = extractMessageContent(body)
    if (!content) throw new AppError('PROVIDER_INVALID_OUTPUT', 'The provider returned no structured content.')
    try {
      return request.schema.parse(JSON.parse(content))
    } catch {
      throw new AppError('PROVIDER_INVALID_OUTPUT', 'The provider returned invalid structured content.')
    }
  }

  async embed(texts: string[], model: string, signal?: AbortSignal): Promise<number[][]> {
    if (texts.length === 0) return []
    const response = await this.fetchWithRetry(
      '/embeddings',
      { method: 'POST', body: JSON.stringify({ model, input: texts }) },
      signal
    )
    const body = (await response.json()) as { data?: Array<{ embedding?: number[]; index?: number }> }
    const rows = [...(body.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    if (rows.length !== texts.length || rows.some((row) => !Array.isArray(row.embedding))) {
      throw new AppError('PROVIDER_INVALID_EMBEDDING', 'The provider returned invalid embeddings.')
    }
    return rows.map((row) => row.embedding as number[])
  }

  async validateConfiguration(): Promise<ProviderHealth> {
    try {
      await this.fetchWithRetry('/models', { method: 'GET' })
      return { ok: true, message: 'Provider connection succeeded.' }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? redactSecrets(error.message) : 'Provider connection failed.'
      }
    }
  }

  private async fetchWithRetry(
    path: string,
    init: RequestInit,
    callerSignal?: AbortSignal
  ): Promise<Response> {
    if (!this.options.apiKey) throw new AppError('API_KEY_MISSING', 'No provider API key is stored.')
    let lastError: unknown
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      const timeout = AbortSignal.timeout(this.options.timeoutMs)
      const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout
      try {
        const response = await fetch(`${this.options.apiBaseUrl.replace(/\/$/, '')}${path}`, {
          ...init,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.options.apiKey}`,
            ...init.headers
          },
          signal
        })
        if (response.ok) return response
        const retryable = response.status === 429 || response.status >= 500
        if (!retryable || attempt === this.options.maxRetries) {
          throw new AppError(
            `PROVIDER_HTTP_${response.status}`,
            `Provider request failed with status ${response.status}.`,
            retryable
          )
        }
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt))
      } catch (error) {
        if (callerSignal?.aborted) throw error
        lastError = error
        if (error instanceof AppError && !error.retryable) throw error
        if (attempt === this.options.maxRetries) break
      }
    }
    if (lastError instanceof Error) {
      throw new AppError('PROVIDER_NETWORK', redactSecrets(lastError.message), true)
    }
    throw new AppError('PROVIDER_NETWORK', 'Provider request failed.', true)
  }
}

function extractDelta(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const choices = (value as { choices?: unknown }).choices
  if (!Array.isArray(choices)) return ''
  const first = choices[0] as { delta?: { content?: unknown } } | undefined
  return typeof first?.delta?.content === 'string' ? first.delta.content : ''
}

function extractMessageContent(value: Record<string, unknown>): string | null {
  const choices = value.choices
  if (!Array.isArray(choices)) return null
  const first = choices[0] as { message?: { content?: unknown } } | undefined
  return typeof first?.message?.content === 'string' ? first.message.content : null
}
