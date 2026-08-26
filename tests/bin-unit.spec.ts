/** Unit coverage for launcher wiring that a child-process coverage collector cannot observe. */

import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  boot: vi.fn(),
  dispose: vi.fn(() => Promise.resolve()),
  environment: { values: new Map() },
  installFailLoud: vi.fn(),
  loadLayeredEnv: vi.fn(),
  provide: vi.fn(),
  launchEnvironmentKey: Symbol('launch-environment'),
}))

vi.mock('@deepseek-ai/dsh-app-boot', () => ({
  boot: mocks.boot,
  installFailLoud: mocks.installFailLoud,
  loadLayeredEnv: mocks.loadLayeredEnv,
}))

vi.mock('@deepseek-ai/dsh-launch-environment', () => ({
  DSH_LAUNCH_ENVIRONMENT_KEY: mocks.launchEnvironmentKey,
}))

afterEach(() => {
  vi.restoreAllMocks()
})

it('boots the package config and disposes on both supported process signals', async () => {
  const listeners = new Map<string, () => void>()
  vi.spyOn(process, 'once').mockImplementation((event, listener) => {
    listeners.set(String(event), listener as () => void)
    return process
  })
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  mocks.loadLayeredEnv.mockReturnValue(mocks.environment)
  mocks.boot.mockImplementation(async (_name, _configPath, _overlay, configureHost) => {
    configureHost({ provide: mocks.provide })
    return { fiber: { dispose: mocks.dispose } }
  })

  await import('../src/bin.js')

  expect(mocks.installFailLoud).toHaveBeenCalledWith('dsh-acp-interactive')
  expect(mocks.loadLayeredEnv).toHaveBeenCalledWith('dsh-acp-interactive')
  expect(mocks.boot).toHaveBeenCalledWith(
    'dsh-acp-interactive',
    expect.stringMatching(/[\\/]config[\\/]cordis\.yml$/),
    undefined,
    expect.any(Function),
  )
  expect(mocks.provide).toHaveBeenCalledWith(mocks.launchEnvironmentKey, mocks.environment)

  listeners.get('SIGTERM')?.()
  await vi.waitFor(() => { expect(exit).toHaveBeenCalledWith(0) })
  listeners.get('SIGINT')?.()
  await vi.waitFor(() => { expect(exit).toHaveBeenCalledWith(130) })
  expect(mocks.dispose).toHaveBeenCalledTimes(2)
})
