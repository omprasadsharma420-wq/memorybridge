import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { createHarness } from '../helpers'
import { createId } from '../../src/shared/ids'
import { memorySchema } from '../../src/shared/schemas'
import { McpQueryService } from '../../src/main/mcp/query-service'
import { createMcpServer } from '../../src/main/mcp/server'

describe('MCP server contract', () => {
  it('returns bounded exact evidence and rejects malformed identifiers through the actual protocol', async () => {
    const harness = await createHarness()
    let query: McpQueryService | undefined
    const client = new Client({ name: 'memorybridge-test', version: '1.0.0' })
    try {
      const project = await harness.repository.createProject('MCP Project')
      const chat = await harness.repository.createChat(project.project_id)
      await harness.chatService.sendMessage(
        chat.chat_id,
        'We decided to use SQLite for the MCP evidence index.'
      )
      await harness.chatService.sendMessage(chat.chat_id, 'What is the launch owner?')
      await harness.chatService.sendMessage(chat.chat_id, 'The launch report is due by 2026-09-15.')
      const memory = (await harness.repository.listMemories(chat.chat_id))[0]!
      const otherProject = await harness.repository.createProject('Other MCP Project')
      const otherChat = await harness.repository.createChat(otherProject.project_id)
      await harness.chatService.sendMessage(
        otherChat.chat_id,
        'We decided the private launch code is ORCHID-91.'
      )
      const otherMemory = (await harness.repository.listMemories(otherChat.chat_id))[0]!
      const historicalMemory = memorySchema.parse({
        ...otherMemory,
        memory_id: createId('mem'),
        statement: 'The historical private launch code was AZURE-10.',
        state: 'superseded',
        superseded_by: otherMemory.memory_id,
        evidence_ids: []
      })
      const disputedMemory = memorySchema.parse({
        ...otherMemory,
        memory_id: createId('mem'),
        statement: 'The disputed fallback launch code is AMBER-22.',
        state: 'disputed',
        evidence_ids: []
      })
      await harness.repository.replaceChatMemories(otherChat.chat_id, [
        otherMemory,
        historicalMemory,
        disputedMemory
      ])
      query = await McpQueryService.open(harness.directory)
      const server = createMcpServer(query)
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await server.connect(serverTransport)
      await client.connect(clientTransport)
      const tools = await client.listTools()
      expect(tools.tools).toHaveLength(10)
      expect(tools.tools.some((tool) => /file|filesystem|path|directory/i.test(tool.name))).toBe(
        false
      )

      const search = await client.callTool({
        name: 'search_memory',
        arguments: { query: 'SQLite', projectId: project.project_id, limit: 1 }
      })
      const payload = parseText(search)
      expect(payload).toHaveLength(1)
      expect(payload[0]).toMatchObject({
        memoryId: memory.memory_id,
        evidence: [
          expect.objectContaining({
            excerpt: expect.stringContaining('MCP evidence index'),
            sourceAvailable: true
          })
        ]
      })
      expect(JSON.stringify(payload)).toContain('memorybridge://chat/')
      expect(JSON.stringify(payload)).not.toContain(harness.directory)

      const malformed = await client.callTool({
        name: 'get_memory_evidence',
        arguments: { memoryId: 'not-a-memory-id', limit: 500 }
      })
      expect(malformed.isError).toBe(true)

      const evidence = parseText(
        await client.callTool({
          name: 'get_memory_evidence',
          arguments: { memoryId: memory.memory_id, projectId: project.project_id, limit: 1 }
        })
      )
      expect(evidence).toHaveLength(1)
      expect(
        parseText(
          await client.callTool({
            name: 'get_memory_evidence',
            arguments: { memoryId: memory.memory_id, limit: 1 }
          })
        )
      ).toHaveLength(0)
      expect(
        parseText(
          await client.callTool({
            name: 'get_memory_evidence',
            arguments: {
              memoryId: otherMemory.memory_id,
              projectId: project.project_id,
              limit: 10
            }
          })
        )
      ).toHaveLength(0)
      expect(
        parseText(
          await client.callTool({
            name: 'get_chat_excerpt',
            arguments: {
              chatId: otherChat.chat_id,
              projectId: project.project_id,
              limit: 10
            }
          })
        )
      ).toHaveLength(0)
      expect(
        parseText(
          await client.callTool({
            name: 'get_chat_excerpt',
            arguments: {
              chatId: otherChat.chat_id,
              projectId: otherProject.project_id,
              limit: 10
            }
          })
        )
      ).not.toHaveLength(0)
      expect(
        parseText(
          await client.callTool({
            name: 'search_memory',
            arguments: {
              query: 'AZURE-10',
              projectId: otherProject.project_id,
              limit: 10
            }
          })
        )
      ).toHaveLength(0)
      expect(
        parseText(
          await client.callTool({
            name: 'search_memory',
            arguments: {
              query: 'AZURE-10',
              projectId: otherProject.project_id,
              includeHistorical: true,
              limit: 10
            }
          })
        )
      ).toHaveLength(1)
      expect(
        parseText(
          await client.callTool({
            name: 'search_memory',
            arguments: {
              query: 'AMBER-22',
              projectId: otherProject.project_id,
              limit: 10
            }
          })
        )
      ).toHaveLength(0)
      expect(
        parseText(
          await client.callTool({
            name: 'search_memory',
            arguments: {
              query: 'AMBER-22',
              projectId: otherProject.project_id,
              includeDisputed: true,
              limit: 10
            }
          })
        )
      ).toHaveLength(1)
      expect(
        parseText(
          await client.callTool({
            name: 'get_decisions',
            arguments: { projectId: project.project_id, limit: 10 }
          })
        ).some((item) => hasType(item, 'decision'))
      ).toBe(true)
      expect(
        parseText(
          await client.callTool({
            name: 'get_open_questions',
            arguments: { projectId: project.project_id, limit: 10 }
          })
        ).some((item) => hasType(item, 'open_question'))
      ).toBe(false)
      expect(
        parseText(
          await client.callTool({
            name: 'get_open_questions',
            arguments: {
              projectId: project.project_id,
              includeNeedsReview: true,
              limit: 10
            }
          })
        ).some((item) => hasType(item, 'open_question'))
      ).toBe(true)
      expect(
        parseText(
          await client.callTool({
            name: 'get_current_project_state',
            arguments: {
              projectId: project.project_id,
              includeNeedsReview: true,
              limit: 10
            }
          })
        ).some((item) => hasType(item, 'deadline'))
      ).toBe(true)
      await client.close()
      await server.close()
    } finally {
      query?.close()
      await harness.cleanup()
    }
  })

  it('refuses to open a disconnected or non-vault directory', async () => {
    const harness = await createHarness()
    try {
      await expect(McpQueryService.open(`${harness.directory}-missing`)).rejects.toThrow()
    } finally {
      await harness.cleanup()
    }
  })
})

function parseText(result: Awaited<ReturnType<Client['callTool']>>): unknown[] {
  const content = result.content as Array<{ type: string; text?: string }>
  const block = content.find((item) => item.type === 'text')
  if (!block?.text) throw new Error('MCP tool returned no text block.')
  return JSON.parse(block.text) as unknown[]
}

function hasType(value: unknown, type: string): boolean {
  return Boolean(value && typeof value === 'object' && (value as { type?: unknown }).type === type)
}
