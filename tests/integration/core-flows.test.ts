import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createHarness } from '../helpers'

describe('MemoryBridge core flows', () => {
  it('Flow A: creates a vault/project/chat, streams, persists, and indexes both messages', async () => {
    const harness = await createHarness()
    try {
      const project = await harness.repository.createProject('Launch research')
      const chat = await harness.repository.createChat(project.project_id)
      const result = await harness.chatService.sendMessage(
        chat.chat_id,
        'Summarize the launch brief.'
      )
      expect(result.assistantMessage.status).toBe('complete')
      const messages = await harness.repository.readMessages(chat.chat_id)
      expect(messages.map((message) => message.role)).toEqual(['user', 'assistant'])
      expect(messages.every((message) => message.status === 'complete')).toBe(true)
      expect(
        harness.repository.search({
          query: 'launch',
          projectId: project.project_id,
          includeHistory: false,
          limit: 20
        })
      ).not.toHaveLength(0)
    } finally {
      await harness.cleanup()
    }
  })

  it('Flow B: extracts an evidence-backed decision and retrieves it through FTS', async () => {
    const harness = await createHarness()
    try {
      const project = await harness.repository.createProject('Desktop MVP')
      const chat = await harness.repository.createChat(project.project_id)
      await harness.chatService.sendMessage(
        chat.chat_id,
        'We have decided to use Electron for the desktop MVP.'
      )
      const memories = await harness.repository.listMemories(chat.chat_id)
      expect(memories).toHaveLength(1)
      expect(memories[0]?.type).toBe('decision')
      expect(memories[0]?.source_message_ids).toHaveLength(1)
      const results = harness.repository.search({
        query: 'Electron',
        memoryType: 'decision',
        includeHistory: false,
        limit: 10
      })
      expect(
        results.some((result) => result.kind === 'memory' && result.chatId === chat.chat_id)
      ).toBe(true)
      expect(results.every((result) => result.kind === 'memory')).toBe(true)
      expect(
        harness.repository.search({
          query: 'Electron',
          memoryType: 'decision',
          fromDate: '2999-01-01',
          includeHistory: false,
          limit: 10
        })
      ).toHaveLength(0)
      const confirmed = await harness.memoryEngine.applyAction(memories[0]!.memory_id, {
        kind: 'confirm'
      })
      expect(
        confirmed.find((memory) => memory.memory_id === memories[0]!.memory_id)?.user_confirmed
      ).toBe(true)
      const corrected = await harness.memoryEngine.applyAction(memories[0]!.memory_id, {
        kind: 'edit',
        statement: 'Electron is the confirmed desktop MVP shell.'
      })
      expect(
        corrected.find((memory) => memory.memory_id === memories[0]!.memory_id)?.statement
      ).toContain('confirmed')
    } finally {
      await harness.cleanup()
    }
  })

  it('Flow C: a later confirmed quantity supersedes the old decision and default search hides history', async () => {
    const harness = await createHarness()
    try {
      const chat = await harness.repository.createChat()
      await harness.chatService.sendMessage(
        chat.chat_id,
        'We have decided the initial batch will contain 5,000 units.'
      )
      await harness.chatService.sendMessage(
        chat.chat_id,
        'We have decided the initial batch will contain 1,000–1,500 units.'
      )
      const memories = await harness.repository.listMemories(chat.chat_id)
      expect(memories).toHaveLength(2)
      expect(memories.find((memory) => memory.statement.includes('5,000'))?.state).toBe(
        'superseded'
      )
      expect(memories.find((memory) => memory.statement.includes('1,000'))?.state).toBe('active')
      const current = harness.repository
        .search({ query: 'initial batch', includeHistory: false, limit: 10 })
        .filter((result) => result.kind === 'memory')
      expect(current).toHaveLength(1)
      expect(current[0]?.excerpt).toContain('1,000')
    } finally {
      await harness.cleanup()
    }
  })

  it('Flow D: disconnect blocks provider calls and reconnect resumes without a fallback transcript', async () => {
    const harness = await createHarness()
    const manifest = join(harness.directory, 'memorybridge.vault.json')
    const parked = `${manifest}.offline`
    try {
      const chat = await harness.repository.createChat()
      await rename(manifest, parked)
      await expect(
        harness.chatService.sendMessage(chat.chat_id, 'This must not reach the provider.')
      ).rejects.toThrow()
      expect(harness.provider.callCount).toBe(0)
      await rename(parked, manifest)
      await harness.vault.open(harness.directory)
      const result = await harness.chatService.sendMessage(
        chat.chat_id,
        'The vault is connected again.'
      )
      expect(result.assistantMessage.status).toBe('complete')
      expect(
        (await harness.repository.readMessages(chat.chat_id)).filter(
          (message) => message.role === 'user'
        )
      ).toHaveLength(1)
    } finally {
      await rename(parked, manifest).catch(() => undefined)
      await harness.cleanup()
    }
  })

  it('Flow E: interrupted stream preserves partial output and retry does not duplicate the user message', async () => {
    const harness = await createHarness()
    try {
      const chat = await harness.repository.createChat()
      const first = await harness.chatService.sendMessage(
        chat.chat_id,
        'Explain recovery. [mock:interrupt]'
      )
      expect(first.assistantMessage.status).toBe('interrupted')
      expect(first.assistantMessage.content.length).toBeGreaterThan(0)
      const retried = await harness.chatService.retryMessage(
        chat.chat_id,
        first.userMessage.message_id
      )
      expect(retried.assistantMessage.status).toBe('complete')
      const messages = await harness.repository.readMessages(chat.chat_id)
      expect(messages.filter((message) => message.role === 'user')).toHaveLength(1)
      expect(messages.filter((message) => message.role === 'assistant')).toHaveLength(2)
    } finally {
      await harness.cleanup()
    }
  })
})
