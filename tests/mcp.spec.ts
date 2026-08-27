import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PROTOCOL_VERSION,
  type McpServer,
} from '@agentclientprotocol/sdk'
import { McpServer as ProtocolMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { mapMcpServers, McpConfigError } from '../src/mcp.js'
import { makeHarness, textResponse, type BridgeHarness } from './harness.js'

const fixture = resolve('tests/fixtures/mcp-server.mjs')

function stdio(name = 'fixture', env: Array<{ name: string; value: string }> = []): McpServer {
  return { name, command: process.execPath, args: [fixture], env }
}

function toolCall(name: string, callId: string, argumentsJson: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId as never, name, arguments: argumentsJson } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

async function initialize(harness: BridgeHarness) {
  return await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
}

describe('ACP MCP configuration mapping', () => {
  it('maps stdio argv, environment, cwd, and strict startup without a shell', () => {
    const cwd = process.cwd()
    expect(mapMcpServers([stdio('stable', [{ name: 'TOKEN', value: 'secret' }])], cwd)).toEqual([{
      transport: 'stdio',
      serverName: 'stable',
      command: process.execPath,
      args: [fixture],
      env: { TOKEN: 'secret' },
      cwd,
      toolCallTimeoutMs: 60_000,
      failOnStartupError: true,
    }])
  })

  it('maps Streamable HTTP headers and rejects credentials or non-HTTP URLs', () => {
    expect(mapMcpServers([{
      type: 'http', name: 'web', url: 'https://example.test/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer secret' }],
    }], process.cwd())).toEqual([{
      transport: 'streamable-http',
      serverName: 'web',
      url: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer secret' },
      toolCallTimeoutMs: 60_000,
      failOnStartupError: true,
    }])
    expect(() => mapMcpServers([{
      type: 'http', name: 'web', url: 'https://token@example.test/mcp', headers: [],
    }], process.cwd())).toThrow(/without embedded credentials/)
    expect(() => mapMcpServers([{
      type: 'http', name: 'web', url: 'file:\/\/\/tmp\/mcp', headers: [],
    }], process.cwd())).toThrow(/HTTP or HTTPS/)
    expect(() => mapMcpServers([{
      type: 'http', name: 'web', url: 'not a url', headers: [],
    }], process.cwd())).toThrow(/valid HTTP or HTTPS/)
  })

  it('rejects unsupported transports, invalid stable names, duplicates, and unsafe entries', () => {
    const cwd = process.cwd()
    expect(() => mapMcpServers([{ type: 'sse', name: 'x', url: 'https://example.test', headers: [] }], cwd))
      .toThrow(/SSE transport is not supported/)
    expect(() => mapMcpServers([{ type: 'acp', name: 'x', serverId: 'id' }], cwd))
      .toThrow(/ACP transport is not supported/)
    expect(() => mapMcpServers([stdio('bad name')], cwd)).toThrow(/name must match/)
    expect(() => mapMcpServers([stdio('same'), stdio('same')], cwd)).toThrow(/duplicates MCP server/)
    expect(mapMcpServers([{ ...stdio(), command: 'node' }], cwd)[0]).toMatchObject({ command: 'node' })
    expect(() => mapMcpServers([{ ...stdio(), command: '' }], cwd)).toThrow(/non-empty executable/)
    expect(() => mapMcpServers([{ ...stdio(), command: 'node\0bad' }], cwd)).toThrow(/without NUL/)
    expect(() => mapMcpServers([{ ...stdio(), args: ['bad\0arg'] }], cwd)).toThrow(/args must not contain NUL/)
    expect(() => mapMcpServers([stdio('x', [{ name: 'A=B', value: 'x' }])], cwd)).toThrow(/name is invalid/)
    expect(() => mapMcpServers([stdio('x', [{ name: 'A', value: 'x' }, { name: 'A', value: 'y' }])], cwd))
      .toThrow(/name is duplicated/)
    expect(() => mapMcpServers([{
      type: 'http', name: 'x', url: 'https://example.test',
      headers: [{ name: 'Bad Header', value: 'x' }],
    }], cwd)).toThrow(/name is invalid/)
    expect(() => mapMcpServers([{
      type: 'http', name: 'x', url: 'https://example.test',
      headers: [{ name: 'X-Test', value: 'one' }, { name: 'x-test', value: 'two' }],
    }], cwd)).toThrow(/name is duplicated/)
    expect(() => mapMcpServers([{
      type: 'http', name: 'x', url: 'https://example.test',
      headers: [{ name: 'X-Test', value: 'one\r\ntwo' }],
    }], cwd)).toThrow(/value is invalid/)
    expect(() => mapMcpServers([stdio('x', [{ name: 'A', value: 'bad\0value' }])], cwd))
      .toThrow(/value is invalid/)
    expect(() => mapMcpServers([{
      type: 'future', name: 'x',
    } as unknown as McpServer], cwd)).toThrow(/unsupported MCP transport/)
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    expect(mapMcpServers([stdio('case-sensitive', [
      { name: 'Mixed', value: 'one' }, { name: 'mixed', value: 'two' },
    ])], cwd)[0]).toMatchObject({ env: { Mixed: 'one', mixed: 'two' } })
    platform.mockRestore()
    expect(new McpConfigError('bad')).toBeInstanceOf(Error)
  })
})

