/** Real subprocess coverage for the package-owned ACP launcher and composition. */

import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { afterEach, expect, it } from 'vitest'
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent,
  type Client,
  type SessionNotification,
} from '@agentclientprotocol/sdk'

const roots: string[] = []

async function waitForUpdate(
  updates: SessionNotification['update'][],
  predicate: (update: SessionNotification['update']) => boolean,
  timeoutMs = 5_000,
): Promise<SessionNotification['update'] | undefined> {
  return await new Promise(resolve => {
    const find = (): SessionNotification['update'] | undefined => updates.find(predicate)
    const current = find()
    if (current !== undefined) {
      resolve(current)
      return
    }
    const timer = setInterval(() => {
      const found = find()
      if (found !== undefined) {
        clearInterval(timer)
        clearTimeout(timeout)
        resolve(found)
      }
    }, 20)
    const timeout = setTimeout(() => {
      clearInterval(timer)
      resolve(undefined)
    }, timeoutMs)
  })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function mockToolServer(options: {
  toolName?: string
  toolArguments?: string
  callId?: string
  completion?: string
} = {}): Promise<{ server: Server; baseURL: string; requests: unknown[] }> {
  const toolName = options.toolName ?? 'glob'
  const toolArguments = options.toolArguments ?? '{"pattern":"stage-b-marker.ts"}'
  const callId = options.callId ?? 'stage-b-glob'
  const completion = options.completion ?? 'filesystem search complete'
  const requests: unknown[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const events = requests.length === 1
        ? [
            `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: toolName, arguments: toolArguments } }] }, index: 0, finish_reason: null }] })}`,
            'data: {"choices":[{"delta":{},"index":0,"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
            'data: [DONE]',
            '',
          ]
        : [
            `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: completion }, index: 0, finish_reason: null }] })}`,
            'data: {"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}',
            'data: [DONE]',
            '',
          ]
      response.end(events.join('\n\n'))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('mock tool server has no port')
  return { server, baseURL: `http://127.0.0.1:${address.port}/v1`, requests }
}

it('boots without a Harness checkout and publishes user providers plus official commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-acp-standalone-'))
  roots.push(root)
  const home = join(root, '.dsh')
  await mkdir(home)
  await writeFile(join(home, 'settings.yaml'), [
    'llm-pi-ai:',
    '  providers:',
    '    local-probe:',
    '      displayName: Local Probe',
    '      api: openai-completions',
    '      baseURL: http://127.0.0.1:1/v1',
    '      models:',
    '        - id: probe-model',
    '          name: Probe Model',
    '',
  ].join('\n'))
  const child = spawn(process.execPath, [join(process.cwd(), 'lib', 'bin.js')], {
    cwd: root,
    env: { ...process.env, DSH_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stderr: string[] = []
  const updates: SessionNotification['update'][] = []
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => stderr.push(String(chunk)))
  const client = new ClientSideConnection((_agent: Agent): Client => ({
    sessionUpdate: async update => { updates.push(update.update) },
    requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
  }), ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  ))
  try {
    await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const session = await client.newSession({ cwd: root, mcpServers: [] })
    const model = session.configOptions?.find(option => option.id === 'model')
    expect(model?.type).toBe('select')
    const update = await waitForUpdate(updates, candidate => candidate.sessionUpdate === 'config_option_update'
      && JSON.stringify(candidate).includes('local-probe'))
    expect(update).toBeDefined()
    expect(JSON.stringify(update)).toContain('local-probe')
    const commandUpdate = await waitForUpdate(
      updates,
      candidate => candidate.sessionUpdate === 'available_commands_update',
    )
    expect(commandUpdate?.sessionUpdate === 'available_commands_update'
      ? commandUpdate.availableCommands.map(command => command.name).sort()
      : undefined).toEqual([
      'compact', 'feedback', 'goal', 'permission', 'plan',
    ])
  } catch (error: unknown) {
    throw new Error(`${String(error)}\nstderr:\n${stderr.join('')}`)
  } finally {
    child.kill('SIGTERM')
    await new Promise<void>(resolve => child.once('close', () => resolve()))
  }
})

