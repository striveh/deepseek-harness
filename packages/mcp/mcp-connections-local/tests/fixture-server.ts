/** Minimal dynamic-name MCP stdio server used by the manager lifecycle tests. */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const toolName = process.argv[2] ?? 'fixture'
const slowClose = process.argv[3] === 'slow-close'
const server = new McpServer(
  { name: `managed-${toolName}`, version: '1.0.0' },
  { capabilities: { tools: {} } },
)

server.registerTool(toolName, {
  description: `Managed fixture tool ${toolName}.`,
  inputSchema: {},
}, async () => ({ content: [{ type: 'text', text: toolName }] }))

if (slowClose) {
  process.on('SIGTERM', () => { setTimeout(() => process.exit(0), 250) })
  // Keep the child alive after stdio closes until the transport's termination
  // signal reaches the handler above.
  setInterval(() => {}, 60_000)
}

await server.connect(new StdioServerTransport())
