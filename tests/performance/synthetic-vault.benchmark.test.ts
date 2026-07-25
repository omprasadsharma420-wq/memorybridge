import { performance } from 'node:perf_hooks'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { ImportService } from '../../src/main/ingestion/import-service'
import { VaultCapacityService } from '../../src/main/storage/capacity'
import { VaultRepository } from '../../src/main/storage/repository'
import {
  chatSchema,
  memorySchema,
  messageSchema,
  type Chat,
  type Memory,
  type Message
} from '../../src/shared/schemas'
import { createHarness } from '../helpers'

const CONVERSATIONS = 1_000
const MESSAGES_PER_CONVERSATION = 50

describe('1,000-conversation synthetic vault benchmark', () => {
  it('validates linear storage, restart, search, capacity, incremental import, and recovery', async () => {
    const harness = await createHarness()
    let repository = harness.repository
    const rssSamples = [process.memoryUsage().rss]
    try {
      const projects = []
      for (const name of ['Atlas', 'Boreal', 'Cedar', 'Delta', 'Everest']) {
        projects.push(
          await repository.createProject(`${name} Benchmark`, `${name} synthetic project`)
        )
      }

      const generationStarted = performance.now()
      await generateChats(harness.directory, projects, 0, CONVERSATIONS / 2)
      const halfBytes = await directoryBytes(join(harness.directory, 'chats'))
      rssSamples.push(process.memoryUsage().rss)
      await generateChats(harness.directory, projects, CONVERSATIONS / 2, CONVERSATIONS)
      const fullRawBytes = await directoryBytes(join(harness.directory, 'chats'))
      const generationMs = performance.now() - generationStarted
      rssSamples.push(process.memoryUsage().rss)
      process.stdout.write(
        `\nBENCHMARK_PHASE generation ${Math.round(generationMs)}ms ${fullRawBytes} bytes\n`
      )

      expect(fullRawBytes / halfBytes).toBeGreaterThan(1.8)
      expect(fullRawBytes / halfBytes).toBeLessThan(2.2)
      const transcript = await readFile(
        join(
          harness.directory,
          'chats',
          `${stableId('chat', 1)}--synthetic-conversation-0`,
          'transcript.jsonl'
        ),
        'utf8'
      )
      expect(transcript.trim().split('\n')).toHaveLength(MESSAGES_PER_CONVERSATION)
      expect(transcript.length).toBeLessThan(100_000)

      const indexStarted = performance.now()
      const indexed = await repository.rebuildIndex()
      const indexingMs = performance.now() - indexStarted
      process.stdout.write(`BENCHMARK_PHASE indexing ${Math.round(indexingMs)}ms\n`)
      expect(indexed).toMatchObject({
        projects: 5,
        chats: CONVERSATIONS,
        messages: CONVERSATIONS * MESSAGES_PER_CONVERSATION
      })
      rssSamples.push(process.memoryUsage().rss)

      const searchStarted = performance.now()
      const mixedResults = repository.search({
        query: 'निर्णय BENCH-742',
        allProjects: true,
        includeHistory: false,
        limit: 20
      })
      const searchMs = performance.now() - searchStarted
      expect(mixedResults.length).toBeGreaterThan(0)
      expect(searchMs).toBeLessThan(10_000)
      expect(
        repository.search({
          query: 'PROJECT-0-ONLY',
          projectId: projects[1]!.project_id,
          allProjects: false,
          includeHistory: false,
          limit: 20
        })
      ).toHaveLength(0)

      repository.close()
      repository = new VaultRepository(harness.vault)
      const startupStarted = performance.now()
      const startupResult = await repository.initialize()
      const startupMs = performance.now() - startupStarted
      process.stdout.write(`BENCHMARK_PHASE startup ${Math.round(startupMs)}ms\n`)
      expect(startupResult).toEqual({
        projects: 0,
        chats: 0,
        messages: 0,
        memories: 0
      })
      rssSamples.push(process.memoryUsage().rss)

      const firstArchive = harness.vault.path('import-inbox', `benchmark-import-${Date.now()}.zip`)
      const secondArchive = harness.vault.path(
        'import-inbox',
        `benchmark-import-updated-${Date.now()}.zip`
      )
      await writeFile(
        firstArchive,
        archive([
          importConversation('incremental-a', 'Original incremental content.'),
          importConversation('incremental-b', 'Unchanged incremental content.')
        ])
      )
      const firstImport = await new ImportService(harness.vault, repository).import(firstArchive)
      expect(firstImport.imported_count).toBe(2)
      await writeFile(
        secondArchive,
        archive([
          importConversation('incremental-a', 'Changed incremental content.'),
          importConversation('incremental-b', 'Unchanged incremental content.')
        ])
      )
      const laterImport = await new ImportService(harness.vault, repository).import(secondArchive)
      expect(laterImport).toMatchObject({ changed_count: 1, skipped_count: 1 })

      const capacityService = new VaultCapacityService(harness.vault, repository)
      const cancelled = new AbortController()
      cancelled.abort()
      await expect(
        capacityService.calculate({ refresh: true, signal: cancelled.signal })
      ).rejects.toThrow(/cancelled safely/i)
      const capacityStarted = performance.now()
      const capacity = await capacityService.calculate({ refresh: true })
      const capacityMs = performance.now() - capacityStarted
      const actualBytes = await directoryBytes(harness.directory)
      const tolerance = Math.max(16 * 1024, actualBytes * 0.01)
      expect(Math.abs(capacity.totalVaultBytes - actualBytes)).toBeLessThanOrEqual(tolerance)
      expect(capacity.chats).toBe(CONVERSATIONS + 2)
      expect(capacity.messages).toBe(CONVERSATIONS * MESSAGES_PER_CONVERSATION + 4)
      expect(capacity.memories).toBeGreaterThan(1_000)
      rssSamples.push(process.memoryUsage().rss)

      const peakObservedRss = Math.max(...rssSamples)
      const rssGrowth = peakObservedRss - rssSamples[0]!
      expect(rssGrowth).toBeLessThan(768 * 1024 * 1024)

      const result = {
        environment: `${process.platform} ${process.arch}; Node ${process.version}`,
        conversations: CONVERSATIONS + 2,
        messages: CONVERSATIONS * MESSAGES_PER_CONVERSATION + 4,
        projects: projects.length,
        memories: capacity.memories,
        generatedRawBytes: fullRawBytes,
        finalVaultBytes: capacity.totalVaultBytes,
        generationMs: Math.round(generationMs),
        indexingMs: Math.round(indexingMs),
        startupMs: Math.round(startupMs),
        searchMs: Number(searchMs.toFixed(2)),
        capacityMs: Math.round(capacityMs),
        peakObservedRssBytes: peakObservedRss,
        observedRssGrowthBytes: rssGrowth,
        linearGrowthRatio: Number((fullRawBytes / halfBytes).toFixed(3)),
        incrementalImport: {
          imported: firstImport.imported_count,
          changed: laterImport.changed_count,
          unchanged: laterImport.skipped_count
        }
      }
      process.stdout.write(`\nMEMORYBRIDGE_BENCHMARK_RESULT=${JSON.stringify(result)}\n`)
    } finally {
      repository.close()
      await harness.vault.disconnect()
      await harness.cleanup()
    }
  })
})

