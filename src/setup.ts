/**
 * Interactive onboarding for credentials consumed by the official DeepSeek
 * adapter. Storage remains owned by the composed Harness credentials service.
 */

import { createInterface } from 'node:readline'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Writable, type Readable } from 'node:stream'
import { loadOptionalPatches, PROFILE_PATCH_FILENAME } from '@deepseek-ai/dsh-app-boot'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { parse } from 'yaml'
import { DEEPSEEK_API_KEY } from './auth.js'

/**
 * Load user patch layers from the dsh home: `$DSH_HOME/cordis.patch.yml`
 * or legacy `$DSH_HOME/settings.yaml`.
 */
export function loadUserPatches(binName: string, home: string = resolveDshHome()): PatchOptions[] | undefined {
  const patchFile = join(home, PROFILE_PATCH_FILENAME)
  const patches = loadOptionalPatches(binName, patchFile)
  if (patches !== undefined && patches.length > 0) return patches
  const legacySettings = join(home, 'settings.yaml')
  if (existsSync(legacySettings)) {
    try {
      const content = readFileSync(legacySettings, 'utf8')
      const doc = parse(content) as unknown
      if (typeof doc === 'object' && doc !== null && !Array.isArray(doc)) {
        return Object.entries(doc).map(([id, config]) => ({ id, config: config as Record<string, unknown> }))
      }
    } catch {
      // ignore malformed legacy settings
    }
  }
  return undefined
}

interface SetupIO {
  input: Readable
  output: Writable
}

function secretQuestion(prompt: string, io: SetupIO): Promise<string> {
  let muted = false
  const hiddenOutput = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) {
        io.output.write(chunk, encoding, callback)
      } else {
        callback()
      }
    },
  })
  const terminal = Boolean((io.input as NodeJS.ReadStream).isTTY)
  const readline = createInterface({ input: io.input, output: hiddenOutput, terminal })
  return new Promise<string>((resolve, reject) => {
    const finish = (action: () => void): void => {
      readline.close()
      muted = false
      io.output.write('\n')
      action()
    }
    readline.once('SIGINT', () => {
      finish(() => reject(new Error('DeepSeek API key setup was cancelled.')))
    })
    readline.question(prompt, answer => {
      finish(() => resolve(answer))
    })
    muted = true
  })
}

/**
 * Prompt for and durably store the API key reference used by
 * `@deepseek-ai/dsh-llm-deepseek`.
 */
export async function runDeepSeekApiKeySetup(
  credentials: Pick<CredentialProvider, 'describe' | 'set'>,
  io: SetupIO = { input: process.stdin, output: process.stderr },
): Promise<void> {
  const current = await credentials.describe(DEEPSEEK_API_KEY)
  if (current.configured && !current.writable) {
    io.output.write(
      'DeepSeek API key is already supplied by the launching environment; no file was changed.\n',
    )
    return
  }

  const qualifier = current.configured ? ' (leave blank to keep the current key)' : ''
  const value = (await secretQuestion(`Enter DeepSeek API key${qualifier}: `, io)).trim()
  if (value.length === 0) {
    if (current.configured) {
      io.output.write('Existing DeepSeek API key kept.\n')
      return
    }
    throw new Error('DeepSeek API key cannot be empty.')
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('DeepSeek API key cannot contain control characters.')
  }

  await credentials.set(DEEPSEEK_API_KEY, value)
  io.output.write('DeepSeek API key saved in the Harness credential store.\n')
}
