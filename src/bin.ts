#!/usr/bin/env node
/** Start the self-contained ACP composition shipped by this package. */

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { boot, installFailLoud, loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'

const packageRoot = dirname(fileURLToPath(import.meta.url))
const configPath = join(packageRoot, '..', 'config', 'cordis.yml')
installFailLoud('dsh-acp-interactive')
const environment = loadLayeredEnv('dsh-acp-interactive')
const ctx = await boot(
  'dsh-acp-interactive',
  configPath,
  undefined,
  host => { host.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment) },
)
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void ctx.fiber.dispose().finally(() => process.exit(signal === 'SIGINT' ? 130 : 0)) })
}
