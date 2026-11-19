import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ClientSideConnection,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent,
  type Client,
  type SessionNotification,
} from '@agentclientprotocol/sdk'
import AttachmentStore, {
  AttachmentId,
  type ImageAttachmentLimits,
  type ImageAttachmentRef,
  type SaveImageAttachment,
  type StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import PlanModeController from '@deepseek-ai/dsh-plan-mode'
import { SessionId } from '@deepseek-ai/dsh-session'
import { makeHarness, textResponse, type BridgeHarness } from './harness.js'

const BIN_PATH = resolve('lib/bin.js')

class T3TestAttachments extends AttachmentStore {
  readonly imageLimits: ImageAttachmentLimits = {
    maxImageBytes: 1024,
    maxImagesPerMessage: 2,
    maxMessageImageBytes: 2048,
    maxImagePixels: 100,
    maxImageDimension: 10,
    mediaTypes: ['image/png'],
  }

  validateImage(): Promise<void> {
    return Promise.resolve()
  }

  saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    return Promise.resolve({
      attachmentId: AttachmentId('image-0'),
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
    })
  }

  readImage(_ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
    return Promise.reject(new Error('not used'))
  }
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const nested = await Promise.all(entries.map(async (entry) => {
      const full = join(dir, entry.name)
      return entry.isDirectory() ? await listFilesRecursive(full) : [full]
    }))
    return nested.flat()
  } catch {
    return []
  }
}

