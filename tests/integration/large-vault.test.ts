import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { createId } from '../../src/shared/ids'
import type { Message } from '../../src/shared/schemas'
import { VaultRepository } from '../../src/main/storage/repository'
import { createHarness } from '../helpers'

describe('representative large vault', () => {
  it(
    'opens and searches hundreds of conversations and thousands of messages without a rebuild',
    { timeout: 90_000 },
    async () => {
      const harness = await createHarness()
      try {
        const projects = await Promise.all(
          ['Atlas', 'Boreal', 'Cedar', 'Delta'].map((name) =>
            harness.repository.createProject(`${name} Project`, `${name} synthetic workload`)
          )
        )
        const chats = []
        for (let index = 0; index < 200; index += 1) {
          chats.push(
            await harness.repository.createChat(projects[index % projects.length]!.project_id)
          )
        }
        for (let offset = 0; offset < chats.length; offset += 20) {
          await Promise.all(
            chats.slice(offset, offset + 20).map(async (chat, chatIndex) => {
              for (let sequence = 0; sequence < 10; sequence += 1) {
                const absolute = offset + chatIndex
                await harness.repository.appendMessage(
                  syntheticMessage(
                    chat.chat_id,
                    sequence,
                    sequence === 5
                      ? `We decided durable repeated choice LV-${absolute % 7} for conversation ${absolute}.`
                      : `Synthetic message ${sequence} for conversation ${absolute} searchable-corpus.`
                  )
                )
              }
            })
          )
        }
        expect(await harness.repository.listChats()).toHaveLength(200)
        const started = performance.now()
        const results = harness.repository.search({
          query: 'LV-3',
          allProjects: true,
          includeHistory: false,
          limit: 50
        })
        expect(results.length).toBeGreaterThan(20)
        expect(performance.now() - started).toBeLessThan(5_000)

        harness.repository.close()
        const reopened = new VaultRepository(harness.vault)
        const openStarted = performance.now()
        expect(await reopened.initialize()).toEqual({
          projects: 0,
          chats: 0,
          messages: 0,
          memories: 0
        })
        expect(performance.now() - openStarted).toBeLessThan(10_000)
        expect(await reopened.listChats()).toHaveLength(200)
        reopened.close()
      } finally {
        await harness.cleanup()
      }
    }
  )
})

function syntheticMessage(chatId: string, sequence: number, content: string): Message {
  const timestamp = new Date(Date.UTC(2026, 6, 23, 0, 0, sequence)).toISOString()
  return {
    message_id: createId('msg'),
    chat_id: chatId,
    role: sequence % 2 === 0 ? 'user' : 'assistant',
    content,
    created_at: timestamp,
    updated_at: timestamp,
    provider: 'synthetic',
    model: 'load-test',
    status: 'complete',
    sequence,
    retrieved_memory_ids: [],
    retrieved_context_ids: []
  }
}
