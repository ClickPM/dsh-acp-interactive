/** Real stdio MCP fixture used by the ACP session-lifecycle tests. */

import { appendFile } from 'node:fs/promises'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const marker = process.env.MCP_SESSION_MARKER ?? 'fixture'
const lifecycleFile = process.env.MCP_LIFECYCLE_FILE

async function lifecycle(value) {
  if (lifecycleFile !== undefined) await appendFile(lifecycleFile, `${marker}:${value}\n`)
}

await lifecycle(`started:${process.pid}`)
process.once('SIGTERM', () => { void lifecycle('stopped').finally(() => process.exit(0)) })
process.once('SIGINT', () => { void lifecycle('stopped').finally(() => process.exit(0)) })

const server = new McpServer(
  { name: `acp-session-${marker}`, version: '1.0.0' },
  { capabilities: { tools: {} } },
)

server.registerTool('echo', {
  description: 'Echoes the session marker and supplied text.',
  inputSchema: { text: z.string() },
}, async ({ text }) => ({
  content: [{ type: 'text', text: `${marker}:${text}` }],
}))

server.registerTool('wait', {
  description: 'Waits until the exact tool request is canceled.',
  inputSchema: {},
}, async (_args, extra) => {
  await lifecycle('call-started')
  await new Promise((resolve, reject) => {
    const abort = () => reject(extra.signal.reason ?? new Error('canceled'))
    if (extra.signal.aborted) abort()
    else extra.signal.addEventListener('abort', abort, { once: true })
  })
  return { content: [{ type: 'text', text: 'late result' }] }
})

await server.connect(new StdioServerTransport())
