import type { AppSettings, Memory } from '../../shared/schemas'
import type { RetrievedContextItem } from '../../shared/contracts'
import { excerpt, keywords, normalizeForComparison } from '../../shared/text'
import type { AIProvider } from '../providers/provider'
import { VaultRepository } from '../storage/repository'

export class RetrievalEngine {
  constructor(private readonly repository: VaultRepository) {}

  async retrieve(
    query: string,
    projectId: string | null,
    settings: AppSettings,
    provider: AIProvider
  ): Promise<RetrievedContextItem[]> {
    if (settings.maximumRetrievedMemories === 0 || settings.retrievalCharacterBudget === 0) return []
    const memories = this.repository.listActiveMemories(projectId)
    if (memories.length === 0) return []
    let queryVector: number[] | null = null
    let vectors = new Map<string, number[]>()
    if (settings.semanticIndexingEnabled) {
      try {
        queryVector = (await provider.embed([query], settings.embeddingModel))[0] ?? null
        vectors = new Map(
          this.repository
            .getEmbeddings(settings.embeddingModel)
            .map((embedding) => [embedding.memoryId, embedding.vector])
        )
      } catch {
        queryVector = null
      }
    }

    const ranked = memories
      .map((memory) => ({
        memory,
        score: hybridScore(query, memory, projectId, queryVector, vectors.get(memory.memory_id))
      }))
      .filter(({ score }) => score > 0.04)
      .sort((a, b) => b.score - a.score)
      .slice(0, settings.maximumRetrievedMemories)

    const chats = new Map((await this.repository.listChats()).map((chat) => [chat.chat_id, chat]))
    const projects = new Map((await this.repository.listProjects()).map((project) => [project.project_id, project]))
    const items: RetrievedContextItem[] = []
    let usedCharacters = 0
    for (const { memory, score } of ranked) {
      const messages = await this.repository.readMessages(memory.chat_id)
      const sources = messages.filter((message) => memory.source_message_ids.includes(message.message_id))
      const sourceExcerpt = excerpt(sources.map((message) => message.content).join(' '), 320)
      const cost = memory.statement.length + sourceExcerpt.length
      if (items.length > 0 && usedCharacters + cost > settings.retrievalCharacterBudget) continue
      const chat = chats.get(memory.chat_id)
      items.push({
        memoryId: memory.memory_id,
        statement: memory.statement,
        memoryType: memory.type,
        projectId: memory.project_id,
        projectName: memory.project_id ? projects.get(memory.project_id)?.name ?? null : null,
        sourceChatId: memory.chat_id,
        sourceChatTitle: chat?.title ?? 'Unknown chat',
        sourceMessageIds: memory.source_message_ids,
        sourceExcerpt,
        timestamp: memory.effective_at,
        state: memory.state,
        score
      })
      usedCharacters += cost
    }
    return items
  }
}

export function hybridScore(
  query: string,
  memory: Memory,
  projectId: string | null,
  queryVector?: number[] | null,
  memoryVector?: number[]
): number {
  if (['superseded', 'rejected', 'deleted', 'disputed'].includes(memory.state)) return -1
  const normalizedQuery = normalizeForComparison(query)
  const normalizedStatement = normalizeForComparison(memory.statement)
  const queryWords = keywords(query)
  const statementWords = keywords(memory.statement)
  const intersection = [...queryWords].filter((word) => statementWords.has(word)).length
  const keywordScore = queryWords.size ? intersection / queryWords.size : 0
  const exactPhrase = normalizedQuery.length > 4 && normalizedStatement.includes(normalizedQuery) ? 1 : 0
  const semantic = queryVector && memoryVector ? Math.max(0, cosineSimilarity(queryVector, memoryVector)) : 0
  const project = projectId && memory.project_id === projectId ? 1 : memory.project_id === null ? 0.3 : 0
  const confirmation = memory.user_confirmed || memory.state === 'confirmed' ? 1 : 0
  const pinned = memory.pinned ? 1 : 0
  const ageDays = Math.max(0, (Date.now() - Date.parse(memory.updated_at)) / 86_400_000)
  const recency = 1 / (1 + ageDays / 180)
  const typeBoost = ['decision', 'instruction', 'preference', 'project_state'].includes(memory.type) ? 1 : 0.5
  return (
    keywordScore * 0.36 +
    semantic * 0.24 +
    project * 0.14 +
    exactPhrase * 0.08 +
    confirmation * 0.06 +
    pinned * 0.05 +
    recency * 0.04 +
    typeBoost * 0.03
  ) * memory.confidence
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length === 0) return 0
  let dot = 0
  let leftMagnitude = 0
  let rightMagnitude = 0
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    dot += a * b
    leftMagnitude += a * a
    rightMagnitude += b * b
  }
  return leftMagnitude && rightMagnitude ? dot / Math.sqrt(leftMagnitude * rightMagnitude) : 0
}
