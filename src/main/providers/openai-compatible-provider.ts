import { toJSONSchema } from 'zod'
import { redactSecrets } from '../../shared/security'
import { AppError } from '../errors'
import type {
  AIProvider,
  ChatRequest,
  ProviderCapabilities,
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
  private detected: ProviderCapabilities = {
    chat: false,
    streaming: false,
    structuredOutput: false,
    embeddings: false,
    modelListing: false,
    cancellation: true
  }

  constructor(private readonly options: ProviderOptions) {}

  capabilities(): ProviderCapabilities {
    return { ...this.detected }
  }

  async *streamChat(request: ChatRequest): AsyncIterable<string> {
    const response = await this.fetchWithRetry(
      '/chat/completions',
      {
        method: 'POST',
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          stream: true,
          ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {})
        })
      },
      request.signal
    )
    if (!response.body)
      throw new AppError('PROVIDER_EMPTY_STREAM', 'The provider returned no stream.', true)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let terminalSeen = false
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data) continue
        if (data === '[DONE]') {
          terminalSeen = true
          continue
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(data)
        } catch {
          throw new AppError(
            'PROVIDER_MALFORMED_SSE',
            'The provider returned malformed streaming data.'
          )
        }
        const content = extractDelta(parsed)
        if (content) yield content
        if (hasTerminalChoice(parsed)) terminalSeen = true
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) {
      for (const line of buffer.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') terminalSeen = true
        else if (data) {
          try {
            const parsed = JSON.parse(data) as unknown
            const content = extractDelta(parsed)
            if (content) yield content
            if (hasTerminalChoice(parsed)) terminalSeen = true
          } catch {
            throw new AppError(
              'PROVIDER_MALFORMED_SSE',
              'The provider returned malformed streaming data.'
            )
          }
        }
      }
    }
    if (!terminalSeen)
      throw new AppError(
        'PROVIDER_TRUNCATED_STREAM',
        'The provider stream ended without a completion marker.',
        true
      )
    this.detected = { ...this.detected, chat: true, streaming: true }
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
    const body = await parseJsonResponse<Record<string, unknown>>(response)
    if (extractRefusal(body))
      throw new AppError(
        'PROVIDER_STRUCTURED_REFUSAL',
        'The provider refused structured generation.'
      )
    const content = extractMessageContent(body)
    if (!content)
      throw new AppError('PROVIDER_INVALID_OUTPUT', 'The provider returned no structured content.')
    try {
      const parsed = request.schema.parse(JSON.parse(content))
      this.detected = { ...this.detected, structuredOutput: true }
      return parsed
    } catch {
      throw new AppError(
        'PROVIDER_INVALID_OUTPUT',
        'The provider returned invalid structured content.'
      )
    }
  }

  async embed(texts: string[], model: string, signal?: AbortSignal): Promise<number[][]> {
    if (texts.length === 0) return []
    const response = await this.fetchWithRetry(
      '/embeddings',
      { method: 'POST', body: JSON.stringify({ model, input: texts }) },
      signal
    )
    const body = await parseJsonResponse<{
      data?: Array<{ embedding?: number[]; index?: number }>
    }>(response)
    const rows = [...(body.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    if (rows.length !== texts.length || rows.some((row) => !Array.isArray(row.embedding))) {
      throw new AppError('PROVIDER_INVALID_EMBEDDING', 'The provider returned invalid embeddings.')
    }
    this.detected = { ...this.detected, embeddings: true }
    return rows.map((row) => row.embedding as number[])
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const response = await this.fetchWithRetry('/models', { method: 'GET' }, signal)
    const body = await parseJsonResponse<{ data?: Array<{ id?: unknown }> }>(response)
    if (!Array.isArray(body.data))
      throw new AppError('PROVIDER_MODELS_UNSUPPORTED', 'The provider did not return a model list.')
    const models = body.data.flatMap((item) => (typeof item.id === 'string' ? [item.id] : []))
    this.detected = { ...this.detected, modelListing: true }
    return models
  }

  async validateConfiguration(): Promise<ProviderHealth> {
    try {
      await this.listModels()
      return { ok: true, message: 'Provider connection succeeded.' }
    } catch (error) {
      return {
        ok: false,
        message:
          error instanceof Error ? redactSecrets(error.message) : 'Provider connection failed.'
      }
    }
  }

  private async fetchWithRetry(
    path: string,
    init: RequestInit,
    callerSignal?: AbortSignal
  ): Promise<Response> {
    if (!this.options.apiKey)
      throw new AppError('API_KEY_MISSING', 'No provider API key is stored.')
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
          const detail = await safeResponseError(response)
          throw new AppError(
            `PROVIDER_HTTP_${response.status}`,
            `Provider request failed with status ${response.status}${detail ? `: ${detail}` : ''}.`,
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

function hasTerminalChoice(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const choices = (value as { choices?: unknown }).choices
  if (!Array.isArray(choices)) return false
  return choices.some((choice) => {
    const reason = (choice as { finish_reason?: unknown }).finish_reason
    return typeof reason === 'string' && reason.length > 0
  })
}

function extractRefusal(value: Record<string, unknown>): string | null {
  const choices = value.choices
  if (!Array.isArray(choices)) return null
  const first = choices[0] as { message?: { refusal?: unknown } } | undefined
  return typeof first?.message?.refusal === 'string' ? first.message.refusal : null
}

async function safeResponseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown }; message?: unknown }
    const message = body.error?.message ?? body.message
    return typeof message === 'string' ? redactSecrets(message).slice(0, 300) : ''
  } catch {
    return ''
  }
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T
  } catch {
    throw new AppError('PROVIDER_INVALID_JSON', 'The provider returned invalid JSON.')
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
