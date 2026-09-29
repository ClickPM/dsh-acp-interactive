#!/usr/bin/env node
/** Start the self-contained ACP composition shipped by this package. */

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { finished } from 'node:stream'
import { boot, installFailLoud, loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { loadUserPatches, runDeepSeekApiKeySetup } from './setup.js'

const packageRoot = dirname(fileURLToPath(import.meta.url))
const configPath = join(packageRoot, '..', 'config', 'cordis.yml')
const setupConfigPath = join(packageRoot, '..', 'config', 'setup.yml')
installFailLoud('dsh-acp-interactive')
const environment = loadLayeredEnv('dsh-acp-interactive')
const setup = process.argv.slice(2).includes('--setup')
const home = environment.get('DSH_HOME')?.value ?? resolveDshHome()
const userPatches = loadUserPatches('dsh-acp-interactive', home)
const ctx = await boot(
  'dsh-acp-interactive',
  setup ? setupConfigPath : configPath,
  userPatches,
  host => { host.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment) },
)
if (setup) {
  try {
    await runDeepSeekApiKeySetup(ctx.credentials)
  } finally {
    await ctx.fiber.dispose()
  }
} else {
  const stop = (code: number): void => {
    void ctx.fiber.dispose().finally(() => process.exit(code))
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => stop(signal === 'SIGINT' ? 130 : 0))
  }
  // The client owns the transport: once our stdin has ended (or already had
  // by the time boot finished) the ACP connection is over, and the
  // composition's watchers and indexes must not keep this process alive.
  finished(process.stdin, () => stop(0))
}