async function generateChats(
  root: string,
  projects: Array<{ project_id: string }>,
  start: number,
  end: number
): Promise<void> {
  for (let offset = start; offset < end; offset += 20) {
    const indexes = Array.from(
      { length: Math.min(20, end - offset) },
      (_, relativeIndex) => offset + relativeIndex
    )
    await Promise.all(
      indexes.map(async (index) => {
        const chatId = stableId('chat', index + 1)
        const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
        const project = projects[index % projects.length]!
        const chat = chatSchema.parse({
          chat_id: chatId,
          project_id: project.project_id,
          title: `Synthetic conversation ${index}`,
          slug: `synthetic-conversation-${index}`,
          created_at: timestamp,
          updated_at: timestamp,
          source_provider: 'synthetic-benchmark',
          source_conversation_id: `benchmark-${index}`,
          sync_state: 'imported',
          processing_state: 'processed'
        })
        const messages = Array.from({ length: MESSAGES_PER_CONVERSATION }, (_, sequence) =>
          syntheticMessage(index, chat, sequence, timestamp)
        )
        const memories = syntheticMemories(index, chat, messages, timestamp)
        const directory = join(root, 'chats', `${chat.chat_id}--${chat.slug}`)
        await mkdir(directory, { recursive: true })
        await Promise.all([
          writeFile(join(directory, 'metadata.json'), `${JSON.stringify(chat, null, 2)}\n`),
          writeFile(
            join(directory, 'transcript.jsonl'),
            `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`
          ),
          writeFile(
            join(directory, 'memories.json'),
            `${JSON.stringify({ schema_version: 1, memories }, null, 2)}\n`
          ),
          writeFile(
            join(directory, 'extractions.jsonl'),
            `${JSON.stringify({
              kind: 'metadata',
              schema_version: 1,
              created_at: timestamp
            })}\n`
          )
        ])
      })
    )
  }
}

