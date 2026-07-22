import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { McpQueryService, type McpScope } from './query-service'

const scopeShape = {
  projectId: z.string().optional().describe('MemoryBridge project ID'),
  chatId: z.string().optional().describe('MemoryBridge conversation ID'),
  allProjects: z
    .boolean()
    .default(false)
    .describe('Must be explicitly true for cross-project results'),
  limit: z.number().int().min(1).max(50).default(10)
}

export async function startMcpServer(vaultPath: string): Promise<void> {
  const query = await McpQueryService.open(vaultPath)
  const server = new McpServer({ name: 'memorybridge', version: '0.2.0' })

  server.registerTool(
    'search_memory',
    {
      description: 'Search active MemoryBridge memories with citations and strict scope.',
      inputSchema: { query: z.string().min(1).max(500), ...scopeShape }
    },
    async ({ query: text, limit, ...scope }) => result(query.searchMemory(text, scope, limit))
  )
  server.registerTool(
    'get_current_project_state',
    {
      description: 'Get current state, constraints, and deadlines for one scope.',
      inputSchema: scopeShape
    },
    async ({ limit, ...scope }) =>
      result(query.getMemoriesByType(['project_state', 'constraint', 'deadline'], scope, limit))
  )
  server.registerTool(
    'get_decisions',
    { description: 'Get active decisions and agreements with citations.', inputSchema: scopeShape },
    async ({ limit, ...scope }) =>
      result(query.getMemoriesByType(['decision', 'agreement'], scope, limit))
  )
  server.registerTool(
    'get_open_questions',
    { description: 'Get unresolved questions and conflicts.', inputSchema: scopeShape },
    async ({ limit, ...scope }) =>
      result(query.getMemoriesByType(['open_question', 'unresolved_conflict'], scope, limit))
  )
  server.registerTool(
    'get_completed_items',
    { description: 'Get completed work with source citations.', inputSchema: scopeShape },
    async ({ limit, ...scope }) => result(query.getMemoriesByType(['completed_item'], scope, limit))
  )
  server.registerTool(
    'find_related_conversations',
    {
      description: 'Find related conversation titles within an explicit scope.',
      inputSchema: { query: z.string().min(1).max(500), ...scopeShape }
    },
    async ({ query: text, limit, ...scope }) =>
      result(query.findRelatedConversations(text, scope, limit))
  )
  server.registerTool(
    'get_chat_excerpt',
    {
      description: 'Get a bounded excerpt from one conversation; never dumps a whole vault.',
      inputSchema: {
        chatId: z.string().min(1),
        afterSequence: z.number().int().min(-1).default(-1),
        limit: z.number().int().min(1).max(50).default(20)
      }
    },
    async ({ chatId, afterSequence, limit }) =>
      result(query.getChatExcerpt(chatId, afterSequence, limit))
  )
  server.registerTool(
    'get_memory_evidence',
    {
      description: 'Get exact bounded evidence for one memory.',
      inputSchema: {
        memoryId: z.string().min(1),
        limit: z.number().int().min(1).max(50).default(20)
      }
    },
    async ({ memoryId, limit }) => result(query.getMemoryEvidence(memoryId, limit))
  )
  server.registerTool(
    'list_projects',
    {
      description: 'List MemoryBridge projects and conversation counts.',
      inputSchema: { limit: z.number().int().min(1).max(50).default(50) }
    },
    async ({ limit }) => result(query.listProjects(limit))
  )
  server.registerTool(
    'get_provider_memories',
    {
      description:
        'List provider-imported memory records for review; these are not silently treated as confirmed MemoryBridge memories.',
      inputSchema: scopeShape
    },
    async ({ limit, ...scope }) => result(query.listProviderMemories(scope, limit))
  )

  const transport = new StdioServerTransport()
  const close = async (): Promise<void> => {
    query.close()
    await server.close()
  }
  process.once('SIGINT', () => void close().finally(() => process.exit(0)))
  process.once('SIGTERM', () => void close().finally(() => process.exit(0)))
  await server.connect(transport)
}

function result(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] }
}

export type { McpScope }
