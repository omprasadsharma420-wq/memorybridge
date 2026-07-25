import { describe, expect, it } from 'vitest'
import { createId } from '../../src/shared/ids'
import type { Message } from '../../src/shared/schemas'
import { MockProvider } from '../../src/main/providers/mock-provider'
import type {
  AIProvider,
  ChatRequest,
  StructuredGenerationRequest
} from '../../src/main/providers/provider'
import { createHarness } from '../helpers'

class FlakyExtractionProvider implements AIProvider {
  readonly id = 'flaky-test'
  failuresRemaining = 1
  private readonly delegate = new MockProvider()

  capabilities(): ReturnType<MockProvider['capabilities']> {
    return this.delegate.capabilities()
  }
  streamChat(request: ChatRequest): AsyncIterable<string> {
    return this.delegate.streamChat(request)
  }
  async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1
      throw new Error('SyntheticExtractionFailure')
    }
    return this.delegate.generateStructured(request)
  }
  embed(texts: string[]): Promise<number[][]> {
    return this.delegate.embed(texts)
  }
  validateConfiguration(): ReturnType<MockProvider['validateConfiguration']> {
    return this.delegate.validateConfiguration()
  }
  listModels(): Promise<string[]> {
    return this.delegate.listModels()
  }
}

describe('resumable reprocessing', () => {
  it('persists per-segment checkpoints, skips completed work, and retries failed segments', async () => {
    const harness = await createHarness({
      segmentationCharacterBudget: 1000,
      semanticIndexingEnabled: false
    })
    try {
      const chat = await harness.repository.createChat()
      await appendUser(
        harness,
        chat.chat_id,
        `We decided to use Cedar for packaging. ${'cedar '.repeat(180)}`,
        0
      )
      await appendUser(
        harness,
        chat.chat_id,
        `We decided to use Birch for labels. ${'birch '.repeat(180)}`,
        1
      )
      const flaky = new FlakyExtractionProvider()

      const first = await harness.memoryEngine.reprocessChat(chat.chat_id, flaky, harness.settings)
      expect(first).toMatchObject({ segments: 2, processedSegments: 1, failedSegments: 1 })
      let checkpoint = await harness.repository.loadProcessingCheckpoint(chat.chat_id)
      expect(
        Object.values(checkpoint.segments)
          .map((segment) => segment.state)
          .sort()
      ).toEqual(['complete', 'failed'])

      const second = await harness.memoryEngine.reprocessChat(chat.chat_id, flaky, harness.settings)
      expect(second).toMatchObject({
        segments: 2,
        processedSegments: 1,
        skippedSegments: 1,
        failedSegments: 0
      })
      checkpoint = await harness.repository.loadProcessingCheckpoint(chat.chat_id)
      expect(
        Object.values(checkpoint.segments).every((segment) => segment.state === 'complete')
      ).toBe(true)
      expect(Object.values(checkpoint.segments).some((segment) => segment.attempts === 2)).toBe(
        true
      )

      const third = await harness.memoryEngine.reprocessChat(chat.chat_id, flaky, harness.settings)
      expect(third).toMatchObject({ processedSegments: 0, skippedSegments: 2 })
    } finally {
      await harness.cleanup()
    }
  })

  it('reprocesses one stable topic on demand and preserves user-confirmed memories', async () => {
    const harness = await createHarness({ segmentationCharacterBudget: 1000 })
    try {
      const project = await harness.repository.createProject(
        'Cedar Launch',
        'Cedar packaging rollout'
      )
      const chat = await harness.repository.createChat(project.project_id)
      await appendUser(
        harness,
        chat.chat_id,
        `We decided to use Cedar packaging. ${'cedar '.repeat(180)}`,
        0
      )
      await appendUser(
        harness,
        chat.chat_id,
        `We plan to ship Cedar labels tomorrow. ${'labels '.repeat(180)}`,
        1
      )
      await harness.memoryEngine.reprocessChat(chat.chat_id, harness.provider, harness.settings)
      const topic = harness.repository.listTopics(chat.chat_id)[0]!
      const initialId = topic.topic_id
      const memory = (await harness.repository.listMemories(chat.chat_id))[0]!
      await harness.memoryEngine.applyAction(memory.memory_id, { kind: 'confirm' })

      const one = await harness.memoryEngine.reprocessChat(
        chat.chat_id,
        harness.provider,
        harness.settings,
        undefined,
        undefined,
        { topicId: topic.topic_id, force: true }
      )
      expect(one).toMatchObject({ segments: 1, processedSegments: 1 })
      expect(harness.repository.listTopics(chat.chat_id)[0]?.topic_id).toBe(initialId)
      expect(
        (await harness.repository.listMemories()).find(
          (item) => item.memory_id === memory.memory_id
        )
      ).toMatchObject({
        state: 'confirmed',
        user_confirmed: true
      })
      expect(
        harness.repository
          .listEvidence(memory.memory_id)
          .some((item) => item.segment_id === initialId)
      ).toBe(true)
    } finally {
      await harness.cleanup()
    }
  })
})

async function appendUser(
  harness: Awaited<ReturnType<typeof createHarness>>,
  chatId: string,
  content: string,
  sequence: number
): Promise<void> {
  const now = new Date(Date.UTC(2026, 6, 23, 0, sequence)).toISOString()
  const message: Message = {
    message_id: createId('msg'),
    chat_id: chatId,
    role: 'user',
    content,
    created_at: now,
    updated_at: now,
    provider: 'test',
    model: 'test',
    status: 'complete',
    sequence,
    retrieved_memory_ids: [],
    retrieved_context_ids: []
  }
  await harness.repository.appendMessage(message)
}
