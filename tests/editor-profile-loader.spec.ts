/** Real Loader coverage for the selected filesystem-search lifecycle. */

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const marker = '__DSH_EDITOR_PROFILE__'

it('loads packaged filesystem search with exact cwd and pre-dispatch cancellation', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-editor-profile-'))
  const sessions = join(workspace, 'sessions')
  await mkdir(sessions)
  await writeFile(join(workspace, 'profile-marker.ts'), 'export const profileMarker = true\n')
  const config = resolve('config/cordis.yml')
  const script = [
    "import { boot, loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'",
    "import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'",
    "import { ToolCallId } from '@deepseek-ai/dsh-llm'",
    "import { SessionId } from '@deepseek-ai/dsh-session'",
    `const environment = loadLayeredEnv('editor-profile-test')`,
    `const ctx = await boot('editor-profile-test', ${JSON.stringify(config)}, undefined, host => { host.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment) })`,
    `const handle = await ctx.agents.create({ sessionId: SessionId('editor-profile'), meta: { cwd: ${JSON.stringify(workspace)} } })`,
    'const agent = handle.agent',
    "const live = await ctx.tools.execute({ callId: ToolCallId('profile-live'), name: 'glob', arguments: { pattern: 'profile-marker.ts' }, agent, signal: new AbortController().signal })",
    'const controller = new AbortController()',
    'controller.abort()',
    "const cancelled = await ctx.tools.execute({ callId: ToolCallId('profile-cancel'), name: 'grep', arguments: { pattern: 'profileMarker' }, agent, signal: controller.signal })",
    `console.error('${marker}' + JSON.stringify({ tools: ctx.tools.schemas(agent).map(tool => tool.name), live, cancelled }))`,
    'process.stdin.destroy()',
    'await handle.dispose()',
    'await ctx.fiber.dispose()',
  ].join(';')
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DSH_PERMISSION_MODE: 'danger-full-access',
        DSH_ACP_SESSIONS_ROOT: sessions,
      },
      maxBuffer: 10 * 1024 * 1024,
    })
    const line = stderr.split(/\r?\n/u).find(candidate => candidate.startsWith(marker))
    expect(line).toBeDefined()
    const result = JSON.parse(line!.slice(marker.length)) as {
      tools: string[]
      live: { isError: boolean; content: Array<{ type: string; text?: string }>; meta?: unknown }
      cancelled: { isError: boolean; error?: { info?: { code?: string } } }
    }
    expect(stdout).toBe('')
    expect(result.tools).toEqual(expect.arrayContaining(['glob', 'grep']))
    expect(result.live).toMatchObject({
      isError: false,
      content: [{ type: 'text', text: 'profile-marker.ts' }],
    })
    expect(result.live.meta).toBeDefined()
    expect(result.cancelled).toMatchObject({
      isError: true,
      error: { info: { code: 'ABORTED_BEFORE_DISPATCH' } },
    })
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
