/** Real subprocess coverage for the package-owned ACP launcher and composition. */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
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

interface LauncherProcess {
  child: ChildProcessWithoutNullStreams
  client: ClientSideConnection
  updates: SessionNotification['update'][]
  stderr: string[]
  stop(): Promise<void>
}

function startLauncher(root: string, home: string, sessions: string): LauncherProcess {
  const child = spawn(process.execPath, [join(process.cwd(), 'lib', 'bin.js')], {
    cwd: root,
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_ACP_SESSIONS_ROOT: sessions,
      DSH_PERMISSION_MODE: 'danger-full-access',
      DEEPSEEK_API_KEY: 'sk-launcher-test',
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
  let stopping: Promise<void> | undefined
  return {
    child,
    client,
    updates,
    stderr,
    stop: () => {
      stopping ??= new Promise<void>((resolveStop) => {
        child.once('close', () => resolveStop())
        child.kill('SIGTERM')
      })
      return stopping
    },
  }
}

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

it('stores a DeepSeek API key through the built terminal setup launcher', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-acp-setup-'))
  roots.push(root)
  const home = join(root, '.dsh')
  await mkdir(home)
  const child = spawn(process.execPath, [join(process.cwd(), 'lib', 'bin.js'), '--setup'], {
    cwd: root,
    env: { ...process.env, DSH_HOME: home, DEEPSEEK_API_KEY: undefined },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  child.stdin.end('sk-launcher-test\n')
  const exitCode = await new Promise<number | null>(resolveExit => child.once('close', resolveExit))

  expect(exitCode, stderr).toBe(0)
  expect(stdout).toBe('')
  expect(stderr).not.toContain('sk-launcher-test')
  expect(await import('node:fs/promises').then(fs => fs.readFile(
    join(home, '.credentials.yaml'),
    'utf8',
  ))).toContain('DEEPSEEK_API_KEY: sk-launcher-test')
})

it('recovers one JSONL session across concurrent launcher processes without making close destructive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-acp-multiprocess-'))
  roots.push(root)
  const home = join(root, '.dsh')
  const sessions = join(root, 'sessions')
  await Promise.all([mkdir(home), mkdir(sessions)])
  const writer = startLauncher(root, home, sessions)
  const reader = startLauncher(root, home, sessions)
  try {
    await Promise.all([
      writer.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }),
      reader.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }),
    ])
    const created = await writer.client.newSession({ cwd: root, mcpServers: [] })
    await expect(writer.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: '/plan' }],
    })).resolves.toEqual({ stopReason: 'end_turn' })
    await writer.client.closeSession({ sessionId: created.sessionId })

    await expect(reader.client.listSessions({ cwd: root })).resolves.toEqual({
      sessions: [{ sessionId: created.sessionId, cwd: root }],
    })
    const loaded = await reader.client.loadSession({
      sessionId: created.sessionId,
      cwd: root,
      mcpServers: [],
    })
    expect(loaded.modes?.currentModeId).toBe('plan')
    await reader.client.closeSession({ sessionId: created.sessionId })
    await expect(reader.client.listSessions({ cwd: root })).resolves.toEqual({
      sessions: [{ sessionId: created.sessionId, cwd: root }],
    })

    const resumed = await reader.client.resumeSession({ sessionId: created.sessionId, cwd: root })
    expect(resumed.modes?.currentModeId).toBe('plan')
    await reader.client.closeSession({ sessionId: created.sessionId })
    await expect(reader.client.listSessions({ cwd: root })).resolves.toEqual({
      sessions: [{ sessionId: created.sessionId, cwd: root }],
    })
  } catch (error: unknown) {
    throw new Error(
      `${String(error)}\nwriter stderr:\n${writer.stderr.join('')}\nreader stderr:\n${reader.stderr.join('')}`,
    )
  } finally {
    await Promise.all([writer.stop(), reader.stop()])
  }
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
  let mainRequests = 0
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        max_completion_tokens?: number
        messages?: Array<{ role?: string; content?: string }>
      }
      requests.push(payload)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const isTitleRequest = payload.max_completion_tokens === 32
        && payload.messages?.some(message => message.role === 'system'
          && message.content?.includes('Create a concise title for an AI coding-assistant session')) === true
      if (isTitleRequest) {
        response.end([
          'data: {"choices":[{"delta":{"role":"assistant","content":"Locate Stage B marker"},"index":0,"finish_reason":null}]}',
          'data: {"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":4}}',
          'data: [DONE]',
          '',
        ].join('\n\n'))
        return
      }
      mainRequests += 1
      const events = mainRequests === 1
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
  const agentsHome = join(root, 'agents')
  const sessions = join(root, 'sessions')
  await Promise.all([mkdir(home), mkdir(agentsHome), mkdir(sessions)])
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
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_AGENTS_HOME: agentsHome,
      DSH_ACP_SESSIONS_ROOT: sessions,
      DEEPSEEK_API_KEY: 'sk-launcher-test',
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
    const model = session.configOptions?.find(option => option.id === 'model')
    expect(model?.type).toBe('select')
    // session/new waits for the credentials service, so the user provider directory is
    // usually published before the session exists and already sits in configOptions;
    // a slower directory refresh arrives as a config_option_update instead.
    if (!JSON.stringify(model).includes('local-probe')) {
      const update = await waitForUpdate(updates, candidate => candidate.sessionUpdate === 'config_option_update'
        && JSON.stringify(candidate).includes('local-probe'))
      expect(update).toBeDefined()
    }
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
  const agentsHome = join(root, 'agents')
  const sessions = join(root, 'sessions')
  await Promise.all([mkdir(home), mkdir(agentsHome), mkdir(sessions)])
  await writeFile(join(root, 'stage-b-marker.ts'), 'export const stageB = true\n')
  const mock = await mockToolServer()
  // credentials-local refuses a credentials file readable beyond its owner on POSIX.
  await writeFile(join(home, '.credentials.yaml'), [
    'version: 1',
    'refs:',
    '  STAGE_B_API_KEY: test-key',
    '',
  ].join('\n'), { mode: 0o600 })
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
      DSH_AGENTS_HOME: agentsHome,
      DSH_ACP_SESSIONS_ROOT: sessions,
      DSH_PERMISSION_MODE: 'danger-full-access',
      STAGE_B_API_KEY: 'test-key',
      DEEPSEEK_API_KEY: 'sk-launcher-test',
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

    if (!JSON.stringify(session.configOptions).includes('local-probe')) {
      expect(await waitForUpdate(updates, update => update.sessionUpdate === 'config_option_update'
        && JSON.stringify(update).includes('local-probe'))).toBeDefined()
    }
    await client.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'model',
      value: 'local-probe:probe-model',
    })
    await client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'Find the Stage B marker with the filesystem search tool.' }],
    })

    expect(await waitForUpdate(updates, update => update.sessionUpdate === 'session_info_update'
      && update.title === 'Locate Stage B marker')).toBeDefined()
    expect(mock.requests).toHaveLength(3)
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
  const agentsHome = join(root, 'agents')
  const sessions = join(root, 'sessions')
  await Promise.all([mkdir(home), mkdir(agentsHome), mkdir(sessions)])
  const mock = await mockToolServer({
    toolName: 'mcp__launcher__echo',
    toolArguments: '{"text":"hello"}',
    callId: 'launcher-mcp-echo',
    completion: 'MCP complete',
  })
  // credentials-local refuses a credentials file readable beyond its owner on POSIX.
  await writeFile(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  LAUNCHER_MCP_KEY: test-key\n', { mode: 0o600 })
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
      DSH_AGENTS_HOME: agentsHome,
      DSH_ACP_SESSIONS_ROOT: sessions,
      DSH_PERMISSION_MODE: 'danger-full-access',
      LAUNCHER_MCP_KEY: 'test-key',
      DEEPSEEK_API_KEY: 'sk-launcher-test',
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
    expect(await waitForUpdate(updates, update => update.sessionUpdate === 'session_info_update'
      && update.title === 'Locate Stage B marker')).toBeDefined()
    expect(mock.requests).toHaveLength(3)
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
