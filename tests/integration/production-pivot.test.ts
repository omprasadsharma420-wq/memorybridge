import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { DatabaseSync } from 'node:sqlite'
import { createId } from '../../src/shared/ids'
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

  it('does not deduplicate, supersede, or complete memories across similar projects', async () => {
    const harness = await createHarness()
    try {
      const alpha = await harness.repository.createProject(
        'Launch Alpha',
        'Shared launch application'
      )
      const beta = await harness.repository.createProject(
        'Launch Beta',
        'Shared launch application'
      )
      const alphaChat = await harness.repository.createChat(alpha.project_id)
      const betaChat = await harness.repository.createChat(beta.project_id)
      await harness.chatService.sendMessage(
        alphaChat.chat_id,
        'We decided the shared launch quantity is 50 units.'
      )
      await harness.chatService.sendMessage(
        betaChat.chat_id,
        'We decided the shared launch quantity is 50 units.'
      )
      expect(
        (await harness.repository.listMemories()).filter((memory) =>
          memory.statement.includes('50 units')
        )
      ).toHaveLength(2)

      await harness.chatService.sendMessage(
        alphaChat.chat_id,
        'We plan to submit the shared launch application tomorrow.'
      )
      await harness.chatService.sendMessage(
        betaChat.chat_id,
        'The shared launch application was submitted today.'
      )
      const commitment = (await harness.repository.listMemories(alphaChat.chat_id)).find(
        (memory) => memory.type === 'commitment'
      )
      expect(commitment?.state).toBe('active')

      await harness.chatService.sendMessage(
        betaChat.chat_id,
        'We decided the shared launch quantity is now 75 units.'
      )
      const alphaQuantity = (await harness.repository.listMemories(alphaChat.chat_id)).find(
        (memory) => memory.statement.includes('50 units')
      )
      expect(['active', 'confirmed']).toContain(alphaQuantity?.state)
      expect(alphaQuantity?.superseded_by).toBeNull()
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

  it('keeps several same-chat evidence messages and excludes assistant-only or interrupted claims', async () => {
    const harness = await createHarness()
    try {
      const chat = await harness.repository.createChat()
      await harness.chatService.sendMessage(chat.chat_id, 'We decided to use evidence bundle EB-9.')
      await harness.chatService.sendMessage(chat.chat_id, 'We decided to use evidence bundle EB-9.')
      const memory = (await harness.repository.listMemories(chat.chat_id)).find((item) =>
        item.statement.includes('EB-9')
      )!
      expect(harness.repository.listEvidence(memory.memory_id)).toHaveLength(2)

      const now = new Date().toISOString()
      await harness.repository.appendMessage({
        message_id: createId('msg'),
        chat_id: chat.chat_id,
        role: 'assistant',
        content: 'We decided to adopt assistant-only option AO-7.',
        created_at: now,
        updated_at: now,
        provider: 'test',
        model: 'test',
        status: 'complete',
        sequence: 20,
        retrieved_memory_ids: [],
        retrieved_context_ids: []
      })
      await harness.repository.appendMessage({
        message_id: createId('msg'),
        chat_id: chat.chat_id,
        role: 'user',
        content: 'We decided to adopt interrupted option IO-8.',
        created_at: now,
        updated_at: now,
        provider: 'test',
        model: 'test',
        status: 'interrupted',
        sequence: 21,
        retrieved_memory_ids: [],
        retrieved_context_ids: []
      })
      await harness.memoryEngine.extractTurn(chat.chat_id, harness.provider, harness.settings)
      expect(JSON.stringify(await harness.repository.listMemories(chat.chat_id))).not.toContain(
        'AO-7'
      )
      expect(JSON.stringify(await harness.repository.listMemories(chat.chat_id))).not.toContain(
        'IO-8'
      )
    } finally {
      await harness.cleanup()
    }
  })

  it('rejects fabricated evidence and reports a missing indexed source safely', async () => {
    const harness = await createHarness()
    try {
      const chat = await harness.repository.createChat()
      await harness.chatService.sendMessage(chat.chat_id, 'We decided to use local evidence IDs.')
      const memory = (await harness.repository.listMemories(chat.chat_id))[0]!
      const evidence = harness.repository.listEvidence(memory.memory_id)[0]!
      await expect(
        harness.repository.saveEvidence([
          {
            ...evidence,
            evidence_id: createId('evidence'),
            message_id: createId('msg')
          }
        ])
      ).rejects.toThrow(/message/i)

      const database = new DatabaseSync(join(harness.directory, 'indexes', 'memorybridge.sqlite'))
      database.prepare('DELETE FROM messages WHERE message_id = ?').run(evidence.message_id)
      database.close()
      expect(harness.repository.listEvidence(memory.memory_id)[0]).toMatchObject({
        source_available: false,
        exact_excerpt: expect.stringContaining('local evidence IDs')
      })
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
        messages: 3,
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
      expect(
        JSON.stringify(query.getChatExcerpt(importedChat.chat_id, { allProjects: true }, -1, 5))
      ).toContain('memorybridge://chat/')
      expect(
        JSON.stringify(query.getChatExcerpt(importedChat.chat_id, { allProjects: true }, -1, 5))
      ).not.toContain(harness.directory)
      query.close()
    } finally {
      await harness.cleanup()
    }
  })

  it('resumes partial imports and recovers a repaired watched-inbox file', async () => {
    const harness = await createHarness()
    try {
      const source = join(harness.directory, 'resume.json')
      const conversations = [0, 1, 2].map((index) => ({
        id: `resume-${index}`,
        title: `Resume ${index}`,
        messages: [{ id: `message-${index}`, role: 'user', content: `Durable record ${index}` }]
      }))
      await writeFile(source, JSON.stringify(conversations))
      const imports = new ImportService(harness.vault, harness.repository)
      const original = harness.repository.upsertCanonicalConversation.bind(harness.repository)
      let calls = 0
      harness.repository.upsertCanonicalConversation = async (...arguments_) => {
        calls += 1
        if (calls === 2) throw new Error('Synthetic per-conversation failure')
        return original(...arguments_)
      }
      const partial = await imports.import(source)
      expect(partial).toMatchObject({ status: 'partial', imported_count: 2, error_count: 1 })
      expect(partial.checkpoint.failedIndexes).toEqual([1])

      harness.repository.upsertCanonicalConversation = original
      const resumed = await imports.import(source)
      expect(resumed).toMatchObject({ status: 'complete', imported_count: 1, skipped_count: 2 })
      expect(resumed.checkpoint.completedIndexes).toEqual(expect.arrayContaining([0, 1, 2]))
      expect(
        (await harness.repository.listChats()).filter((chat) => chat.source_provider === 'generic')
      ).toHaveLength(3)

      const inboxFile = join(harness.directory, 'import-inbox', 'recover.json')
      await writeFile(inboxFile, '{malformed')
      expect((await imports.scanInbox())[0]).toMatchObject({ status: 'failed', error_count: 1 })
      expect(
        (await readdir(join(harness.directory, 'failed-imports'))).some((name) =>
          name.endsWith('--recover.json')
        )
      ).toBe(true)
      await writeFile(
        inboxFile,
        JSON.stringify([
          {
            id: 'recovered',
            title: 'Recovered',
            messages: [{ role: 'user', content: 'Recovered import' }]
          }
        ])
      )
      expect((await imports.scanInbox())[0]?.status).toBe('complete')
      expect(
        (await readdir(join(harness.directory, 'imported'))).some((name) =>
          name.endsWith('--recover.json')
        )
      ).toBe(true)
    } finally {
      await harness.cleanup()
    }
  })

  it('rejects malformed archives and unsupported files with actionable errors', async () => {
    const harness = await createHarness()
    try {
      const imports = new ImportService(harness.vault, harness.repository)
      const malformed = join(harness.directory, 'broken.zip')
      const unsupported = join(harness.directory, 'unsupported.exe')
      await writeFile(malformed, 'not a zip')
      await writeFile(unsupported, 'content')
      await expect(imports.preview(malformed)).rejects.toThrow(/could not be read/i)
      await expect(imports.preview(unsupported)).rejects.toThrow(/ZIP, JSON, JSONL/i)
    } finally {
      await harness.cleanup()
    }
  })

  it('labels lock conflicts honestly and migrates a v1 manifest with backup', async () => {
    const harness = await createHarness()
    try {
      const second = new VaultManager()
      const conflict = await second.open(harness.directory)
      expect(conflict).toMatchObject({ connected: true, writable: false, reason: 'locked' })
      await second.disconnect()

      harness.repository.close()
      await harness.vault.disconnect()
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
      await migrated.disconnect()
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
      current_node: 'assistant-1',
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
      current_node: 'only',
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
