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
  // npm 11 can forward prepare/build output ahead of `npm pack --json` even
  // with --ignore-scripts. Parse from the JSON array instead of assuming the
  // machine-readable payload is the only stdout content.
  const jsonStart = pack.stdout.search(/^\s*\[\s*\{/m)
  if (jsonStart < 0) throw new Error(`npm pack did not emit JSON:\n${pack.stdout}`)
  const packed = JSON.parse(pack.stdout.slice(jsonStart))
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

  const installedRoot = join(installRoot, 'node_modules', 'deepseekharness-acp-interactive')
  const configPath = join(installedRoot, 'config', 'cordis.yml')
  const packages = compositionPackages(await readFile(configPath, 'utf8'))
  const setupPackages = compositionPackages(await readFile(
    join(installedRoot, 'config', 'setup.yml'),
    'utf8',
  ))
  const requireFromInstall = createRequire(join(installRoot, 'package.json'))
  for (const name of new Set([...packages, ...setupPackages])) {
    requireFromInstall.resolve(`${name}/package.json`)
  }
  for (const name of [
    '@deepseek-ai/dsh-mcp-client',
    '@deepseek-ai/dsh-subprocess',
    '@deepseek-ai/dsh-timeout',
    '@modelcontextprotocol/sdk',
    'zod',
  ]) requireFromInstall.resolve(`${name}/package.json`)
  requireFromInstall.resolve('@vscode/ripgrep')

  const mcpMarker = join(root, 'mcp-lifecycle.log')
  const mcpServer = join(installRoot, 'packed-mcp-server.mjs')
  await writeFile(mcpServer, [
    "import readline from 'node:readline'",
    "import { appendFileSync } from 'node:fs'",
    "const marker = process.env.PACKED_MCP_MARKER",
    "appendFileSync(marker, `started:${process.pid}\\n`)",
    "const lines = readline.createInterface({ input: process.stdin })",
    "for await (const line of lines) {",
    " const message = JSON.parse(line)",
    " let result",
    " if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'packed', version: '1' } }",
    " else if (message.method === 'tools/list') { appendFileSync(marker, 'listed\\n'); result = { tools: [{ name: 'ping', description: 'Packed install probe', inputSchema: { type: 'object', properties: {} } }] } }",
    " else if (message.method === 'tools/call') result = { content: [{ type: 'text', text: 'pong' }] }",
    " if (message.id !== undefined && result !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n')",
    "}",
  ].join('\n'))

  const setupKey = 'sk-packed-setup-probe'
  const setupResult = await spawnWithInput(
    process.execPath,
    [join(installedRoot, 'lib', 'bin.js'), '--setup'],
    `${setupKey}\n`,
    {
      cwd: workspace,
      env: { ...process.env, DSH_HOME: dshHome, DEEPSEEK_API_KEY: undefined },
    },
  )
  if (setupResult.code !== 0) {
    throw new Error(`packed terminal setup failed:\n${setupResult.stderr}`)
  }
  if (setupResult.stdout !== '' || setupResult.stderr.includes(setupKey)) {
    throw new Error('packed terminal setup leaked its API key or wrote to stdout')
  }
  const credentials = await readFile(join(dshHome, '.credentials.yaml'), 'utf8')
  if (!credentials.includes(`DEEPSEEK_API_KEY: ${setupKey}`)) {
    throw new Error('packed terminal setup did not persist DEEPSEEK_API_KEY')
  }

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
    const initialized = await client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { auth: { terminal: true } },
    })
    if (initialized.agentCapabilities?.mcpCapabilities?.http !== true) {
      throw new Error('packed launcher did not advertise MCP HTTP capability')
    }
    if (initialized.authMethods?.some(method => (
      method.id === 'deepseek-api-key'
      && method.type === 'terminal'
      && method.args?.includes('--setup')
    )) !== true) {
      throw new Error('packed launcher did not advertise DeepSeek terminal authentication')
    }
    const session = await client.newSession({
      cwd: workspace,
      mcpServers: [{
        name: 'packed',
        command: process.execPath,
        args: [mcpServer],
        env: [{ name: 'PACKED_MCP_MARKER', value: mcpMarker }],
      }],
    })
    if (typeof session.sessionId !== 'string') throw new Error('packed launcher did not create a session')
    await waitFor(() => updates.some(update => update.sessionUpdate === 'available_commands_update'))
    await waitFor(async () => (await readFile(mcpMarker, 'utf8')).includes('listed'))
    const started = await readFile(mcpMarker, 'utf8')
    const pid = Number(/started:(\d+)/.exec(started)?.[1])
    await client.closeSession({ sessionId: session.sessionId })
    await waitFor(() => {
      try { process.kill(pid, 0); return false } catch { return true }
    })
  } catch (error) {
    throw new Error(`${String(error)}\npacked launcher stderr:\n${stderr.join('')}`)
  } finally {
    child.kill('SIGTERM')
    await new Promise(resolveClose => child.once('close', resolveClose))
  }
  console.error(`Packed-install verification passed: ${packages.length} profile plugins and setup/MCP runtime dependencies resolved; terminal auth persisted a credential, and the installed launcher started and stopped a session MCP server.`)
} finally {
  await rm(root, { recursive: true, force: true })
}

async function waitFor(predicate) {
  const deadline = Date.now() + 5_000
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for packed launcher update')
    await new Promise(resolveWait => setTimeout(resolveWait, 20))
  }
}

function spawnWithInput(command, args, input, options) {
  return new Promise((resolveSpawn, rejectSpawn) => {
    const child = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('error', rejectSpawn)
    child.once('close', code => resolveSpawn({ code, stdout, stderr }))
    child.stdin.end(input)
  })
}
