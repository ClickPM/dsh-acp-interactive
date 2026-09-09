/** The built launcher gates session/new on the DeepSeek key and sees a key stored afterwards. */

import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { afterEach, expect, it } from 'vitest'
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent,
  type Client,
} from '@agentclientprotocol/sdk'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it('returns auth_required from session/new until DEEPSEEK_API_KEY is stored', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-acp-auth-gate-'))
  roots.push(root)
  const home = join(root, '.dsh')
  await mkdir(home, { mode: 0o700 })
  const child = spawn(process.execPath, [join(process.cwd(), 'lib', 'bin.js')], {
    cwd: root,
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_ACP_SESSIONS_ROOT: join(root, 'sessions'),
      DEEPSEEK_API_KEY: undefined,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stderr: string[] = []
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => stderr.push(String(chunk)))
  const client = new ClientSideConnection((_agent: Agent): Client => ({
    sessionUpdate: async () => {},
    requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
  }), ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  ))
  try {
    const initialized = await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    expect(initialized.authMethods?.[0]).toMatchObject({ id: 'deepseek-api-key' })
    await expect(client.newSession({ cwd: root, mcpServers: [] }))
      .rejects.toMatchObject({ code: -32000, message: expect.stringContaining('--setup') })
    await expect(client.authenticate({ methodId: 'deepseek-api-key' })).resolves.toEqual({})

    // A key stored by --setup (or by hand) is seen by a following session/new without a
    // restart, once credentials-local's debounced watcher has reloaded the file.
    // credentials-local refuses a credentials file readable beyond its owner on POSIX.
    await writeFile(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-gate-test\n', { mode: 0o600 })
    const deadline = Date.now() + 10_000
    let sessionId: string | undefined
    while (sessionId === undefined) {
      try {
        sessionId = (await client.newSession({ cwd: root, mcpServers: [] })).sessionId
      } catch (error: unknown) {
        if ((error as { code?: number }).code !== -32000 || Date.now() >= deadline) throw error
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
    await client.closeSession({ sessionId })
  } catch (error: unknown) {
    throw new Error(`${String(error)}\nstderr:\n${stderr.join('')}`)
  } finally {
    child.kill('SIGTERM')
    await new Promise<void>(resolve => child.once('close', () => resolve()))
  }
})