it('executes a discovered human command and a selected model tool through real ACP', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-acp-editor-profile-'))
  roots.push(root)
  const home = join(root, '.dsh')
  await mkdir(home)
  await writeFile(join(root, 'stage-b-marker.ts'), 'export const stageB = true\n')
  const mock = await mockToolServer()
  await writeFile(join(home, '.credentials.yaml'), [
    'version: 1',
    'refs:',
    '  STAGE_B_API_KEY: test-key',
    '',
  ].join('\n'))
  await writeFile(join(home, 'settings.yaml'), [
    'llm-pi-ai:',
    '  providers:',
    '    local-probe:',
    '      displayName: Local Probe',
    '      api: openai-completions',
    '      apiKeyEnv: STAGE_B_API_KEY',
    `      baseURL: ${mock.baseURL}`,
    '      models:',
    '        - id: probe-model',
    '          name: Probe Model',
    '',
  ].join('\n'))
  const child = spawn(process.execPath, [join(process.cwd(), 'lib', 'bin.js')], {
    cwd: root,
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_PERMISSION_MODE: 'danger-full-access',
      STAGE_B_API_KEY: 'test-key',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stderr: string[] = []
  const updates: SessionNotification['update'][] = []
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => stderr.push(String(chunk)))
  const client = new ClientSideConnection((_agent: Agent): Client => ({
    sessionUpdate: async update => { updates.push(update.update) },
    requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
  }), ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  ))
  try {
    await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const session = await client.newSession({ cwd: root, mcpServers: [] })

    await client.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: '/goal' }] })
    expect(updates.some(update => update.sessionUpdate === 'agent_message_chunk'
      && update.content.type === 'text' && update.content.text.includes('No goal is currently set'))).toBe(true)
    expect(mock.requests).toHaveLength(0)

    expect(await waitForUpdate(updates, update => update.sessionUpdate === 'config_option_update'
      && JSON.stringify(update).includes('local-probe'))).toBeDefined()
    await client.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'model',
      value: 'local-probe:probe-model',
    })
    await client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'Find the Stage B marker with the filesystem search tool.' }],
    })

    expect(mock.requests).toHaveLength(2)
    expect(updates).toContainEqual(expect.objectContaining({
      sessionUpdate: 'tool_call',
      toolCallId: 'stage-b-glob',
      title: 'Glob stage-b-marker.ts',
      kind: 'search',
    }))
    expect(updates).toContainEqual(expect.objectContaining({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'stage-b-glob',
      status: 'completed',
      content: [expect.objectContaining({
        type: 'content',
        content: { type: 'text', text: 'stage-b-marker.ts' },
      })],
    }))
  } catch (error: unknown) {
    throw new Error(`${String(error)}\nstderr:\n${stderr.join('')}`)
  } finally {
    child.kill('SIGTERM')
    await new Promise<void>(resolve => child.once('close', () => resolve()))
    await new Promise<void>((resolve, reject) => mock.server.close(error => error === undefined ? resolve() : reject(error)))
  }
})

it('runs a session-scoped stdio MCP tool through the built launcher', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-acp-launcher-mcp-'))
  roots.push(root)
  const home = join(root, '.dsh')
  await mkdir(home)
  const mock = await mockToolServer({
    toolName: 'mcp__launcher__echo',
    toolArguments: '{"text":"hello"}',
    callId: 'launcher-mcp-echo',
    completion: 'MCP complete',
  })
  await writeFile(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  LAUNCHER_MCP_KEY: test-key\n')
  await writeFile(join(home, 'settings.yaml'), [
    'llm-pi-ai:',
    '  providers:',
    '    launcher-mcp:',
    '      displayName: Launcher MCP',
    '      api: openai-completions',
    '      apiKeyEnv: LAUNCHER_MCP_KEY',
    `      baseURL: ${mock.baseURL}`,
    '      models:',
    '        - id: probe-model',
    '          name: Probe Model',
    '',
  ].join('\n'))
  const child = spawn(process.execPath, [join(process.cwd(), 'lib', 'bin.js')], {
    cwd: root,
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_PERMISSION_MODE: 'danger-full-access',
      LAUNCHER_MCP_KEY: 'test-key',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stderr: string[] = []
  const updates: SessionNotification['update'][] = []
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => stderr.push(String(chunk)))
  const client = new ClientSideConnection((_agent: Agent): Client => ({
    sessionUpdate: async update => { updates.push(update.update) },
    requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
  }), ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  ))
  try {
    const initialized = await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    expect(initialized.agentCapabilities?.mcpCapabilities).toEqual({ http: true })
    const session = await client.newSession({
      cwd: root,
      mcpServers: [{
        name: 'launcher',
        command: process.execPath,
        args: [resolve('tests/fixtures/mcp-server.mjs')],
        env: [{ name: 'MCP_SESSION_MARKER', value: 'launcher' }],
      }],
    })
    await client.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'model',
      value: 'launcher-mcp:probe-model',
    })
    await client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'Use the session MCP echo tool.' }],
    })
    expect(mock.requests).toHaveLength(2)
    expect(updates).toContainEqual(expect.objectContaining({
      sessionUpdate: 'tool_call',
      toolCallId: 'launcher-mcp-echo',
    }))
    expect(updates).toContainEqual(expect.objectContaining({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'launcher-mcp-echo',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'launcher:hello' } }],
    }))
    await client.closeSession({ sessionId: session.sessionId })
  } catch (error: unknown) {
    throw new Error(`${String(error)}\nstderr:\n${stderr.join('')}`)
  } finally {
    child.kill('SIGTERM')
    await new Promise<void>(resolveClose => child.once('close', () => resolveClose()))
    await new Promise<void>((resolveClose, reject) => mock.server.close(error => error === undefined ? resolveClose() : reject(error)))
  }
})
