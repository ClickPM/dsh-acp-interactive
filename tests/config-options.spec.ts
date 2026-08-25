import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LlmModelInfo, LlmProviderInfo } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  decodeModelValue,
  encodeModelValue,
  hasModelValue,
  MODEL_CONFIG_ID,
  permissionDirectory,
  PERMISSION_CONFIG_ID,
  sessionConfigOptions,
} from '../src/config-options.js'

function fixture(options: {
  providers?: LlmProviderInfo[]
  models?: Record<string, LlmModelInfo[] | Error>
  permission?: {
    names: readonly string[]
    current: string
    description?: string
  }
} = {}): { ctx: Context; agent: Agent; warnings: string[] } {
  const warnings: string[] = []
  const permission = options.permission === undefined ? undefined : {
    names: options.permission.names,
    current: () => options.permission!.current,
    optionOf: (value: string) => ({
      value,
      name: value.toUpperCase(),
      ...options.permission!.description === undefined ? {} : { description: options.permission!.description },
    }),
  }
  const ctx = {
    llm: {
      listProviders: () => options.providers ?? [],
      listModels: (provider: string) => {
        const value = options.models?.[provider] ?? []
        return value instanceof Error ? Promise.reject(value) : Promise.resolve(value)
      },
    },
    logger: { warn: (message: string) => { warnings.push(message) } },
    get: (name: string) => name === 'permissionPresets' ? permission : undefined,
  } as unknown as Context
  const session = Session.create(SessionId('config-options'))
  return { ctx, agent: { session } as Agent, warnings }
}

describe('interactive ACP configuration projection', () => {
  it('round-trips encoded routes and rejects malformed encodings', () => {
    const encoded = encodeModelValue('provider:one', 'model/two')
    expect(decodeModelValue(encoded)).toEqual({ provider: 'provider:one', model: 'model/two' })
    expect(() => decodeModelValue('missing-separator')).toThrow(/provider and model/)
    expect(() => decodeModelValue('%:model')).toThrow(/invalid encoding/)
  })

  it('groups advertised models, descriptions, and permission presets', async () => {
    const { ctx, agent } = fixture({
      providers: [{ id: 'p', name: 'Provider' }],
      models: { p: [{ provider: 'p', id: 'm', name: 'Model', description: 'Fast' }] },
      permission: { names: ['safe'], current: 'safe', description: 'Confined' },
    })
    const options = await sessionConfigOptions(ctx, agent, { provider: 'p', model: 'm' })
    expect(options).toEqual([
      expect.objectContaining({ id: MODEL_CONFIG_ID, currentValue: 'p:m' }),
      expect.objectContaining({ id: PERMISSION_CONFIG_ID, currentValue: 'safe' }),
    ])
    expect(options[0]).toMatchObject({
      options: [{ options: [{ value: 'p:m', name: 'Model', description: 'Fast' }] }],
    })
    expect(options[1]).toMatchObject({
      options: [{ value: 'safe', name: 'SAFE', description: 'Confined' }],
    })
    expect(hasModelValue(options, 'p:m')).toBe(true)
  })

  it('keeps unadvertised selections current in an existing or synthetic provider group', async () => {
    const models = { p: [{ provider: 'p', id: 'listed', name: 'Listed' }] }
    const existing = fixture({ providers: [{ id: 'p', name: 'Provider' }], models })
    const existingOptions = await sessionConfigOptions(
      existing.ctx,
      existing.agent,
      { provider: 'p', model: 'unlisted' },
    )
    expect(existingOptions[0]).toMatchObject({
      currentValue: 'p:unlisted',
      options: [{ options: [{ value: 'p:listed' }, { value: 'p:unlisted' }] }],
    })

    const missing = fixture({ providers: [{ id: 'p', name: 'Provider' }], models })
    const missingOptions = await sessionConfigOptions(
      missing.ctx,
      missing.agent,
      { provider: 'gone', model: 'remembered' },
    )
    expect(missingOptions[0]).toMatchObject({
      currentValue: 'gone:remembered',
      options: [{ group: 'p' }, { group: 'gone', options: [{ value: 'gone:remembered' }] }],
    })
  })

  it('contains catalog failures and omits empty or unavailable selectors', async () => {
    const { ctx, agent, warnings } = fixture({
      providers: [{ id: 'empty', name: 'Empty' }, { id: 'bad', name: 'Bad' }],
      models: { bad: new Error('catalog failed') },
      permission: { names: [], current: 'none' },
    })
    await expect(sessionConfigOptions(ctx, agent, undefined)).resolves.toEqual([])
    expect(warnings).toEqual([expect.stringContaining('catalog failed')])
    expect(permissionDirectory(ctx)).toBeDefined()
    expect(hasModelValue([{ type: 'boolean', id: 'flag', name: 'Flag', currentValue: false }], 'x')).toBe(false)

    const absent = fixture()
    expect(permissionDirectory(absent.ctx)).toBeUndefined()
  })
})
