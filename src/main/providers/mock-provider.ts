import type {
  AIProvider,
  ChatRequest,
  ProviderHealth,
  StructuredGenerationRequest
} from './provider'
import { deterministicCandidates } from '../memory/deterministic-extractor'
import { extractionOutputSchema } from '../../shared/schemas'

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout)
        reject(new DOMException('Generation stopped.', 'AbortError'))
      },
      { once: true }
    )
  })
}

export class MockProvider implements AIProvider {
  readonly id = 'mock'
  callCount = 0
  private readonly interruptedInputs = new Set<string>()

  async *streamChat(request: ChatRequest): AsyncIterable<string> {
    this.callCount += 1
    const latest =
      [...request.messages].reverse().find((message) => message.role === 'user')?.content ?? ''
    if (latest.includes('[mock:fail]')) throw new Error('MockProviderFailure')
    if (latest.includes('[mock:timeout]')) {
      await wait(40, request.signal)
      throw new Error('MockProviderTimeout')
    }
    const response = `Mock response saved locally. I received: ${latest.replace(/\[mock:[^\]]+\]/g, '').trim()}`
    const shouldInterrupt =
      latest.includes('[mock:interrupt]') && !this.interruptedInputs.has(latest)
    if (shouldInterrupt) this.interruptedInputs.add(latest)
    const interruptAt = shouldInterrupt ? Math.max(10, Math.floor(response.length / 2)) : null
    for (let index = 0; index < response.length; index += 12) {
      if (request.signal?.aborted) throw new DOMException('Generation stopped.', 'AbortError')
      if (interruptAt !== null && index >= interruptAt) throw new Error('MockInterruptedStream')
      await wait(4, request.signal)
      yield response.slice(index, index + 12)
    }
  }

  async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
    const text = request.messages.map((message) => message.content).join('\n')
    if (text.includes('[mock:invalid]')) return request.schema.parse({ unexpected: true })
    const sourceMessages = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => {
        const match = /^\[([^\]]+)\]\s*([\s\S]*)$/.exec(message.content)
        return {
          role: message.role,
          messageId: match?.[1] ?? '',
          content: match?.[2] ?? message.content
        }
      })
      .filter((message) => message.messageId.startsWith('msg_'))
    const output = extractionOutputSchema.parse({
      candidates: deterministicCandidates(sourceMessages, [])
    })
    return request.schema.parse(output)
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => deterministicVector(text))
  }

  async validateConfiguration(): Promise<ProviderHealth> {
    return { ok: true, message: 'Mock provider is ready. No credential or network is required.' }
  }
}

export function deterministicVector(text: string, dimensions = 24): number[] {
  const vector = Array.from({ length: dimensions }, () => 0)
  for (let index = 0; index < text.length; index += 1) {
    const slot = (text.charCodeAt(index) * 31 + index * 17) % dimensions
    vector[slot] = (vector[slot] ?? 0) + 1
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1
  return vector.map((value) => value / magnitude)
}
