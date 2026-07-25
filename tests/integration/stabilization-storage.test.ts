import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createId } from '../../src/shared/ids'
import { memorySchema, messageSchema } from '../../src/shared/schemas'
import { VaultCapacityService } from '../../src/main/storage/capacity'
import { VaultRepository } from '../../src/main/storage/repository'
import { VaultManager } from '../../src/main/storage/vault'
import { createHarness } from '../helpers'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      )
  )
})

describe('vault stabilization', () => {
  it('calculates categorized capacity without loading files and verifies writability', async () => {
    const harness = await createHarness()
    try {
      const chat = await harness.repository.createChat()
      const message = messageSchema.parse({
        message_id: createId('msg'),
        chat_id: chat.chat_id,
        role: 'user',
        content: 'Keep the stabilization benchmark evidence.',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        provider: 'native',
        model: 'local',
        status: 'complete',
        sequence: 0
      })
      await harness.repository.appendMessage(message)
      const memory = memorySchema.parse({
        memory_id: createId('mem'),
        type: 'decision',
        statement: 'Keep the stabilization benchmark evidence.',
        project_id: null,
        chat_id: chat.chat_id,
        source_message_ids: [message.message_id],
        state: 'confirmed',
        confidence: 1,
        created_at: message.created_at,
        updated_at: message.updated_at,
        effective_at: message.created_at,
        user_confirmed: true,
        scope: { kind: 'conversation', chat_id: chat.chat_id },
        confirmation_source: 'explicit_user_action',
        source_chat_ids: [chat.chat_id],
        source_type: 'manual'
      })
      await harness.repository.replaceChatMemories(chat.chat_id, [memory])
      harness.repository.storeEmbedding(memory.memory_id, 'test-embedding', [1, 0, 0], 'hash')
      await writeFile(harness.vault.path('attachments', 'sample.bin'), Buffer.alloc(1024, 7))
      await writeFile(harness.vault.path('imported', 'sample.zip'), Buffer.alloc(2048, 3))

      const service = new VaultCapacityService(harness.vault, harness.repository)
      const progress: string[] = []
      const stats = await service.calculate({
        refresh: true,
        onProgress: (event) => progress.push(event.status)
      })
      expect(stats.chats).toBe(1)
      expect(stats.messages).toBe(1)
      expect(stats.memories).toBe(1)
      expect(stats.transcriptBytes).toBeGreaterThan(0)
      expect(stats.structuredMemoryBytes).toBeGreaterThan(0)
      expect(stats.embeddingBytes).toBeGreaterThan(0)
      expect(stats.attachmentBytes).toBe(1024)
      expect(stats.importArchiveBytes).toBe(2048)
      expect(stats.totalVaultBytes).toBeGreaterThan(
        stats.attachmentBytes + stats.importArchiveBytes
      )
      expect(stats.freeDeviceBytes === null || stats.freeDeviceBytes > 0).toBe(true)
      expect(progress.at(-1)).toBe('complete')
      await expect(service.verifyWritable()).resolves.toMatchObject({ ok: true })
      await expect(
        stat(harness.vault.path('.memorybridge-write-check-does-not-exist.tmp'))
      ).rejects.toThrow()

      const cancelled = new AbortController()
      cancelled.abort()
      await expect(service.calculate({ refresh: true, signal: cancelled.signal })).rejects.toThrow(
        /cancelled safely/i
      )
    } finally {
      await harness.cleanup()
    }
  })

  it('migrates legacy provenance idempotently, backs it up, and rebuilds the index', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'memorybridge-migration-'))
    temporaryDirectories.push(directory)
    const vault = new VaultManager()
    await vault.create(directory)
    let repository = new VaultRepository(vault)
    try {
      await repository.initialize()
      const primaryChat = await repository.createChat()
      const corroboratingChat = await repository.createChat()
      const first = messageSchema.parse({
        message_id: createId('msg'),
        chat_id: primaryChat.chat_id,
        role: 'user',
        content: 'We decided the launch quantity is 500.',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        provider: 'chatgpt',
        model: 'imported',
        status: 'complete',
        sequence: 0
      })
      const second = messageSchema.parse({
        ...first,
        message_id: createId('msg'),
        chat_id: corroboratingChat.chat_id,
        content: 'Confirmed: the launch quantity remains 500.'
      })
      await repository.appendMessage(first)
      await repository.appendMessage(second)
      const confirmed = memorySchema.parse({
        memory_id: createId('mem'),
        type: 'decision',
        statement: 'The launch quantity is 500.',
        project_id: null,
        chat_id: primaryChat.chat_id,
        source_message_ids: [first.message_id, second.message_id],
        state: 'confirmed',
        confidence: 1,
        created_at: first.created_at,
        updated_at: first.updated_at,
        effective_at: first.created_at,
        user_confirmed: true
      })
      const unresolved = memorySchema.parse({
        ...confirmed,
        memory_id: createId('mem'),
        statement: 'A legacy claim has a missing source.',
        source_message_ids: [createId('msg')],
        state: 'active',
        user_confirmed: false
      })
      const memoryPath = vault.path(
        'chats',
        `${primaryChat.chat_id}--${primaryChat.slug}`,
        'memories.json'
      )
      await writeFile(
        memoryPath,
        `${JSON.stringify({ schema_version: 1, memories: [confirmed, unresolved] }, null, 2)}\n`,
        'utf8'
      )
      await rm(vault.path('migrations', 'v0.1-memory-evidence-to-v0.2.1.json'), {
        force: true
      })
      repository.close()

      repository = new VaultRepository(vault)
      const rebuild = await repository.initialize()
      expect(rebuild.memories).toBe(2)
      const migrated = await repository.listMemories(primaryChat.chat_id)
      const migratedConfirmed = migrated.find((memory) => memory.memory_id === confirmed.memory_id)!
      const migratedUnresolved = migrated.find(
        (memory) => memory.memory_id === unresolved.memory_id
      )!
      expect(migratedConfirmed.state).toBe('confirmed')
      expect(migratedConfirmed.confirmation_source).toBe('explicit_user_action')
      expect(migratedConfirmed.scope).toEqual({
        kind: 'conversation',
        chat_id: primaryChat.chat_id
      })
      expect(migratedConfirmed.source_chat_ids).toEqual(
        expect.arrayContaining([primaryChat.chat_id, corroboratingChat.chat_id])
      )
      expect(repository.listEvidence(confirmed.memory_id)).toHaveLength(2)
      expect(migratedUnresolved.state).toBe('needs_review')
      expect(migratedUnresolved.tags).toContain('migration-evidence-needs-review')

      const reportPath = vault.path('migrations', 'v0.1-memory-evidence-to-v0.2.1.json')
      const firstReport = JSON.parse(await readFile(reportPath, 'utf8')) as {
        status: string
        backupDirectory: string
        evidenceCreated: number
      }
      expect(firstReport).toMatchObject({
        status: 'complete',
        evidenceCreated: 2
      })
      await expect(stat(vault.path('backups', firstReport.backupDirectory))).resolves.toBeDefined()

      const secondRun = await repository.migrateLegacyMemoryProvenance()
      expect(secondRun.performed).toBe(false)
      expect(repository.listEvidence(confirmed.memory_id)).toHaveLength(2)

      await writeFile(
        reportPath,
        `${JSON.stringify({
          migration: 'v0.1-memory-evidence-to-v0.2.1',
          status: 'started',
          startedAt: new Date().toISOString(),
          backupDirectory: 'interrupted-test'
        })}\n`,
        'utf8'
      )
      const recovered = await repository.migrateLegacyMemoryProvenance()
      expect(recovered).toMatchObject({ status: 'complete', performed: true })
      expect(repository.listEvidence(confirmed.memory_id)).toHaveLength(2)
    } finally {
      repository.close()
      await vault.disconnect()
    }
  })

  it('heartbeats a lock, exposes honest conflicts, and never removes a foreign lock', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'memorybridge-lock-'))
    temporaryDirectories.push(directory)
    const owner = new VaultManager({ heartbeatIntervalMs: 500, lockStaleMs: 2_000 })
    const observer = new VaultManager({ heartbeatIntervalMs: 500, lockStaleMs: 2_000 })
    await owner.create(directory)
    try {
      const lockPath = join(directory, '.memorybridge.lock.json')
      const initial = JSON.parse(await readFile(lockPath, 'utf8')) as {
        heartbeat_at: string
        ownership_token: string
      }
      await waitFor(async () => {
        const current = JSON.parse(await readFile(lockPath, 'utf8')) as {
          heartbeat_at: string
        }
        return current.heartbeat_at !== initial.heartbeat_at
      })

      const conflict = await observer.open(directory)
      expect(conflict).toMatchObject({
        connected: true,
        writable: false,
        reason: 'locked'
      })
      await observer.disconnect()
      expect(
        (JSON.parse(await readFile(lockPath, 'utf8')) as { ownership_token: string })
          .ownership_token
      ).toBe(initial.ownership_token)

      const lastOwnedHeartbeat = (
        JSON.parse(await readFile(lockPath, 'utf8')) as { heartbeat_at: string }
      ).heartbeat_at
      await waitFor(async () => {
        const current = JSON.parse(await readFile(lockPath, 'utf8')) as {
          heartbeat_at: string
        }
        return current.heartbeat_at !== lastOwnedHeartbeat
      })
      const foreign = {
        ...(JSON.parse(await readFile(lockPath, 'utf8')) as Record<string, unknown>),
        ownership_token: 'foreign-owner'
      }
      await writeFile(lockPath, `${JSON.stringify(foreign, null, 2)}\n`, 'utf8')
      await waitFor(async () => (await owner.status()).heartbeatHealthy === false)
      await owner.disconnect()
      expect(
        (JSON.parse(await readFile(lockPath, 'utf8')) as { ownership_token: string })
          .ownership_token
      ).toBe('foreign-owner')
    } finally {
      await observer.disconnect()
      await owner.disconnect()
    }
  })
})

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Timed out waiting for condition.')
}
