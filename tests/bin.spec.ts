/** Real subprocess coverage for the package-owned ACP launcher and composition. */

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
  type SessionNotification,
} from '@agentclientprotocol/sdk'

const roots: string[] = []

async function waitForUpdate(
  updates: SessionNotification['update'][],
  predicate: (update: SessionNotification['update']) => boolean,
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
    }, 2_000)
  })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

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
