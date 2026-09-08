#!/usr/bin/env node
/** Start the self-contained ACP composition shipped by this package. */

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { boot, installFailLoud, loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { runDeepSeekApiKeySetup } from './setup.js'

const packageRoot = dirname(fileURLToPath(import.meta.url))
const configPath = join(packageRoot, '..', 'config', 'cordis.yml')
const setupConfigPath = join(packageRoot, '..', 'config', 'setup.yml')
installFailLoud('dsh-acp-interactive')
const environment = loadLayeredEnv('dsh-acp-interactive')
const setup = process.argv.slice(2).includes('--setup')
const ctx = await boot(
  'dsh-acp-interactive',
  setup ? setupConfigPath : configPath,
  undefined,
  host => { host.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment) },
)
if (setup) {
  try {
    await runDeepSeekApiKeySetup(ctx.credentials)
  } finally {
    await ctx.fiber.dispose()
  }
} else {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void ctx.fiber.dispose().finally(() => process.exit(signal === 'SIGINT' ? 130 : 0))
    })
  }
}
