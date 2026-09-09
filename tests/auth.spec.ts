import { describe, expect, it } from 'vitest'
import { assertSessionCredential, authMethodsFor } from '../src/auth.js'

/** A gate context whose strict lookup turns positive after `activeAfter` polls. */
function lookup(configured: boolean, activeAfter: number, composed = true, providers = ['deepseek-official']) {
  let strictCalls = 0
  const service = { describe: () => Promise.resolve({ configured, writable: true }) }
  return {
    get: (name: string, strict = true) => {
      if (name !== 'credentials' || !composed) return undefined
      if (!strict) return service
      strictCalls += 1
      return strictCalls > activeAfter ? service : undefined
    },
    llm: { listProviders: () => providers.map(id => ({ id })) },
    calls: () => strictCalls,
  }
}

describe('DeepSeek credential gate', () => {
  it('advertises the terminal method only to clients that declare terminal auth', () => {
    expect(authMethodsFor({ auth: { terminal: true } })[0]).toMatchObject({ type: 'terminal', args: ['--setup'] })
    expect(authMethodsFor({ _meta: { 'terminal-auth': true } })[0]).toMatchObject({ type: 'terminal' })
    expect(authMethodsFor({ auth: { terminal: false } })[0]).not.toHaveProperty('type')
    expect(authMethodsFor(undefined)[0]).toMatchObject({ id: 'deepseek-api-key' })
  })

  it('waits for a composed credentials service that is still starting', async () => {
    const ctx = lookup(false, 3)
    await expect(assertSessionCredential(ctx, { provider: 'deepseek-official' }))
      .rejects.toMatchObject({ code: -32000 })
    expect(ctx.calls()).toBe(4)

    const ready = lookup(true, 2)
    await expect(assertSessionCredential(ready, { provider: 'deepseek-official' })).resolves.toBeUndefined()
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
})
