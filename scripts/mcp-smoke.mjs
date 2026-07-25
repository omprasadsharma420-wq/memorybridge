import { resolve } from 'node:path'
import process from 'node:process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const requestedVault = process.argv[2]
if (!requestedVault) {
  process.stderr.write(
    'Usage: npm run mcp:smoke -- "C:\\path\\to\\MemoryBridge vault"\n' +
      '   or: npm run mcp:smoke -- --self-test\n'
  )
  process.exit(2)
}

const temporaryVault = requestedVault === '--self-test' ? await createSelfTestVault() : null
const vaultPath = temporaryVault ?? requestedVault
const serverPath = resolve('out', 'main', 'mcp-server.js')
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath, '--vault', resolve(vaultPath)],
  stderr: 'pipe'
})
const client = new Client({ name: 'memorybridge-smoke', version: '0.2.1' })

try {
  await client.connect(transport)
  const tools = await client.listTools()
  const projects = await client.callTool({
    name: 'list_projects',
    arguments: { limit: 3 }
  })
  if (tools.tools.length !== 10) {
    throw new Error(`Expected 10 MCP tools, received ${tools.tools.length}.`)
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        transport: 'stdio',
        tools: tools.tools.map((tool) => tool.name),
        listProjectsResponse: projects.content
      },
      null,
      2
    )}\n`
  )
} finally {
  await client.close().catch(() => undefined)
  if (temporaryVault) {
    await rm(temporaryVault, { recursive: true, force: true })
  }
}

async function createSelfTestVault() {
  const root = await mkdtemp(resolve(tmpdir(), 'memorybridge-mcp-smoke-'))
  await mkdir(resolve(root, 'indexes'), { recursive: true })
  const now = new Date().toISOString()
  await writeFile(
    resolve(root, 'memorybridge.vault.json'),
    `${JSON.stringify(
      {
        vault_id: 'vault_00000000000000000000000000000001',
        schema_version: 2,
        created_at: now,
        application: 'MemoryBridge',
        application_version: '0.2.1'
      },
      null,
      2
    )}\n`
  )
  const database = new DatabaseSync(resolve(root, 'indexes', 'memorybridge.sqlite'))
  database.exec(`
    CREATE TABLE projects (
      project_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE chats (
      chat_id TEXT PRIMARY KEY,
      project_id TEXT
    );
    INSERT INTO projects VALUES (
      'project_00000000000000000000000000000001',
      'MCP smoke project',
      'Synthetic, non-private transport fixture',
      '${now}'
    );
  `)
  database.close()
  return root
}
