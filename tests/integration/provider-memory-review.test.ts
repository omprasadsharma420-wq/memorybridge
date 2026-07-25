import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { AppService } from '../../src/main/app-service'
import { createId } from '../../src/shared/ids'
import { providerMemorySchema, type ProviderMemory } from '../../src/shared/schemas'
import { createHarness } from '../helpers'

describe('provider-memory review workflow', () => {
  it('supports confirm, edit, reject, delete, and same-scope supersession', async () => {
    const harness = await createHarness()
    try {
      const service = Object.create(AppService.prototype) as AppService
      Object.defineProperty(service, 'repository', { value: harness.repository })
      const records = await Promise.all(
        ['confirm', 'edit', 'reject', 'delete', 'old', 'replacement'].map((label) =>
          saveProviderMemory(harness, label)
        )
      )
      const [confirm, edit, reject, deleted, old, replacement] = records as [
        ProviderMemory,
        ProviderMemory,
        ProviderMemory,
        ProviderMemory,
        ProviderMemory,
        ProviderMemory
      ]

      await service.providerMemoryAction({
        providerMemoryId: confirm.provider_memory_id,
        action: 'confirm'
      })
      await service.providerMemoryAction({
        providerMemoryId: edit.provider_memory_id,
        action: 'edit',
        statement: 'Edited provider memory statement.'
      })
      await service.providerMemoryAction({
        providerMemoryId: reject.provider_memory_id,
        action: 'reject'
      })
      await service.providerMemoryAction({
        providerMemoryId: deleted.provider_memory_id,
        action: 'delete'
      })
      await service.providerMemoryAction({
        providerMemoryId: old.provider_memory_id,
        action: 'supersede',
        replacementId: replacement.provider_memory_id
      })

      const byId = new Map(
        harness.repository
          .listProviderMemories()
          .map((memory) => [memory.provider_memory_id, memory])
      )
      expect(byId.get(confirm.provider_memory_id)).toMatchObject({
        state: 'active',
        user_confirmed: true
      })
      expect(byId.get(edit.provider_memory_id)).toMatchObject({
        state: 'active',
        user_confirmed: true,
        statement: 'Edited provider memory statement.'
      })
      expect(byId.get(reject.provider_memory_id)?.state).toBe('rejected')
      expect(byId.get(deleted.provider_memory_id)?.state).toBe('deleted')
      expect(byId.get(old.provider_memory_id)).toMatchObject({
        state: 'superseded',
        superseded_by: replacement.provider_memory_id
      })

      const search = harness.repository.search({
        query: 'Edited provider',
        sourceType: 'provider_memory',
        allProjects: true,
        includeHistory: false,
        limit: 10
      })
      expect(search.some((result) => result.id === edit.provider_memory_id)).toBe(true)
      expect(
        search.every((result) => result.kind === 'provider_memory' && result.chatId === null)
      ).toBe(true)
    } finally {
      await harness.cleanup()
    }
  })
})

async function saveProviderMemory(
  harness: Awaited<ReturnType<typeof createHarness>>,
  label: string
): Promise<ProviderMemory> {
  const statement = `Provider ${label} review record.`
  const memory = providerMemorySchema.parse({
    provider_memory_id: createId('pmem'),
    provider: 'chatgpt',
    provider_record_id: `provider-${label}`,
    source_type: 'provider_saved_memory',
    statement,
    source_label: `Fixture ${label}`,
    scope: { kind: 'global' },
    state: 'needs_review',
    user_confirmed: false,
    imported_at: new Date().toISOString(),
    provider_updated_at: null,
    raw_source_reference: `fixture:${label}`,
    superseded_by: null,
    content_hash: createHash('sha256').update(statement).digest('hex')
  })
  await harness.repository.saveProviderMemory(memory)
  return memory
}
