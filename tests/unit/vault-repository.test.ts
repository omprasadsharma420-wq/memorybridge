import { readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createId } from '../../src/shared/ids'
import { createHarness } from '../helpers'
import { VaultRepository } from '../../src/main/storage/repository'
import { VaultManager } from '../../src/main/storage/vault'

describe('vault and repository', () => {
  it('creates and reopens a manifest-identified writable vault with free space', async () => {
    const harness = await createHarness()
    try {
      const status = await harness.vault.status()
      expect(status.connected).toBe(true)
      expect(status.manifest?.vault_id).toMatch(/^vault_/)
      expect(status.freeBytes).toBeGreaterThan(0)
    } finally { await harness.cleanup() }
  })

  it('replays latest transcript snapshots and recovers streaming responses', async () => {
    const harness = await createHarness()
    try {
      const chat = await harness.repository.createChat()
      const now = new Date().toISOString()
      const assistant = {
        message_id: createId('msg'), chat_id: chat.chat_id, role: 'assistant' as const, content: 'part',
        created_at: now, updated_at: now, provider: 'mock', model: 'mock', status: 'streaming' as const,
        sequence: 0, retrieved_memory_ids: []
      }
      await harness.repository.appendMessage(assistant)
      await harness.repository.appendMessage({ ...assistant, content: 'partial response', updated_at: new Date().toISOString() })
      expect((await harness.repository.readMessages(chat.chat_id))[0]?.content).toBe('partial response')
      expect(await harness.repository.recoverInterruptedMessages()).toBe(1)
      expect((await harness.repository.readMessages(chat.chat_id))[0]?.status).toBe('interrupted')
    } finally { await harness.cleanup() }
  })

  it('detects a disconnected vault and refuses content writes', async () => {
    const harness = await createHarness()
    const manifest = join(harness.directory, 'memorybridge.vault.json')
    const parked = `${manifest}.offline`
    try {
      const chat = await harness.repository.createChat()
      await rename(manifest, parked)
      await expect(harness.chatService.sendMessage(chat.chat_id, 'hello')).rejects.toThrow(/unavailable|disconnected/i)
      expect(harness.provider.callCount).toBe(0)
      expect((await harness.vault.status()).connected).toBe(false)
    } finally {
      await rename(parked, manifest).catch(() => undefined)
      await harness.cleanup()
    }
  })

  it('rejects folders without a valid vault manifest', async () => {
    const harness = await createHarness()
    const invalid = join(harness.directory, 'not-a-vault')
    try {
      await expect(new VaultManager().open(invalid)).rejects.toThrow(/not a MemoryBridge vault/i)
    } finally { await harness.cleanup() }
  })

  it('parks a corrupt derived index and rebuilds it from authoritative files', async () => {
    const harness = await createHarness()
    try {
      const chat = await harness.repository.createChat()
      await harness.chatService.sendMessage(chat.chat_id, 'A durable transcript survives index loss.')
      harness.repository.close()
      await writeFile(join(harness.directory, 'indexes', 'memorybridge.sqlite'), 'not-a-sqlite-database')
      const rebuilt = new VaultRepository(harness.vault)
      const stats = await rebuilt.initialize()
      expect(stats.chats).toBe(1)
      expect(stats.messages).toBe(2)
      expect((await readdir(join(harness.directory, 'backups'))).some((name) => name.includes('.corrupt-'))).toBe(true)
      rebuilt.close()
    } finally { await harness.cleanup() }
  })
})
