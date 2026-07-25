import { startMcpServer } from './mcp/server'

const vaultArgumentIndex = process.argv.indexOf('--vault')
const vaultPath = vaultArgumentIndex >= 0 ? process.argv[vaultArgumentIndex + 1] : undefined

if (!vaultPath) {
  process.stderr.write('Usage: node mcp-server.js --vault <MemoryBridge vault path>\n')
  process.exitCode = 2
} else {
  void startMcpServer(vaultPath).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'MCP server failed to start.'
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  })
}