function syntheticMessage(
  conversationIndex: number,
  chat: Chat,
  sequence: number,
  timestamp: string
): Message {
  const globalIndex = conversationIndex * MESSAGES_PER_CONVERSATION + sequence + 1
  const projectMarker = conversationIndex % 5 === 0 && sequence === 3 ? ' PROJECT-0-ONLY' : ''
  const language =
    sequence % 10 === 0
      ? `निर्णय BENCH-${conversationIndex}: भण्डारण सुरक्षित छ।`
      : sequence % 7 === 0
        ? `Mixed English-Nepali BENCH-${conversationIndex}: काम पूरा भयो।`
        : `Synthetic benchmark message ${sequence} for BENCH-${conversationIndex}.`
  return messageSchema.parse({
    message_id: stableId('msg', globalIndex),
    chat_id: chat.chat_id,
    role: sequence % 2 === 0 ? 'user' : 'assistant',
    content: `${language}${projectMarker}`,
    created_at: timestamp,
    updated_at: timestamp,
    provider: 'synthetic-benchmark',
    model: 'deterministic',
    status: 'complete',
    sequence,
    provider_message_id: `provider-${globalIndex}`
  })
}

function syntheticMemories(
  index: number,
  chat: Chat,
  messages: Message[],
  timestamp: string
): Memory[] {
  const base = index * 10 + 1
  const current = memorySchema.parse({
    memory_id: stableId('mem', base),
    type: 'decision',
    statement: `Active storage decision BENCH-${index}.`,
    project_id: chat.project_id,
    chat_id: chat.chat_id,
    source_message_ids: [messages[10]!.message_id],
    state: 'active',
    confidence: 0.95,
    created_at: timestamp,
    updated_at: timestamp,
    effective_at: timestamp,
    scope: { kind: 'project', project_id: chat.project_id! },
    source_chat_ids: [chat.chat_id],
    source_provider: 'synthetic-benchmark'
  })
  if (index % 10 !== 0) return [current]
  const historicalId = stableId('mem', base + 1)
  return [
    current,
    memorySchema.parse({
      ...current,
      memory_id: historicalId,
      statement: `Superseded storage decision BENCH-${index}.`,
      source_message_ids: [messages[11]!.message_id],
      state: 'superseded',
      superseded_by: current.memory_id
    }),
    memorySchema.parse({
      ...current,
      memory_id: stableId('mem', base + 2),
      type: 'completed_item',
      statement: `Completed benchmark work BENCH-${index}.`,
      source_message_ids: [messages[12]!.message_id],
      state: 'completed'
    }),
    memorySchema.parse({
      ...current,
      memory_id: stableId('mem', base + 3),
      type: 'commitment',
      statement: `Unresolved benchmark commitment BENCH-${index}.`,
      source_message_ids: [messages[13]!.message_id],
      state: 'needs_review',
      confidence: 0.6
    })
  ]
}

function stableId(prefix: 'chat' | 'msg' | 'mem', value: number): string {
  return `${prefix}_${value.toString(16).padStart(32, '0')}`
}

async function directoryBytes(root: string): Promise<number> {
  let total = 0
  const pending = [root]
  while (pending.length) {
    const directory = pending.pop()!
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) pending.push(absolute)
      else if (entry.isFile()) total += (await stat(absolute)).size
    }
  }
  return total
}

function archive(conversations: unknown[]): Uint8Array {
  return zipSync({ 'conversations.json': strToU8(JSON.stringify(conversations)) })
}

function importConversation(id: string, content: string): Record<string, unknown> {
  return {
    id,
    title: id,
    create_time: 1_700_000_000,
    current_node: `${id}-assistant`,
    mapping: {
      [`${id}-root`]: {
        id: `${id}-root`,
        parent: null,
        children: [`${id}-user`],
        message: null
      },
      [`${id}-user`]: {
        id: `${id}-user`,
        parent: `${id}-root`,
        children: [`${id}-assistant`],
        message: {
          id: `${id}-user-message`,
          author: { role: 'user' },
          create_time: 1_700_000_001,
          content: { content_type: 'text', parts: [content] }
        }
      },
      [`${id}-assistant`]: {
        id: `${id}-assistant`,
        parent: `${id}-user`,
        children: [],
        message: {
          id: `${id}-assistant-message`,
          author: { role: 'assistant' },
          create_time: 1_700_000_002,
          content: { content_type: 'text', parts: ['Acknowledged.'] }
        }
      }
    }
  }
}
