/** Real Loader coverage for the bundled platform-specific shell composition. */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const marker = '__DSH_PLATFORM_SHELL__'

it('registers and executes PowerShell on Windows or Bash on POSIX hosts', async () => {
  const script = [
    "import { boot, loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'",
    "import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'",
    "import { resolve } from 'node:path'",
    "const environment = loadLayeredEnv('platform-shell-test')",
    "const ctx = await boot('platform-shell-test', resolve('config/cordis.yml'), undefined, host => { host.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment) })",
    "const expected = process.platform === 'win32' ? 'pwsh' : 'bash'",
    "const unexpected = process.platform === 'win32' ? 'bash' : 'pwsh'",
    "const command = process.platform === 'win32' ? 'Write-Output dsh-shell-ok' : 'printf dsh-shell-ok'",
    "const tools = ctx.tools.schemas().map(tool => tool.name)",
    "const result = await ctx.shell.run(ctx.shell.resolve({ command }))",
    `console.error('${marker}' + JSON.stringify({ expected, unexpected, tools, exitCode: result.exitCode, stdout: result.stdout.text }))`,
    'process.stdin.destroy()',
    'await ctx.fiber.dispose()',
  ].join(';')
  const { stdout, stderr } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, DSH_PERMISSION_MODE: 'danger-full-access' },
  })
  const line = stderr.split(/\r?\n/u).find(candidate => candidate.startsWith(marker))
  expect(line).toBeDefined()
  const result = JSON.parse(line!.slice(marker.length)) as {
    expected: string
    unexpected: string
    tools: string[]
    exitCode: number | null
    stdout: string
  }

  expect(stdout).toBe('')
  expect(result.tools).toContain(result.expected)
  expect(result.tools).not.toContain(result.unexpected)
  expect(result.exitCode).toBe(0)
  expect(result.stdout.trim()).toBe('dsh-shell-ok')
})
