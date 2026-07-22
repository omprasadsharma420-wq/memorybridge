import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { createHarness } from '../helpers'
import { ImportService } from '../../src/main/ingestion/import-service'
import { VaultRepository } from '../../src/main/storage/repository'
import { VaultManager } from '../../src/main/storage/vault'
import { McpQueryService } from '../../src/main/mcp/query-service'

describe('production pivot integrity', () => {
  it('enforces project, conversation, and confirmed-global scope without cross-project relationships', async () => {
    const harness = await createHarness()
    try {
      const alpha = await harness.repository.createProject('Alpha')
      const beta = await harness.repository.createProject('Beta')
      const alphaChat = await harness.repository.createChat(alpha.project_id)
      const betaChat = await harness.repository.createChat(beta.project_id)
      const unassignedA = await harness.repository.createChat()
      const unassignedB = await harness.repository.createChat()
      await harness.chatService.sendMessage(
        alphaChat.chat_id,
        'We decided to use product ALPHA-77.'
      )
      await harness.chatService.sendMessage(betaChat.chat_id, 'We decided to use product BETA-88.')
      await harness.chatService.sendMessage(
        unassignedA.chat_id,
        'We decided the private label is Cedar.'
      )
      await harness.chatService.sendMessage(
        unassignedB.chat_id,
        'We decided the private label is Birch.'
      )

      const alphaMemory = (await harness.repository.listMemories(alphaChat.chat_id))[0]!
      const betaMemory = (await harness.repository.listMemories(betaChat.chat_id))[0]!
      expect(
        harness.repository
          .listActiveMemories(alpha.project_id, alphaChat.chat_id)
          .map((item) => item.memory_id)
      ).toContain(alphaMemory.memory_id)
      expect(
        harness.repository
          .listActiveMemories(alpha.project_id, alphaChat.chat_id)
          .map((item) => item.memory_id)
      ).not.toContain(betaMemory.memory_id)
      expect(
        harness.repository
          .listActiveMemories(null, unassignedA.chat_id)
          .some((item) => item.statement.includes('Birch'))
      ).toBe(false)

      await harness.memoryEngine.applyAction(alphaMemory.memory_id, {
        kind: 'merge',
        targetId: betaMemory.memory_id
      })
      expect((await harness.repository.listMemories(alphaChat.chat_id))[0]?.state).not.toBe(
        'superseded'
      )

      const mcp = await McpQueryService.open(harness.directory)
      expect(
        JSON.stringify(mcp.searchMemory('ALPHA-77', { projectId: beta.project_id }))
      ).not.toContain('ALPHA-77')

      await harness.memoryEngine.applyAction(alphaMemory.memory_id, {
        kind: 'set_scope',
        scope: { kind: 'global' }
      })
      expect(
        harness.repository
          .listActiveMemories(beta.project_id, betaChat.chat_id)
          .map((item) => item.memory_id)
      ).toContain(alphaMemory.memory_id)
      expect(
        JSON.stringify(mcp.searchMemory('ALPHA-77', { projectId: beta.project_id }))
      ).toContain('ALPHA-77')
      expect(mcp.searchMemory('product', { projectId: beta.project_id }, 1)).toHaveLength(1)
      mcp.close()
    } finally {
      await harness.cleanup()
    }
  })

  it('keeps multi-chat evidence and exact source navigation for a deduplicated memory', async () => {
    const harness = await createHarness()
    try {
      const project = await harness.repository.createProject('Shared evidence')
      const first = await harness.repository.createChat(project.project_id)
      const second = await harness.repository.createChat(project.project_id)
      await harness.chatService.sendMessage(
        first.chat_id,
        'We decided to use SQLite for the local index.'
      )
      await harness.chatService.sendMessage(
        second.chat_id,
        'We decided to use SQLite for the local index.'
      )
      const memories = await harness.repository.listMemories()
      expect(memories).toHaveLength(1)
      const evidence = harness.repository.listEvidence(memories[0]!.memory_id)
      expect(new Set(evidence.map((item) => item.chat_id))).toEqual(
        new Set([first.chat_id, second.chat_id])
      )
      expect(evidence.every((item) => item.exact_excerpt.includes('SQLite'))).toBe(true)
    } finally {
      await harness.cleanup()
    }
  })

  it('searches Unicode, Nepali, mixed language, diacritics, and product codes', async () => {
    const harness = await createHarness()
    try {
      const chat = await harness.repository.createChat()
      await harness.chatService.sendMessage(
        chat.chat_id,
        'हामीले काठमाडौं Café उत्पादन MB-42 प्रयोग गर्ने निर्णय गरेका छौं।'
      )
      for (const query of ['काठमाडौं', 'Café', 'Cafe', 'MB-42']) {
        expect(
          harness.repository
            .search({ query, chatId: chat.chat_id, includeHistory: false, limit: 10 })
            .some((item) => item.kind === 'message')
        ).toBe(true)
      }
    } finally {
      await harness.cleanup()
    }
  })

  it('writes streaming transcript deltas linearly and avoids startup rebuilds', async () => {
    const harness = await createHarness()
    try {
      const chat = await harness.repository.createChat()
      const input = `We decided to preserve this payload. ${'linear-stream '.repeat(500)}`
      await harness.chatService.sendMessage(chat.chat_id, input)
      const transcript = join(
        harness.directory,
        'chats',
        harness.repository.describeChatDirectory(chat.chat_id),
        'transcript.jsonl'
      )
      expect((await stat(transcript)).size).toBeLessThan(input.length * 5)
      expect((await readFile(transcript, 'utf8')).includes('message_patch')).toBe(true)

      harness.repository.close()
      const reopened = new VaultRepository(harness.vault)
      expect(await reopened.initialize()).toEqual({
        projects: 0,
        chats: 0,
        messages: 0,
        memories: 0
      })
      reopened.close()
    } finally {
      await harness.cleanup()
    }
  })

  it('imports synthetic ChatGPT ZIPs incrementally and exposes scoped MCP citations', async () => {
    const harness = await createHarness()
    try {
      const source = join(harness.directory, 'synthetic-chatgpt.zip')
      await writeFile(source, chatGptZip('First durable answer'))
      const imports = new ImportService(harness.vault, harness.repository)
      const preview = await imports.preview(source)
      expect(preview).toMatchObject({
        connectorId: 'chatgpt-export',
        conversations: 2,
        messages: 4,
        providerMemories: 1
      })
      expect(preview.warnings).toHaveLength(1)
      const first = await imports.import(source)
      expect(first).toMatchObject({ status: 'complete', imported_count: 2 })
      expect((await imports.import(source)).status).toBe('unchanged')

      await writeFile(source, chatGptZip('Changed durable answer'))
      const changed = await imports.import(source)
      expect(changed.changed_count).toBe(1)
      const importedChat = (await harness.repository.listChats()).find(
        (chat) => chat.source_conversation_id === 'conv-1'
      )!
      expect(
        (await harness.repository.readMessages(importedChat.chat_id)).filter(
          (message) => message.provider_message_id === 'assistant-1'
        )
      ).toHaveLength(1)

      const query = await McpQueryService.open(harness.directory)
      expect(JSON.stringify(query.getChatExcerpt(importedChat.chat_id, -1, 5))).toContain(
        'memorybridge://chat/'
      )
      expect(JSON.stringify(query.getChatExcerpt(importedChat.chat_id, -1, 5))).not.toContain(
        harness.directory
      )
      query.close()
    } finally {
      await harness.cleanup()
    }
  })

  it('handles lock conflicts as read-only and migrates a v1 manifest with backup', async () => {
    const harness = await createHarness()
    try {
      const second = new VaultManager()
      const conflict = await second.open(harness.directory)
      expect(conflict).toMatchObject({ connected: true, writable: false, reason: 'read-only' })
      second.disconnect()

      harness.repository.close()
      harness.vault.disconnect()
      const manifestPath = join(harness.directory, 'memorybridge.vault.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
      await writeFile(
        manifestPath,
        `${JSON.stringify({ ...manifest, schema_version: 1 }, null, 2)}\n`
      )
      const migrated = new VaultManager()
      expect((await migrated.open(harness.directory)).manifest?.schema_version).toBe(2)
      expect(
        (await readdir(join(harness.directory, 'backups'))).some((name) => name.includes('pre-v2'))
      ).toBe(true)
      migrated.disconnect()
    } finally {
      await harness.cleanup()
    }
  })
})

function chatGptZip(answer: string): Uint8Array {
  const conversations = [
    {
      id: 'conv-1',
      title: 'Synthetic branch',
      create_time: 1_700_000_000,
      mapping: {
        root: { id: 'root', parent: null, children: ['user-1'], message: null },
        'user-1': {
          parent: 'root',
          children: ['assistant-1', 'assistant-branch'],
          message: {
            id: 'user-1',
            author: { role: 'user' },
            create_time: 1_700_000_001,
            content: { content_type: 'text', parts: ['What did we decide?'] },
            status: 'finished_successfully',
            metadata: {}
          }
        },
        'assistant-1': {
          parent: 'user-1',
          children: [],
          message: {
            id: 'assistant-1',
            author: { role: 'assistant' },
            create_time: 1_700_000_002,
            content: { content_type: 'text', parts: [answer] },
            status: 'finished_successfully',
            metadata: { model_slug: 'synthetic-model' }
          }
        },
        'assistant-branch': {
          parent: 'user-1',
          children: [],
          message: {
            id: 'assistant-branch',
            author: { role: 'assistant' },
            create_time: 1_700_000_003,
            content: { content_type: 'text', parts: ['Alternate branch'] },
            status: 'finished_successfully',
            metadata: {}
          }
        }
      }
    },
    {
      id: 'conv-2',
      title: 'Second chat',
      mapping: {
        only: {
          parent: null,
          children: [],
          message: {
            id: 'only',
            author: { role: 'user' },
            content: { parts: ['Second conversation'] },
            status: 'finished_successfully',
            metadata: {}
          }
        }
      }
    },
    { id: 'malformed', title: 'Skipped', mapping: {} }
  ]
  return zipSync({
    'conversations.json': strToU8(JSON.stringify(conversations)),
    'memories.json': strToU8(JSON.stringify([{ content: 'User prefers concise responses.' }]))
  })
}