describe('session-scoped MCP lifecycle', () => {
  let harness: BridgeHarness | undefined
  let temp: string | undefined
  let httpServer: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await harness?.dispose().catch(() => undefined)
    harness = undefined
    if (httpServer !== undefined) {
      await new Promise<void>(resolveClose => httpServer!.close(() => resolveClose()))
      httpServer = undefined
    }
    if (temp !== undefined) await rm(temp, { recursive: true, force: true })
    temp = undefined
  })

  it('advertises only stable stdio baseline plus supported HTTP capability', async () => {
    harness = await makeHarness([])
    const result = await initialize(harness)
    expect(result.agentCapabilities?.mcpCapabilities).toEqual({ http: true })
    expect(result.agentCapabilities?.mcpCapabilities).not.toHaveProperty('sse')
    expect(result.agentCapabilities?.mcpCapabilities).not.toHaveProperty('acp')
  })

  it('starts real stdio MCP, discovers and invokes its scoped tool, projects cards, and closes it', async () => {
    temp = await mkdtemp(join(tmpdir(), 'dsh-acp-mcp-'))
    const lifecycle = join(temp, 'lifecycle.log')
    harness = await makeHarness([
      toolCall('mcp__fixture__echo', 'mcp-echo', '{"text":"hello"}'),
      textResponse('complete'),
    ])
    harness.ctx.provide('attachments', {} as never)
    await initialize(harness)
    const created = await harness.client.newSession({
      cwd: process.cwd(),
      mcpServers: [stdio('fixture', [
        { name: 'MCP_SESSION_MARKER', value: 'one' },
        { name: 'MCP_LIFECYCLE_FILE', value: lifecycle },
      ])],
    })
    const agent = harness.ctx.agents.get(SessionId(created.sessionId))!
    expect(harness.ctx.tools.schemas(agent).map(tool => tool.name)).toContain('mcp__fixture__echo')
    expect(harness.ctx.tools.schemas().map(tool => tool.name)).not.toContain('mcp__fixture__echo')

    await harness.client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'use MCP' }] })
    expect(harness.updates).toContainEqual(expect.objectContaining({
      sessionId: created.sessionId,
      update: expect.objectContaining({ sessionUpdate: 'tool_call', toolCallId: 'mcp-echo' }),
    }))
    expect(harness.updates).toContainEqual(expect.objectContaining({
      sessionId: created.sessionId,
      update: expect.objectContaining({
        sessionUpdate: 'tool_call_update', toolCallId: 'mcp-echo', status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'one:hello' } }],
      }),
    }))
    const log = JSON.stringify(agent.session.events)
    expect(log).not.toContain('MCP_SESSION_MARKER')
    expect(log).not.toContain(lifecycle)

    const started = await readFile(lifecycle, 'utf8')
    const pid = Number(/started:(\d+)/.exec(started)?.[1])
    expect(pid).toBeGreaterThan(0)

    await harness.client.closeSession({ sessionId: created.sessionId })
    expect(harness.ctx.tools.schemas(agent).map(tool => tool.name)).not.toContain('mcp__fixture__echo')
    await vi.waitFor(() => { expect(() => process.kill(pid, 0)).toThrow() })
  })

  it('keeps same-name servers and failures isolated across two sessions', async () => {
    harness = await makeHarness([
      toolCall('mcp__same__echo', 'call-a', '{"text":"hello"}'), textResponse('A done'),
      toolCall('mcp__same__echo', 'call-b', '{"text":"hello"}'), textResponse('B done'),
    ])
    await initialize(harness)
    const a = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [stdio('same', [{ name: 'MCP_SESSION_MARKER', value: 'A' }])] })
    const b = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [stdio('same', [{ name: 'MCP_SESSION_MARKER', value: 'B' }])] })
    await harness.client.prompt({ sessionId: a.sessionId, prompt: [{ type: 'text', text: 'A' }] })
    await harness.client.prompt({ sessionId: b.sessionId, prompt: [{ type: 'text', text: 'B' }] })
    const results = harness.updates.filter(item => item.update.sessionUpdate === 'tool_call_update')
    expect(JSON.stringify(results.filter(item => item.sessionId === a.sessionId))).toContain('A:hello')
    expect(JSON.stringify(results.filter(item => item.sessionId === a.sessionId))).not.toContain('B:hello')
    expect(JSON.stringify(results.filter(item => item.sessionId === b.sessionId))).toContain('B:hello')
    await harness.client.closeSession({ sessionId: a.sessionId })
    const agentB = harness.ctx.agents.get(SessionId(b.sessionId))!
    expect(harness.ctx.tools.schemas(agentB).map(tool => tool.name)).toContain('mcp__same__echo')
  })

  it('rolls back all started servers on invalid config, spawn failure, or discovery failure', async () => {
    harness = await makeHarness([])
    await initialize(harness)
    await expect(harness.client.newSession({
      cwd: process.cwd(), mcpServers: [stdio('bad name')],
    })).rejects.toThrow(/name must match/)
    const spawnFailure = await harness.client.newSession({
      cwd: process.cwd(), mcpServers: [{
        ...stdio('missing', [{ name: 'PRIVATE_TOKEN', value: 'spawn-secret' }]),
        command: resolve('does-not-exist-mcp.exe'),
      }],
    }).catch((error: unknown) => error)
    expect(String(spawnFailure)).toMatch(/initial connection or tool discovery failed/)
    expect(String(spawnFailure)).not.toContain('spawn-secret')

    temp = await mkdtemp(join(tmpdir(), 'dsh-acp-mcp-bad-'))
    const badServer = join(temp, 'bad-server.mjs')
    await writeFile(badServer, [
      "import readline from 'node:readline'",
      "const lines = readline.createInterface({ input: process.stdin })",
      "for await (const line of lines) {",
      " const message = JSON.parse(line)",
      " if (message.method === 'initialize') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'bad',version:'1'}}})+'\\n')",
      " else if (message.method === 'tools/list') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{tools:'invalid'}})+'\\n')",
      "}",
    ].join('\n'))
    await expect(harness.client.newSession({
      cwd: process.cwd(), mcpServers: [stdio('first'), { ...stdio('broken'), args: [badServer] }],
    })).rejects.toThrow(/initial connection or tool discovery failed/)
    expect(harness.ctx.tools.schemas().some(tool => tool.name.startsWith('mcp__'))).toBe(false)
    expect(harness.ctx.agents.list()).toEqual([])
  })

  it('rolls back a connected MCP server when session response assembly fails', async () => {
    temp = await mkdtemp(join(tmpdir(), 'dsh-acp-mcp-response-'))
    const lifecycle = join(temp, 'lifecycle.log')
    harness = await makeHarness([])
    await initialize(harness)
    harness.ctx.provide('planMode', {
      get: () => { throw new Error('mode state unavailable') },
      set: () => 'noop',
    } as never)
    await expect(harness.client.newSession({
      cwd: process.cwd(), mcpServers: [stdio('response', [{ name: 'MCP_LIFECYCLE_FILE', value: lifecycle }])],
    })).rejects.toThrow(/session creation failed/)
    const started = await readFile(lifecycle, 'utf8')
    const pid = Number(/started:(\d+)/.exec(started)?.[1])
    expect(harness.ctx.agents.list()).toEqual([])
    expect(harness.ctx.tools.schemas().some(tool => tool.name.startsWith('mcp__response__'))).toBe(false)
    await vi.waitFor(() => { expect(() => process.kill(pid, 0)).toThrow() })
  })

  it('maps real Streamable HTTP with headers and fails creation when HTTP discovery fails', async () => {
    const seen: Array<string | undefined> = []
    httpServer = createServer((request, response) => {
      void handleHttp(request, response, seen).catch(error => response.writeHead(500).end(String(error)))
    })
    await new Promise<void>(resolveListen => httpServer!.listen(0, '127.0.0.1', resolveListen))
    const address = httpServer.address()
    if (address === null || typeof address === 'string') throw new Error('HTTP fixture has no address')
    const url = `http://127.0.0.1:${address.port}/mcp`
    harness = await makeHarness([])
    await initialize(harness)
    const created = await harness.client.newSession({
      cwd: process.cwd(),
      mcpServers: [{ type: 'http', name: 'web', url, headers: [{ name: 'Authorization', value: 'Bearer private' }] }],
    })
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every(value => value === 'Bearer private')).toBe(true)
    expect(JSON.stringify(harness.ctx.agents.get(SessionId(created.sessionId))!.session.events)).not.toContain('Bearer private')
    await harness.client.closeSession({ sessionId: created.sessionId })
    const httpFailure = await harness.client.newSession({
      cwd: process.cwd(),
      mcpServers: [{
        type: 'http', name: 'offline', url: 'http://127.0.0.1:1/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer http-secret' }],
      }],
    }).catch((error: unknown) => error)
    expect(String(httpFailure)).toMatch(/initial connection or tool discovery failed/)
    expect(String(httpFailure)).not.toContain('http-secret')
  })

  it('installs current config on load/resume and never inherits removed or failed prior config', async () => {
    harness = await makeHarness([])
    await initialize(harness)
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [stdio('old')] })
    const source = harness.ctx.agents.get(SessionId(created.sessionId))!
    harness.persisted.set(SessionId(created.sessionId), {
      meta: structuredClone(source.session.header), events: structuredClone(source.session.events),
    })
    await harness.client.closeSession({ sessionId: created.sessionId })

    await harness.client.loadSession({ sessionId: created.sessionId, cwd: process.cwd(), mcpServers: [stdio('loaded')] })
    let restored = harness.ctx.agents.get(SessionId(created.sessionId))!
    expect(harness.ctx.tools.schemas(restored).map(tool => tool.name)).toContain('mcp__loaded__echo')
    expect(harness.ctx.tools.schemas(restored).map(tool => tool.name)).not.toContain('mcp__old__echo')
    await harness.client.closeSession({ sessionId: created.sessionId })

    await harness.client.resumeSession({ sessionId: created.sessionId, cwd: process.cwd(), mcpServers: [] })
    restored = harness.ctx.agents.get(SessionId(created.sessionId))!
    expect(harness.ctx.tools.schemas(restored).some(tool => tool.name.startsWith('mcp__'))).toBe(false)
    await harness.client.closeSession({ sessionId: created.sessionId })
    await expect(harness.client.resumeSession({
      sessionId: created.sessionId, cwd: process.cwd(),
      mcpServers: [{ ...stdio('failed'), command: resolve('missing-resume-server.exe') }],
    })).rejects.toThrow(/initial connection or tool discovery failed/)
    expect(harness.ctx.agents.get(SessionId(created.sessionId))).toBeUndefined()

    harness.ctx.provide('planMode', {
      get: () => { throw new Error('resume mode unavailable') },
      set: () => 'noop',
    } as never)
    await expect(harness.client.resumeSession({
      sessionId: created.sessionId, cwd: process.cwd(), mcpServers: [stdio('resume-response')],
    })).rejects.toThrow(/session resume failed/)
    expect(harness.ctx.agents.get(SessionId(created.sessionId))).toBeUndefined()
    expect(harness.ctx.tools.schemas().some(tool => tool.name.startsWith('mcp__resume-response__'))).toBe(false)
  })

  it('cancels a running MCP call, removes its tools, and emits no late update', async () => {
    temp = await mkdtemp(join(tmpdir(), 'dsh-acp-mcp-cancel-'))
    const lifecycle = join(temp, 'lifecycle.log')
    harness = await makeHarness([toolCall('mcp__slow__wait', 'slow-call', '{}')])
    await initialize(harness)
    const created = await harness.client.newSession({
      cwd: process.cwd(), mcpServers: [stdio('slow', [{ name: 'MCP_LIFECYCLE_FILE', value: lifecycle }])],
    })
    const sibling = await harness.client.newSession({
      cwd: process.cwd(), mcpServers: [stdio('slow', [{ name: 'MCP_SESSION_MARKER', value: 'sibling' }])],
    })
    const prompting = harness.client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'wait' }] })
    await vi.waitFor(async () => { expect(await readFile(lifecycle, 'utf8')).toContain('call-started') })
    const before = harness.updates.length
    await harness.client.cancel({ sessionId: created.sessionId })
    await expect(prompting).resolves.toEqual({ stopReason: 'cancelled' })
    const agent = harness.ctx.agents.get(SessionId(created.sessionId))!
    await vi.waitFor(() => { expect(harness!.ctx.tools.schemas(agent).map(tool => tool.name)).not.toContain('mcp__slow__wait') })
    const settledUpdates = harness.updates.length
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
    expect(harness.updates).toHaveLength(settledUpdates)
    expect(harness.updates.slice(before).some(item => item.update.sessionUpdate === 'tool_call_update'
      && item.update.toolCallId === 'slow-call' && JSON.stringify(item.update).includes('late result'))).toBe(false)
    const siblingAgent = harness.ctx.agents.get(SessionId(sibling.sessionId))!
    expect(harness.ctx.tools.schemas(siblingAgent).map(tool => tool.name)).toContain('mcp__slow__echo')
  })

  it('closes a running MCP call without any post-close tool update', async () => {
    temp = await mkdtemp(join(tmpdir(), 'dsh-acp-mcp-close-'))
    const lifecycle = join(temp, 'lifecycle.log')
    harness = await makeHarness([toolCall('mcp__closing__wait', 'close-call', '{}')])
    await initialize(harness)
    const created = await harness.client.newSession({
      cwd: process.cwd(), mcpServers: [stdio('closing', [{ name: 'MCP_LIFECYCLE_FILE', value: lifecycle }])],
    })
    const prompting = harness.client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'wait' }] })
    await vi.waitFor(async () => { expect(await readFile(lifecycle, 'utf8')).toContain('call-started') })
    await harness.client.closeSession({ sessionId: created.sessionId })
    await expect(prompting).resolves.toEqual({ stopReason: 'cancelled' })
    const settledUpdates = harness.updates.length
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
    expect(harness.updates).toHaveLength(settledUpdates)
    expect(harness.ctx.agents.get(SessionId(created.sessionId))).toBeUndefined()
  })

  it('connection teardown stops an established session MCP completely', async () => {
    temp = await mkdtemp(join(tmpdir(), 'dsh-acp-mcp-connection-'))
    const lifecycle = join(temp, 'lifecycle.log')
    harness = await makeHarness([])
    await initialize(harness)
    const created = await harness.client.newSession({
      cwd: process.cwd(), mcpServers: [stdio('connection', [{ name: 'MCP_LIFECYCLE_FILE', value: lifecycle }])],
    })
    const agent = harness.ctx.agents.get(SessionId(created.sessionId))!
    const started = await readFile(lifecycle, 'utf8')
    const pid = Number(/started:(\d+)/.exec(started)?.[1])
    expect(harness.ctx.tools.schemas(agent).map(tool => tool.name)).toContain('mcp__connection__echo')
    await harness.closeClientTransport()
    await vi.waitFor(() => { expect(harness!.ctx.agents.list()).toEqual([]) })
    expect(harness.ctx.tools.schemas(agent).map(tool => tool.name)).not.toContain('mcp__connection__echo')
    await vi.waitFor(() => { expect(() => process.kill(pid, 0)).toThrow() })
  })

  it('session close interrupts an in-progress MCP restore transaction', async () => {
    let requested = false
    httpServer = createServer((_request, _response) => { requested = true })
    await new Promise<void>(resolveListen => httpServer!.listen(0, '127.0.0.1', resolveListen))
    const address = httpServer.address()
    if (address === null || typeof address === 'string') throw new Error('restore fixture has no address')
    harness = await makeHarness([])
    await initialize(harness)
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const source = harness.ctx.agents.get(SessionId(created.sessionId))!
    harness.persisted.set(SessionId(created.sessionId), {
      meta: structuredClone(source.session.header), events: structuredClone(source.session.events),
    })
    await harness.client.closeSession({ sessionId: created.sessionId })

    const restoring = harness.client.resumeSession({
      sessionId: created.sessionId,
      cwd: process.cwd(),
      mcpServers: [{
        type: 'http', name: 'restoring', url: `http://127.0.0.1:${address.port}/mcp`, headers: [],
      }],
    })
    await vi.waitFor(() => { expect(requested).toBe(true) })
    await expect(harness.client.closeSession({ sessionId: created.sessionId })).resolves.toEqual({})
    await expect(restoring).rejects.toThrow()
    expect(harness.ctx.agents.get(SessionId(created.sessionId))).toBeUndefined()
    expect(harness.ctx.tools.schemas().some(tool => tool.name.startsWith('mcp__restoring__'))).toBe(false)
  })

  it('plugin teardown aborts an in-progress creation and leaves no scoped MCP state', async () => {
    httpServer = createServer((_request, _response) => {})
    await new Promise<void>(resolveListen => httpServer!.listen(0, '127.0.0.1', resolveListen))
    const address = httpServer.address()
    if (address === null || typeof address === 'string') throw new Error('waiting fixture has no address')
    harness = await makeHarness([])
    await initialize(harness)
    const creating = harness.client.newSession({
      cwd: process.cwd(),
      mcpServers: [{ type: 'http', name: 'waiting', url: `http://127.0.0.1:${address.port}/mcp`, headers: [] }],
    })
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
    const disposing = harness.acpFiber.dispose()
    await expect(creating).rejects.toThrow()
    await disposing
    await vi.waitFor(() => { expect(harness!.ctx.agents.list()).toEqual([]) })
    expect(harness.ctx.tools.schemas().some(tool => tool.name.startsWith('mcp__'))).toBe(false)
  })
})

async function handleHttp(
  request: IncomingMessage,
  response: ServerResponse,
  seen: Array<string | undefined>,
): Promise<void> {
  seen.push(request.headers.authorization)
  const server = new ProtocolMcpServer({ name: 'http-fixture', version: '1' }, { capabilities: { tools: {} } })
  server.registerTool('ping', { inputSchema: {}, description: 'Pong' }, async () => ({
    content: [{ type: 'text', text: 'pong' }],
  }))
  const transport = new StreamableHTTPServerTransport({})
  response.on('close', () => { void transport.close(); void server.close() })
  await server.connect(transport as Transport)
  await transport.handleRequest(request, response)
}
