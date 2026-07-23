import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { OpenAICompatibleProvider } from '../../src/main/providers/openai-compatible-provider'

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()))
})

describe('OpenAI-compatible provider contracts', () => {
  it('parses successful SSE and requires a terminal marker', async () => {
    const base = await fakeServer((_request, response) => {
      sse(response, [
        { choices: [{ delta: { content: 'hello ' }, finish_reason: null }] },
        { choices: [{ delta: { content: 'world' }, finish_reason: 'stop' }] },
        '[DONE]'
      ])
    })
    const provider = createProvider(base)
    expect(await collect(provider.streamChat({ model: 'test', messages: [] }))).toBe('hello world')
  })

  it('falls back to a non-streaming JSON response and records the detected capability', async () => {
    const base = await fakeServer((_request, response) =>
      json(response, { choices: [{ message: { content: 'non-stream fallback' } }] })
    )
    const provider = createProvider(base)
    expect(await collect(provider.streamChat({ model: 'test', messages: [] }))).toBe(
      'non-stream fallback'
    )
    expect(provider.capabilities()).toMatchObject({ chat: true, streaming: false })
  })

  it('rejects malformed and prematurely terminated SSE', async () => {
    const malformed = await fakeServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end('data: {not-json}\n\n')
    })
    await expect(
      collect(createProvider(malformed).streamChat({ model: 'test', messages: [] }))
    ).rejects.toThrow(/malformed/i)

    const truncated = await fakeServer((_request, response) => {
      sse(response, [{ choices: [{ delta: { content: 'partial' }, finish_reason: null }] }])
    })
    await expect(
      collect(createProvider(truncated).streamChat({ model: 'test', messages: [] }))
    ).rejects.toThrow(/completion marker/i)
  })

  it('surfaces safe HTTP error bodies and retries rate limits', async () => {
    let calls = 0
    const base = await fakeServer((_request, response) => {
      calls += 1
      if (calls === 1) {
        response.writeHead(429, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'slow down' } }))
      } else
        sse(response, [
          { choices: [{ delta: { content: 'retried' }, finish_reason: 'stop' }] },
          '[DONE]'
        ])
    })
    expect(
      await collect(createProvider(base, 1000, 1).streamChat({ model: 'test', messages: [] }))
    ).toBe('retried')
    expect(calls).toBe(2)

    const auth = await fakeServer((_request, response) => {
      response.writeHead(401, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({ error: { message: 'Authorization: Bearer secret-secret-secret' } })
      )
    })
    await expect(
      collect(createProvider(auth).streamChat({ model: 'test', messages: [] }))
    ).rejects.not.toThrow(/secret-secret/)
  })

  it('handles HTML errors and unsupported structured-output APIs without leaking response bodies', async () => {
    const html = await fakeServer((_request, response) => {
      response.writeHead(502, { 'Content-Type': 'text/html' })
      response.end('<html><body>internal-proxy-secret</body></html>')
    })
    await expect(
      collect(createProvider(html).streamChat({ model: 'test', messages: [] }))
    ).rejects.toThrow(/status 502/i)
    await expect(
      collect(createProvider(html).streamChat({ model: 'test', messages: [] }))
    ).rejects.not.toThrow(/internal-proxy-secret/i)

    const unsupported = await fakeServer((_request, response) => {
      response.writeHead(400, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({ error: { message: 'response_format json_schema unsupported' } })
      )
    })
    await expect(
      createProvider(unsupported).generateStructured({
        model: 'test',
        schemaName: 'answer',
        schema: z.object({ answer: z.string() }),
        messages: []
      })
    ).rejects.toThrow(/status 400.*json_schema unsupported/i)
  })

  it('handles timeout and caller cancellation', async () => {
    const slow = await fakeServer(() => undefined)
    await expect(
      collect(createProvider(slow, 30).streamChat({ model: 'test', messages: [] }))
    ).rejects.toThrow()

    const controller = new AbortController()
    const cancelled = collect(
      createProvider(slow, 5000).streamChat({
        model: 'test',
        messages: [],
        signal: controller.signal
      })
    )
    setTimeout(() => controller.abort(), 20)
    await expect(cancelled).rejects.toThrow()
  })

  it('validates structured output, refusals, embeddings, and model listings', async () => {
    const valid = await fakeServer(async (request, response) => {
      const path = request.url ?? ''
      if (path.endsWith('/chat/completions')) {
        await consume(request)
        json(response, { choices: [{ message: { content: '{"answer":"yes"}' } }] })
      } else if (path.endsWith('/embeddings')) {
        json(response, { data: [{ index: 0, embedding: [1, 0] }] })
      } else json(response, { data: [{ id: 'model-a' }] })
    })
    const provider = createProvider(valid)
    expect(
      await provider.generateStructured({
        model: 'test',
        schemaName: 'answer',
        schema: z.object({ answer: z.string() }),
        messages: []
      })
    ).toEqual({ answer: 'yes' })
    expect(await provider.embed(['hello'], 'embed')).toEqual([[1, 0]])
    expect(await provider.listModels()).toEqual(['model-a'])
    expect(provider.capabilities()).toMatchObject({
      structuredOutput: true,
      embeddings: true,
      modelListing: true
    })

    const refusal = await fakeServer((_request, response) =>
      json(response, { choices: [{ message: { refusal: 'no', content: null } }] })
    )
    await expect(
      createProvider(refusal).generateStructured({
        model: 'test',
        schemaName: 'answer',
        schema: z.object({ answer: z.string() }),
        messages: []
      })
    ).rejects.toThrow(/refused/i)

    const invalid = await fakeServer((request, response) => {
      if (request.url?.endsWith('/models')) json(response, { object: 'list' })
      else if (request.url?.endsWith('/embeddings')) json(response, { data: [] })
      else json(response, { choices: [{ message: { content: 'not-json' } }] })
    })
    await expect(
      createProvider(invalid).generateStructured({
        model: 'test',
        schemaName: 'answer',
        schema: z.object({ answer: z.string() }),
        messages: []
      })
    ).rejects.toThrow(/invalid structured/i)
    await expect(createProvider(invalid).embed(['hello'], 'embed')).rejects.toThrow(
      /invalid embeddings/i
    )
    await expect(createProvider(invalid).listModels()).rejects.toThrow(/model list/i)

    const mismatched = await fakeServer((_request, response) =>
      json(response, {
        data: [
          { index: 0, embedding: [1, 0] },
          { index: 1, embedding: [1, 0, 0] }
        ]
      })
    )
    await expect(createProvider(mismatched).embed(['one', 'two'], 'embed')).rejects.toThrow(
      /invalid embeddings/i
    )
  })
})

function createProvider(base: string, timeoutMs = 1000, maxRetries = 0): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    apiBaseUrl: base,
    apiKey: 'test-secret-key',
    timeoutMs,
    maxRetries
  })
}

async function fakeServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
): Promise<string> {
  const server = createServer((request, response) => void handler(request, response))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test server address')
  closers.push(async () => {
    server.closeAllConnections()
    server.close()
    await once(server, 'close')
  })
  return `http://127.0.0.1:${address.port}/v1`
}

function sse(response: ServerResponse, events: unknown[]): void {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  for (const event of events)
    response.write(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`)
  response.end()
}
function json(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(value))
}
async function consume(request: IncomingMessage): Promise<void> {
  for await (const _chunk of request) void _chunk
}
async function collect(stream: AsyncIterable<string>): Promise<string> {
  let output = ''
  for await (const chunk of stream) output += chunk
  return output
}
