import type { ZodType } from 'zod'

export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatRequest {
  messages: ProviderMessage[]
  model: string
  signal?: AbortSignal
}

export interface StructuredGenerationRequest<T> {
  messages: ProviderMessage[]
  model: string
  schema: ZodType<T>
  schemaName: string
  signal?: AbortSignal
}

export interface ProviderHealth {
  ok: boolean
  message: string
}

export interface AIProvider {
  readonly id: string
  streamChat(request: ChatRequest): AsyncIterable<string>
  generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T>
  embed(texts: string[], model: string, signal?: AbortSignal): Promise<number[][]>
  validateConfiguration(): Promise<ProviderHealth>
}
