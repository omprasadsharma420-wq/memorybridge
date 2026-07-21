import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { appSettingsSchema, type AppSettings } from '../src/shared/schemas'
import { ChatService } from '../src/main/chat-service'
import { MemoryEngine } from '../src/main/memory/memory-engine'
import { MockProvider } from '../src/main/providers/mock-provider'
import { RetrievalEngine } from '../src/main/retrieval/retrieval-engine'
import { VaultRepository } from '../src/main/storage/repository'
import { VaultManager } from '../src/main/storage/vault'

export interface TestHarness {
  directory: string
  vault: VaultManager
  repository: VaultRepository
  provider: MockProvider
  memoryEngine: MemoryEngine
  chatService: ChatService
  settings: AppSettings
  cleanup(): Promise<void>
}

export async function createHarness(patch: Partial<AppSettings> = {}): Promise<TestHarness> {
  const directory = await mkdtemp(join(tmpdir(), 'memorybridge-test-'))
  const vault = new VaultManager()
  await vault.create(directory)
  const repository = new VaultRepository(vault)
  await repository.initialize()
  const provider = new MockProvider()
  const memoryEngine = new MemoryEngine(repository)
  const settings = appSettingsSchema.parse({ ...patch, mockMode: true, provider: 'mock' })
  const chatService = new ChatService(
    repository,
    memoryEngine,
    new RetrievalEngine(repository),
    () => settings,
    async () => provider
  )
  return {
    directory,
    vault,
    repository,
    provider,
    memoryEngine,
    chatService,
    settings,
    async cleanup() {
      repository.close()
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  }
}