describe('T3 Code ACP integration compatibility', () => {
  let harness: BridgeHarness | undefined
  const roots: string[] = []

  afterEach(async () => {
    await harness?.dispose().catch(() => undefined)
    harness = undefined
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  })

  it('Pitfall 1: accepts hybrid v2/v1 initialize requests and validates invalid initialize params', async () => {
    // Wire-level NDJSON test over built launcher verifying raw JSON-RPC frames including unknown v2 keys.
    const root = await mkdtemp(join(tmpdir(), 'dsh-t3-init-'))
    roots.push(root)
    const home = join(root, '.dsh')
    const sessions = join(root, 'sessions')
    await Promise.all([mkdir(home), mkdir(sessions)])
    const child = spawn(process.execPath, [BIN_PATH], {
      cwd: root,
      env: { ...process.env, DSH_HOME: home, DSH_ACP_SESSIONS_ROOT: sessions },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const rl = createInterface({ input: child.stdout })
    const lines = (async function* () {
      for await (const line of rl) yield JSON.parse(line) as Record<string, unknown>
    })()
    const nextMessage = async (): Promise<Record<string, unknown>> => (await lines.next()).value as Record<string, unknown>
    const send = (payload: unknown): void => {
      child.stdin.write(`${JSON.stringify(payload)}\n`)
    }
    try {
      // Invalid initialize param shapes map cleanly to -32602.
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: null })
      expect(await nextMessage()).toMatchObject({ id: 1, error: { code: -32602 } })
      send({ jsonrpc: '2.0', id: 2, method: 'initialize', params: ['bad'] })
      expect(await nextMessage()).toMatchObject({ id: 2, error: { code: -32602 } })
      send({ jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: -1 } })
      expect(await nextMessage()).toMatchObject({ id: 3, error: { code: -32602 } })

      // Valid hybrid T3 v2 + v1 initialize: protocolVersion: 2, v1 auth + v2 info/capabilities.
      send({
        jsonrpc: '2.0',
        id: 4,
        method: 'initialize',
        params: {
          protocolVersion: 2,
          clientCapabilities: { auth: { terminal: true } },
          clientInfo: { name: 't3-code', version: '0.1.10' },
          info: { name: 't3-code-fallback', version: '0.1.10' },
          capabilities: { _meta: { terminal_output: false } },
        },
      })
      const hybridResp = await nextMessage()
      expect(hybridResp).toMatchObject({
        id: 4,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          agentInfo: { name: 'dsh-acp-interactive' },
          authMethods: [expect.objectContaining({ id: 'deepseek-api-key', type: 'terminal' })],
        },
      })

      // v2-only initialize omitting clientCapabilities and clientInfo falls back to capabilities & info.
      send({
        jsonrpc: '2.0',
        id: 5,
        method: 'initialize',
        params: {
          protocolVersion: 2,
          info: { name: 't3-code-provider-probe', version: '0.1.10' },
          capabilities: {
            _meta: { terminal_output: true },
            elicitation: { form: {} },
            session: { configOptions: { boolean: {} } },
          },
        },
      })
      const v2Resp = await nextMessage()
      expect(v2Resp).toMatchObject({
        id: 5,
        result: { protocolVersion: PROTOCOL_VERSION },
      })
    } finally {
      child.stdin.end()
      child.kill('SIGTERM')
      await new Promise<void>(resolveClose => child.once('close', () => resolveClose()))
    }

    // Exercise the same invalid param shapes and v2-only fallback in-process as well.
    harness = await makeHarness([])
    await expect(harness.client.request(methods.agent.initialize, null as never)).rejects.toMatchObject({ code: -32602 })
    await expect(harness.client.request(methods.agent.initialize, ['bad'] as never)).rejects.toMatchObject({ code: -32602 })
    await expect(harness.client.request(methods.agent.initialize, { protocolVersion: -1 } as never))
      .rejects.toMatchObject({ code: -32602 })
    await expect(harness.client.request(methods.agent.initialize, {
      protocolVersion: 2,
      info: { name: 't3-code-provider-probe', version: '0.1.10' },
      capabilities: {
        _meta: { terminal_output: true },
        elicitation: { form: {} },
        session: { configOptions: { boolean: {} } },
      },
    } as never)).resolves.toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: 'dsh-acp-interactive' },
    })
  })

  it('Pitfall 2: launches MCP stdio commands with spaces in path, env propagation, and server/discover -> -32601 fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-t3-mcp-'))
    roots.push(root)
    const spaceDir = join(root, 'T3 Code App', 'bin')
    await mkdir(spaceDir, { recursive: true })
    const bridgeScript = join(spaceDir, 'acp mcp bridge.mjs')
    const traceFile = join(root, 'mcp-trace.json')
    await writeFile(bridgeScript, [
      `#!${process.execPath}`,
      'import { createInterface } from "node:readline";',
      'import { writeFileSync } from "node:fs";',
      'const methods = [];',
      'const rl = createInterface({ input: process.stdin });',
      'rl.on("line", (line) => {',
      '  if (!line.trim()) return;',
      '  const msg = JSON.parse(line);',
      '  methods.push(msg.method);',
      '  if (msg.id === undefined) return;',
      '  if (msg.method === "server/discover") {',
      '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } }) + "\\n");',
      '    return;',
      '  }',
      '  if (msg.method === "initialize") {',
      '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "t3-bridge", version: "0.1.10" } } }) + "\\n");',
      '    return;',
      '  }',
      '  if (msg.method === "tools/list") {',
      '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "t3_echo", description: "Echo T3 bridge env", inputSchema: { type: "object", properties: { msg: { type: "string" } } } }] } }) + "\\n");',
      '    return;',
      '  }',
      '  if (msg.method === "tools/call") {',
      '    setTimeout(() => {',
      `      writeFileSync(${JSON.stringify(traceFile)}, JSON.stringify({ methods, endpoint: process.env.T3_ACP_MCP_ENDPOINT, auth: process.env.T3_ACP_MCP_AUTHORIZATION }));`,
      '      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify({ endpoint: process.env.T3_ACP_MCP_ENDPOINT, auth: process.env.T3_ACP_MCP_AUTHORIZATION }) }] } }) + "\\n");',
      '    }, 40);',
      '  }',
      '});',
      '',
    ].join('\n'), 'utf8')
    await chmod(bridgeScript, 0o755)

    harness = await makeHarness([
      [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        {
          type: 'block-end',
          index: 0,
          block: { type: 'tool-call', id: 't3-call' as never, name: 'mcp__t3_bridge__t3_echo', arguments: '{"msg":"hi"}' },
        },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ],
      textResponse('bridge done'),
    ])
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({
      cwd: root,
      mcpServers: [{
        name: 't3_bridge',
        command: bridgeScript,
        args: ['--bridge', 'with spaces'],
        env: [
          { name: 'T3_ACP_MCP_ENDPOINT', value: 'http://127.0.0.1:41234/mcp' },
          { name: 'T3_ACP_MCP_AUTHORIZATION', value: 'Bearer t3-token' },
        ],
      }],
    })
    expect(process.env.T3_ACP_MCP_ENDPOINT).toBeUndefined()
    await expect(harness.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'call bridge' }],
    })).resolves.toEqual({ stopReason: 'end_turn' })
    const traced = JSON.parse(await readFile(traceFile, 'utf8')) as {
      methods: string[]
      endpoint: string
      auth: string
    }
    expect(traced.endpoint).toBe('http://127.0.0.1:41234/mcp')
    expect(traced.auth).toBe('Bearer t3-token')
    expect(traced.methods).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call'])
    await harness.client.closeSession({ sessionId: created.sessionId })
  })

  it('Pitfall 3: leaves zero disk residue for built-launcher t3-code-provider-test and t3-code-provider-probe', { timeout: 25_000 }, async () => {
    for (const probeMode of ['v1', 'v2'] as const) {
      const root = await mkdtemp(join(tmpdir(), `dsh-t3-probe-${probeMode}-`))
      roots.push(root)
      const home = join(root, '.dsh')
      const agentsHome = join(root, 'agents')
      const sessionsRoot = join(root, 'acp-sessions')
      await Promise.all([mkdir(home), mkdir(agentsHome), mkdir(sessionsRoot)])

      const child = spawn(process.execPath, [BIN_PATH], {
        cwd: root,
        env: {
          ...process.env,
          DSH_HOME: home,
          DSH_AGENTS_HOME: agentsHome,
          DSH_ACP_SESSIONS_ROOT: sessionsRoot,
          DEEPSEEK_API_KEY: 'sk-t3-probe',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const updates: SessionNotification['update'][] = []
      const client = new ClientSideConnection((_agent: Agent): Client => ({
        sessionUpdate: async update => { updates.push(update.update) },
        requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      }), ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      ))
      try {
        if (probeMode === 'v1') {
          await client.initialize({
            protocolVersion: PROTOCOL_VERSION,
            clientInfo: { name: 't3-code-provider-test', version: '0.1.10' },
            clientCapabilities: {},
          })
        } else {
          // Send raw v2-only initialize without clientInfo.
          await client.initialize({
            protocolVersion: 2 as never,
            info: { name: 't3-code-provider-probe', version: '0.1.10' },
          } as never)
        }
        const session = await client.newSession({ cwd: root, mcpServers: [] })
        expect(session.configOptions?.length).toBeGreaterThan(0)
        expect(session.modes?.availableModes.map(m => m.id)).toEqual(['default', 'plan'])
        await vi.waitFor(() => {
          expect(updates.some(u => u.sessionUpdate === 'available_commands_update')).toBe(true)
        })
        await client.cancel({ sessionId: session.sessionId })
        await client.closeSession({ sessionId: session.sessionId })
      } finally {
        child.stdin.end()
        await new Promise<void>(resolveClose => child.once('close', () => resolveClose()))
      }

      expect(await listFilesRecursive(sessionsRoot)).toEqual([])
      expect(await listFilesRecursive(join(home, 'acp-sessions'))).toEqual([])
      expect(await listFilesRecursive(agentsHome)).toEqual([])
    }
  })

  it('Pitfall 3: lazily materializes probe sessions on mutation/prompt and handles close/quiesce without agents', async () => {
    harness = await makeHarness([textResponse('after-probe'), textResponse('mode-switched')])
    await harness.ctx.plugin(PlanModeController, { section: 'Plan.' })
    harness.ctx.provide('permissionPresets', {
      names: ['read-only', 'auto'],
      current: () => 'read-only',
      optionOf: (name: string) => ({ value: name, name }),
    } as never)
    harness.ctx.commands.register({
      name: 'permission',
      description: 'Switch permission preset',
      handler: () => ({ kind: 'success', text: 'switched' }),
    })

    await harness.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: 't3-code-provider-test', version: '0.1.10' },
      clientCapabilities: {},
    })

    // Unmaterialized probe cleaned up via quiesce() (bridge disposal) -> zero persisted records.
    const disposedProbe = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    expect(harness.ctx.agents.list()).toEqual([])
    expect(harness.persisted.size).toBe(0)
    await harness.client.cancel({ sessionId: disposedProbe.sessionId })
    expect(harness.ctx.agents.list()).toEqual([])
    expect(harness.persisted.size).toBe(0)

    // Invalid config/mode checks must not trigger materialization.
    await expect(harness.client.setSessionConfigOption({
      sessionId: disposedProbe.sessionId,
      configId: 'unknown',
      value: 'x',
    })).rejects.toThrow(/unknown session configuration/)
    await expect(harness.client.setSessionMode({
      sessionId: disposedProbe.sessionId,
      modeId: 'nonexistent',
    })).rejects.toThrow(/unknown session mode/)
    expect(harness.ctx.agents.list()).toEqual([])

    // Lazy materialization through setSessionConfigOption(model), permission, setSessionMode, and prompt.
    const materializedProbe = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    expect(harness.ctx.agents.get(SessionId(materializedProbe.sessionId))).toBeUndefined()
    await harness.client.setSessionConfigOption({
      sessionId: materializedProbe.sessionId,
      configId: 'model',
      value: 'mock:alternate',
    })
    expect(harness.ctx.agents.get(SessionId(materializedProbe.sessionId))).toBeDefined()
    await harness.client.setSessionConfigOption({
      sessionId: materializedProbe.sessionId,
      configId: 'permission',
      value: 'auto',
    })
    await harness.client.setSessionMode({
      sessionId: materializedProbe.sessionId,
      modeId: 'plan',
    })
    await expect(harness.client.prompt({
      sessionId: materializedProbe.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    })).resolves.toEqual({ stopReason: 'end_turn' })
    expect(harness.adapter.requests[0]?.model).toBe('alternate')

    // Lazy materialization directly from prompt + concurrent materialization serialization.
    const createOrig = harness.ctx.agents.create.bind(harness.ctx.agents)
    const gate = Promise.withResolvers<void>()
    const creating = Promise.withResolvers<void>()
    const createSpy = vi.spyOn(harness.ctx.agents, 'create').mockImplementationOnce(async (opts) => {
      creating.resolve()
      await gate.promise
      return createOrig(opts)
    })
    const promptProbe = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const p1 = harness.client.setSessionMode({ sessionId: promptProbe.sessionId, modeId: 'plan' })
    await creating.promise
    const p2 = harness.client.prompt({ sessionId: promptProbe.sessionId, prompt: [{ type: 'text', text: 'concurrent' }] })
    gate.resolve()
    await expect(Promise.all([p1, p2])).resolves.toEqual([{}, { stopReason: 'end_turn' }])
    createSpy.mockRestore()

    // Failing materialization reports internal error when create rejects.
    const failProbe = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    vi.spyOn(harness.ctx.agents, 'create').mockRejectedValueOnce(new Error('factory boom'))
    await expect(harness.client.setSessionMode({ sessionId: failProbe.sessionId, modeId: 'plan' }))
      .rejects.toThrow(/session creation failed: factory boom/)

    // Unmaterialized probe still open during bridge dispose quiesces cleanly without throwing.
    await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.acpFiber.dispose()
  })

  it('Pitfall 3: materializes probe client immediately when mcpServers is non-empty and covers omitted fallback selection', async () => {
    harness = await makeHarness([], {})
    await harness.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: 't3-code-provider-test', version: '0.1.10' },
      clientCapabilities: {},
    })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    expect(created.configOptions).toEqual([])
    expect(harness.ctx.agents.get(SessionId(created.sessionId))).toBeUndefined()
    await harness.client.closeSession({ sessionId: created.sessionId })

    // With MCP server present, even probe client materializes immediately to validate/connect MCP.
    const httpRequests: string[] = []
    const httpServer = createServer((req, res) => {
      httpRequests.push(req.method ?? '')
      res.writeHead(405).end()
    })
    await new Promise<void>(r => httpServer.listen(0, '127.0.0.1', r))
    const addr = httpServer.address() as { port: number }
    try {
      await expect(harness.client.newSession({
        cwd: process.cwd(),
        mcpServers: [{ type: 'http', name: 'probe-mcp', url: `http://127.0.0.1:${addr.port}/mcp`, headers: [] }],
      })).rejects.toThrow(/initial connection or tool discovery failed/)
      expect(httpRequests.length).toBeGreaterThan(0)
    } finally {
      await new Promise<void>(r => httpServer.close(() => r()))
    }
  })

  it('Pitfall 4: gates image capability on supported MIME types and rejects text-only routes before saving bytes', async () => {
    // 1. Unsupported-only attachment MIME type suppresses image capability.
    harness = await makeHarness([])
    harness.ctx.provide('attachments', { imageLimits: { maxBytes: 1024, maxCount: 1, mediaTypes: ['image/svg+xml'] } } as never)
    const svgInit = await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    expect(svgInit.agentCapabilities?.promptCapabilities?.image).toBe(false)
    await harness.dispose()

    // 2. Real attachment store advertises image=true, but text-only model rejects before persistence;
    //    switching to vision model succeeds cleanly.
    harness = await makeHarness([textResponse('saw the png')])
    const saved: Uint8Array[] = []
    class SplitModalitiesAdapter extends LlmAdapter {
      readonly requests: GenerateOptions[] = []
      override listModels(provider: string) {
        return Promise.resolve([
          { provider, id: 'text-only', name: 'Text Only', inputModalities: ['text'] as const },
          { provider, id: 'vision', name: 'Vision', inputModalities: ['text', 'image'] as const },
        ])
      }
      override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
        return Promise.resolve({
          provider,
          id: model,
          name: model,
          inputModalities: model === 'vision' ? ['text', 'image'] : ['text'],
          context: { contextWindow: 64_000 },
        })
      }
      async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        this.requests.push(options)
        for (const chunk of textResponse('saw the png')) yield chunk
      }
    }
    const splitAdapter = new SplitModalitiesAdapter()
    harness.ctx.llm.registerAdapter(['split'], splitAdapter)
    await harness.ctx.plugin(T3TestAttachments)
    const attachments = harness.ctx.get('attachments')
    if (attachments === undefined) throw new Error('missing attachments service')
    const baseSave = attachments.saveImage.bind(attachments)
    const saveSpy = vi.spyOn(attachments, 'saveImage').mockImplementation(async (input) => {
      saved.push(input.data)
      return await baseSave(input)
    })

    const init = await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    expect(init.agentCapabilities?.promptCapabilities?.image).toBe(true)

    const session = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'model',
      value: 'split:text-only',
    })

    await expect(harness.client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'image', data: 'AQ==', mimeType: 'image/png' }],
    })).rejects.toMatchObject({
      code: -32602,
      message: expect.stringContaining('model "text-only" does not declare image input'),
    })
    expect(saveSpy).not.toHaveBeenCalled()
    expect(saved).toEqual([])
    expect(splitAdapter.requests).toEqual([])

    await harness.client.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'model',
      value: 'split:vision',
    })
    await expect(harness.client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'image', data: 'AQ==', mimeType: 'image/png' }],
    })).resolves.toEqual({ stopReason: 'end_turn' })
    expect(saveSpy).toHaveBeenCalledTimes(1)
    expect(splitAdapter.requests[0]?.messages.at(-1)?.content[0]).toMatchObject({ type: 'image' })
  })
})
