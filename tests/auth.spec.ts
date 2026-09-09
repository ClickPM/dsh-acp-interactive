import { afterEach, describe, expect, it } from 'vitest'
import { assertRouteCredential, assertSessionCredential, authMethodsFor } from '../src/auth.js'

/**
 * A gate context whose strict lookup turns positive after `activeAfter` polls
 * and whose `describe()` answers from `configured` in call order (last value repeats).
 */
function lookup(configured: boolean | boolean[], activeAfter: number, composed = true, providers = ['deepseek-official']) {
  let strictCalls = 0
  let describeCalls = 0
  const answers = Array.isArray(configured) ? configured : [configured]
  const service = {
    describe: () => {
      const value = answers[Math.min(describeCalls, answers.length - 1)]
      describeCalls += 1
      return Promise.resolve({ configured: value, writable: true })
    },
  }
  return {
    get: (name: string, strict = true) => {
      if (name !== 'credentials' || !composed) return undefined
      if (!strict) return service
      strictCalls += 1
      return strictCalls > activeAfter ? service : undefined
    },
    llm: { listProviders: () => providers.map(id => ({ id })) },
    calls: () => strictCalls,
    describes: () => describeCalls,
  }
}

const original = process.env.DSH_HOME

afterEach(() => {
  if (original === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = original
})

describe('DeepSeek credential gate', () => {
  it('advertises the terminal method only to clients that declare terminal auth', () => {
    const stable = authMethodsFor({ auth: { terminal: true } })[0]
    expect(stable).toMatchObject({ type: 'terminal', args: ['--setup'] })
    expect(authMethodsFor({ _meta: { 'terminal-auth': true } })[0]).toMatchObject({ type: 'terminal' })
    expect(authMethodsFor({ auth: { terminal: false } })[0]).not.toHaveProperty('type')
    expect(authMethodsFor(undefined)[0]).toMatchObject({ id: 'deepseek-api-key' })
    expect(authMethodsFor(undefined)[0]).not.toHaveProperty('_meta')
  })

  it('carries the legacy Zed terminal-auth object naming this launcher, forwarding DSH_HOME only when set', () => {
    delete process.env.DSH_HOME
    const bare = authMethodsFor({ auth: { terminal: true } })[0]
    expect(bare).not.toHaveProperty('env')
    expect(bare?._meta).toEqual({
      'terminal-auth': {
        label: 'Configure DeepSeek API key',
        command: process.execPath,
        args: [expect.stringContaining('bin.js'), '--setup'],
        env: {},
      },
    })

    process.env.DSH_HOME = 'D:/dsh-home'
    const scoped = authMethodsFor({ auth: { terminal: true } })[0]
    expect(scoped).toMatchObject({ env: { DSH_HOME: 'D:/dsh-home' } })
    expect(scoped?._meta).toMatchObject({ 'terminal-auth': { env: { DSH_HOME: 'D:/dsh-home' } } })
  })

  it('waits for a composed credentials service that is still starting', async () => {
    const ctx = lookup(false, 3)
    await expect(assertSessionCredential(ctx, { provider: 'deepseek-official' }, undefined, undefined, 0))
      .rejects.toMatchObject({ code: -32000 })
    expect(ctx.calls()).toBe(4)

    const ready = lookup(true, 2)
    await expect(assertSessionCredential(ready, { provider: 'deepseek-official' })).resolves.toBeUndefined()
  })

  it('keeps re-reading an unconfigured key for the settle window', async () => {
    const late = lookup([false, false, true], 0)
    await expect(assertSessionCredential(late, { provider: 'deepseek-official' }, undefined, undefined, 2_000))
      .resolves.toBeUndefined()
    expect(late.describes()).toBe(3)

    const never = lookup(false, 0)
    await expect(assertSessionCredential(never, { provider: 'deepseek-official' }, undefined, undefined, 250))
      .rejects.toMatchObject({ code: -32000, message: expect.stringContaining('--setup') })
    expect(never.describes()).toBeGreaterThan(1)
  })

  it('does not hold session/new past the readiness bound or for an uncomposed service', async () => {
    const stuck = lookup(false, Number.POSITIVE_INFINITY)
    await expect(assertSessionCredential(stuck, { provider: 'deepseek-official' }, undefined, 120))
      .resolves.toBeUndefined()
    expect(stuck.calls()).toBeGreaterThan(1)

    const absent = lookup(false, 0, false)
    await expect(assertSessionCredential(absent, { provider: 'deepseek-official' })).resolves.toBeUndefined()
    expect(absent.calls()).toBe(0)
  })

  it('aborts the wait with the request and skips other default providers', async () => {
    const controller = new AbortController()
    const pending = assertSessionCredential(lookup(false, Number.POSITIVE_INFINITY), { provider: 'deepseek-official' }, controller.signal)
    controller.abort(new Error('cancelled'))
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })

    const other = lookup(false, 0)
    await expect(assertSessionCredential(other, { provider: 'mock' })).resolves.toBeUndefined()
    expect(other.calls()).toBe(0)
  })

  it('does not gate a directory that offers other providers', async () => {
    const routes = lookup(false, 0, true, ['deepseek-official', 'local-probe'])
    await expect(assertSessionCredential(routes, { provider: 'deepseek-official' })).resolves.toBeUndefined()
    expect(routes.calls()).toBe(0)
  })

  it('gates a prompt on the DeepSeek route regardless of other providers', async () => {
    const routes = lookup(false, 0, true, ['deepseek-official', 'local-probe'])
    await expect(assertRouteCredential(routes, 'deepseek-official', undefined, undefined, 0))
      .rejects.toMatchObject({ code: -32000, message: expect.stringContaining('--setup') })
    await expect(assertRouteCredential(routes, 'local-probe')).resolves.toBeUndefined()
    await expect(assertRouteCredential(routes, undefined)).resolves.toBeUndefined()
    await expect(assertRouteCredential(lookup(true, 0), 'deepseek-official')).resolves.toBeUndefined()
  })
})
