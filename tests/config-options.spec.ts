import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId, type LlmProviderInfo, type LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  decodeModelValue,
  decodeReasoningValue,
  encodeModelValue,
  encodeReasoningValue,
  hasModelValue,
  hasReasoningValue,
  MODEL_CONFIG_ID,
  permissionDirectory,
  PERMISSION_CONFIG_ID,
  REASONING_CONFIG_ID,
  sessionConfigOptions,
} from '../src/config-options.js'

function fixture(options: {
  providers?: LlmProviderInfo[]
  models?: Record<string, LlmResolvedModelInfo[] | Error>
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
      resolveModelInfo: (provider: string, model: string) => {
        const value = options.models?.[provider] ?? []
        if (value instanceof Error) return Promise.reject(value)
        const info = value.find(candidate => candidate.id === model)
        return info === undefined
          ? Promise.reject(new Error('model absent'))
          : Promise.resolve(info)
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
    expect(hasModelValue([{
      type: 'select', id: MODEL_CONFIG_ID, name: 'Model', currentValue: 'p:m',
      options: [{ value: 'p:m', name: 'Model' }],
    }], 'p:m')).toBe(true)
  })

  it('projects and round-trips reasoning efforts for the selected exact route', async () => {
    const high = ReasoningEffortId('high')
    const low = ReasoningEffortId('low')
    const { ctx, agent } = fixture({
      providers: [{ id: 'p', name: 'Provider' }],
      models: { p: [{
        provider: 'p', id: 'm', name: 'Model',
        reasoning: {
          efforts: [
            { id: high, name: 'High', description: 'Think longer' },
            { id: low, name: 'Low' },
          ],
        },
      }] },
    })
    const options = await sessionConfigOptions(ctx, agent, { provider: 'p', model: 'm', reasoningEffort: high })
    expect(options).toContainEqual(expect.objectContaining({
      id: REASONING_CONFIG_ID,
      category: 'thought_level',
      currentValue: 'effort:high',
    }))
    expect(hasReasoningValue(options, encodeReasoningValue(high))).toBe(true)
    const defaults = await sessionConfigOptions(ctx, agent, { provider: 'p', model: 'm' })
    expect(defaults).toContainEqual(expect.objectContaining({
      id: REASONING_CONFIG_ID,
      currentValue: 'default',
    }))
    expect(decodeReasoningValue('default')).toBeUndefined()
    expect(decodeReasoningValue(encodeReasoningValue(high))).toBe(high)
    expect(() => decodeReasoningValue('high')).toThrow(/advertised effort/)
    expect(() => decodeReasoningValue('effort:%')).toThrow(/invalid encoding/)
  })

  it('keeps a restored effort current when reasoning metadata is absent or unavailable', async () => {
    const remembered = ReasoningEffortId('remembered')
    const absent = fixture({
      providers: [{ id: 'p', name: 'Provider' }],
      models: { p: [{ provider: 'p', id: 'm', name: 'Model' }] },
    })
    const absentOptions = await sessionConfigOptions(
      absent.ctx,
      absent.agent,
      { provider: 'p', model: 'm', reasoningEffort: remembered },
    )
    expect(absentOptions).toContainEqual(expect.objectContaining({
      id: REASONING_CONFIG_ID,
      currentValue: 'effort:remembered',
      options: [
        expect.objectContaining({ value: 'default' }),
        expect.objectContaining({ value: 'effort:remembered' }),
      ],
    }))
    const absentReasoning = absentOptions.find(option => option.id === REASONING_CONFIG_ID)
    if (absentReasoning?.type !== 'select') throw new Error('missing reasoning selector')
    const rememberedOption = absentReasoning.options.find(option => 'value' in option && option.value === 'effort:remembered')
    if (rememberedOption === undefined || !('value' in rememberedOption)) throw new Error('missing remembered effort')
    expect(rememberedOption.description).toContain('Current effort')

    const unavailable = fixture({
      providers: [{ id: 'p', name: 'Provider' }],
      models: { p: new Error('catalog failed') },
    })
    const unavailableOptions = await sessionConfigOptions(
      unavailable.ctx,
      unavailable.agent,
      { provider: 'p', model: 'm', reasoningEffort: remembered },
    )
    expect(unavailableOptions).toContainEqual(expect.objectContaining({
      id: REASONING_CONFIG_ID,
      currentValue: 'effort:remembered',
    }))
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

  it('keeps a derived custom permission value as the current-only option', async () => {
    const { ctx, agent } = fixture({
      permission: { names: ['safe'], current: 'custom' },
    })
    const options = await sessionConfigOptions(ctx, agent, undefined)
    expect(options).toEqual([expect.objectContaining({
      id: PERMISSION_CONFIG_ID,
      currentValue: 'custom',
      options: [expect.objectContaining({ value: 'safe' }), expect.objectContaining({ value: 'custom' })],
    })])
  })
})
