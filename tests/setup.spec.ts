/** Terminal-auth onboarding delegates all persistence to the Harness credential seam. */

import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { runDeepSeekApiKeySetup } from '../src/setup.js'

function setupIO(answer = '', terminal = false): {
  input: PassThrough
  output: PassThrough
  text: () => string
} {
  const input = new PassThrough()
  Object.defineProperty(input, 'isTTY', { value: terminal })
  const output = new PassThrough()
  let text = ''
  output.setEncoding('utf8')
  output.on('data', chunk => { text += String(chunk) })
  setImmediate(() => input.end(`${answer}\n`))
  return { input, output, text: () => text }
}

describe('DeepSeek API key terminal setup', () => {
  it('stores a non-empty key without echoing it', async () => {
    const credentials = {
      describe: vi.fn(async () => ({ configured: false, writable: true })),
      set: vi.fn(async () => undefined),
    }
    const io = setupIO('  sk-secret-value  ', true)

    await runDeepSeekApiKeySetup(credentials as never, io)

    expect(credentials.set).toHaveBeenCalledWith('DEEPSEEK_API_KEY', 'sk-secret-value')
    expect(io.text()).toContain('DeepSeek API key saved')
    expect(io.text()).not.toContain('sk-secret-value')
  })

  it('keeps an existing writable key when the answer is blank', async () => {
    const credentials = {
      describe: vi.fn(async () => ({ configured: true, source: 'file', writable: true })),
      set: vi.fn(),
    }
    const io = setupIO()

    await runDeepSeekApiKeySetup(credentials as never, io)

    expect(credentials.set).not.toHaveBeenCalled()
    expect(io.text()).toContain('Existing DeepSeek API key kept')
  })

  it('accepts an inherited environment key without attempting a shadowed write', async () => {
    const credentials = {
      describe: vi.fn(async () => ({ configured: true, source: 'env', writable: false })),
      set: vi.fn(),
    }
    const io = setupIO('unused')

    await runDeepSeekApiKeySetup(credentials as never, io)

    expect(credentials.set).not.toHaveBeenCalled()
    expect(io.text()).toContain('already supplied by the launching environment')
  })

  it('rejects empty new keys and control characters', async () => {
    const credentials = {
      describe: vi.fn(async () => ({ configured: false, writable: true })),
      set: vi.fn(),
    }
    await expect(runDeepSeekApiKeySetup(credentials as never, setupIO()))
      .rejects.toThrow('cannot be empty')
    await expect(runDeepSeekApiKeySetup(credentials as never, setupIO('sk-bad\u0007key')))
      .rejects.toThrow('control characters')
    expect(credentials.set).not.toHaveBeenCalled()
  })

  it('rejects when the terminal prompt is interrupted', async () => {
    const credentials = {
      describe: vi.fn(async () => ({ configured: false, writable: true })),
      set: vi.fn(),
    }
    const io = setupIO('\u0003', true)

    await expect(runDeepSeekApiKeySetup(credentials as never, io))
      .rejects.toThrow('setup was cancelled')
    expect(credentials.set).not.toHaveBeenCalled()
  })
})
