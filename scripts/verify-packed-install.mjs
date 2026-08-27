/** Install the packed artifact outside the repository and boot its real ACP profile. */

import { spawn, execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Readable, Writable } from 'node:stream'
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { compositionPackages } from './profile-audit-lib.mjs'

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const npmCli = resolve(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
const root = await mkdtemp(join(tmpdir(), 'dsh-acp-packed-'))

try {
  await execFileAsync(process.execPath, [npmCli, 'run', 'build'], {
    cwd: repositoryRoot,
    maxBuffer: 10 * 1024 * 1024,
  })
  const pack = await execFileAsync(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', root], {
    cwd: repositoryRoot,
    maxBuffer: 10 * 1024 * 1024,
  })
  const packed = JSON.parse(pack.stdout)
  const archive = join(root, packed[0].filename)
  const installRoot = join(root, 'install')
  const workspace = join(root, 'workspace')
  const dshHome = join(root, 'dsh-home')
  await Promise.all([mkdir(installRoot), mkdir(workspace), mkdir(dshHome)])
  await writeFile(join(installRoot, 'package.json'), '{"private":true}\n')
  await execFileAsync(process.execPath, [npmCli, 'install', '--ignore-scripts', '--no-audit', '--no-fund', archive], {
    cwd: installRoot,
    maxBuffer: 10 * 1024 * 1024,
  })

  const installedRoot = join(installRoot, 'node_modules', 'dsh-acp-interactive')
  const configPath = join(installedRoot, 'config', 'cordis.yml')
  const packages = compositionPackages(await readFile(configPath, 'utf8'))
  const requireFromInstall = createRequire(join(installRoot, 'package.json'))
  for (const name of packages) requireFromInstall.resolve(`${name}/package.json`)
  requireFromInstall.resolve('@vscode/ripgrep')

  const updates = []
  const child = spawn(process.execPath, [join(installedRoot, 'lib', 'bin.js')], {
    cwd: workspace,
    env: {
      ...process.env,
      DSH_HOME: dshHome,
      DSH_ACP_SESSIONS_ROOT: join(root, 'sessions'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stderr = []
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => stderr.push(String(chunk)))
  const client = new ClientSideConnection(() => ({
    sessionUpdate: async update => { updates.push(update.update) },
    requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
  }), ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout),
  ))
  try {
    await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const session = await client.newSession({ cwd: workspace, mcpServers: [] })
    if (typeof session.sessionId !== 'string') throw new Error('packed launcher did not create a session')
    await waitFor(() => updates.some(update => update.sessionUpdate === 'available_commands_update'))
  } catch (error) {
    throw new Error(`${String(error)}\npacked launcher stderr:\n${stderr.join('')}`)
  } finally {
    child.kill('SIGTERM')
    await new Promise(resolveClose => child.once('close', resolveClose))
  }
  console.error(`Packed-install verification passed: ${packages.length} profile plugins resolved and the installed launcher created a session.`)
} finally {
  await rm(root, { recursive: true, force: true })
}

async function waitFor(predicate) {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for packed launcher update')
    await new Promise(resolveWait => setTimeout(resolveWait, 20))
  }
}
