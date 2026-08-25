/**
 * ACP session configuration projection for model routes and permission presets.
 *
 * Model values encode the complete provider/model pair because model ids are
 * provider-local. Permission values remain the preset table keys owned by the
 * optional permission-presets service.
 * @module dsh-acp-interactive/config-options
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

/** ACP config id for the provider/model selector. */
export const MODEL_CONFIG_ID = 'model'
/** ACP config id for the exact route's reasoning-effort selector. */
export const REASONING_CONFIG_ID = 'reasoning_effort'
/** ACP config id for the sandbox/approval preset selector. */
export const PERMISSION_CONFIG_ID = 'permission'
/** Selector value that restores adapter/provider default reasoning behavior. */
export const DEFAULT_REASONING_VALUE = 'default'

/**
 * Encode an adapter-owned effort id without colliding with the default row.
 * @param value - adapter-owned reasoning effort id.
 * @returns reversible ACP selector value.
 */
export function encodeReasoningValue(value: string): string {
  return `effort:${encodeURIComponent(value)}`
}

/**
 * Decode one advertised reasoning selector value.
 * @param value - ACP selector value.
 * @returns adapter-owned effort id, or undefined for the route default.
 */
export function decodeReasoningValue(value: string): ReturnType<typeof ReasoningEffortId> | undefined {
  if (value === DEFAULT_REASONING_VALUE) return undefined
  if (!value.startsWith('effort:') || value.length === 'effort:'.length) {
    throw new Error('reasoning value must identify an advertised effort or the route default')
  }
  try {
    return ReasoningEffortId(decodeURIComponent(value.slice('effort:'.length)))
  } catch (error: unknown) {
    throw new Error('reasoning value contains invalid encoding', { cause: error })
  }
}

/** Build the exact route's reasoning selector, retaining a restored effort the current catalog omits. */
function reasoningConfigOption(
  selection: ModelSelection,
  advertised: readonly { id: ReturnType<typeof ReasoningEffortId>; name: string; description?: string }[],
): Extract<SessionConfigOption, { type: 'select' }> {
  const reasoningOptions = [
    {
      value: DEFAULT_REASONING_VALUE,
      name: 'Default',
      description: 'Use the adapter or provider default for this model.',
    },
    ...advertised.map(effort => ({
      value: encodeReasoningValue(effort.id),
      name: effort.name,
      ...effort.description === undefined ? {} : { description: effort.description },
    })),
  ]
  const currentValue = selection.reasoningEffort === undefined
    ? DEFAULT_REASONING_VALUE
    : encodeReasoningValue(selection.reasoningEffort)
  if (!reasoningOptions.some(option => option.value === currentValue)) {
    reasoningOptions.push({
      value: currentValue,
      name: selection.reasoningEffort as string,
      description: 'Current effort; the model no longer advertises this value.',
    })
  }
  return {
    type: 'select',
    id: REASONING_CONFIG_ID,
    name: 'Reasoning effort',
    description: 'Reasoning effort used by the next step that enters prompt assembly.',
    category: 'thought_level',
    currentValue,
    options: reasoningOptions,
  }
}

/** Read face of the optional permission-presets service used by this transport. */
export interface PermissionPresetDirectory {
  /** Switchable preset names in display order. */
  readonly names: readonly string[]
  /** Resolve the effective preset from one session log. */
  current(events: Agent['session']['events']): string
  /** Resolve presentation metadata for one preset. */
  optionOf(name: string): { value: string; name: string; description?: string }
}

/**
 * Return the optional permission directory without making it a required injection.
 * @param ctx - composition that may provide permission presets.
 * @returns the directory, or undefined when the capability is absent.
 */
export function permissionDirectory(ctx: Context): PermissionPresetDirectory | undefined {
  return ctx.get('permissionPresets') as PermissionPresetDirectory | undefined
}

/**
 * Encode one exact route as an opaque ACP configuration value.
 * @param provider - registered provider route.
 * @param model - provider-local model id.
 * @returns a reversible value safe for ACP selection ids.
 */
export function encodeModelValue(provider: string, model: string): string {
  return `${encodeURIComponent(provider)}:${encodeURIComponent(model)}`
}

/**
 * Decode one ACP model value into its exact route.
 * @param value - opaque value previously returned by {@link encodeModelValue}.
 * @returns the provider/model pair.
 * @throws when the value does not contain two non-empty encoded components.
 */
export function decodeModelValue(value: string): { provider: string; model: string } {
  const separator = value.indexOf(':')
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error('model value must identify a provider and model')
  }
  try {
    const provider = decodeURIComponent(value.slice(0, separator))
    const model = decodeURIComponent(value.slice(separator + 1))
    return { provider, model }
  } catch (error: unknown) {
    throw new Error('model value contains invalid encoding', { cause: error })
  }
}

/**
 * Build the complete ACP configuration list for one live session. Catalog
 * failures remove only their provider group; the selected route remains a
 * routing fact even when an advisory catalog no longer advertises it.
 * @param ctx - context carrying the LLM registry and optional permission presets.
 * @param agent - exact session whose permission state is projected.
 * @param selection - model route selected for the next assembled step.
 * @returns every currently available session configuration option.
 */
export async function sessionConfigOptions(
  ctx: Context,
  agent: Agent,
  selection: ModelSelection | undefined,
): Promise<SessionConfigOption[]> {
  const groups = (await Promise.all(ctx.llm.listProviders().map(async (provider) => {
    try {
      const models = await ctx.llm.listModels(provider.id)
      return models.length === 0 ? undefined : {
        group: provider.id,
        name: provider.name,
        options: models.map(model => ({
          value: encodeModelValue(provider.id, model.id),
          name: model.name,
          ...model.description === undefined ? {} : { description: model.description },
        })),
      }
    } catch (error: unknown) {
      ctx.logger.warn(`acp-interactive: model catalog unavailable for provider ${provider.id}: ${String(error)}`)
      return undefined
    }
  }))).filter(group => group !== undefined)

  const options: SessionConfigOption[] = []
  if (selection !== undefined) {
    const currentValue = encodeModelValue(selection.provider, selection.model)
    const currentAdvertised = groups.some(group => group.options.some(option => option.value === currentValue))
    if (!currentAdvertised) {
      const currentOption = {
        value: currentValue,
        name: selection.model,
        description: 'Current route; the provider catalog does not advertise this model.',
      }
      const providerGroup = groups.find(group => group.group === selection.provider)
      if (providerGroup === undefined) {
        groups.push({ group: selection.provider, name: selection.provider, options: [currentOption] })
      } else {
        providerGroup.options.push(currentOption)
      }
    }
    options.push({
      type: 'select',
      id: MODEL_CONFIG_ID,
      name: 'Model',
      description: 'Provider and model used by the next step that enters prompt assembly.',
      category: 'model',
      currentValue,
      options: groups,
    })

    try {
      const model = await ctx.llm.resolveModelInfo(selection.provider, selection.model)
      if (model.reasoning !== undefined) {
        options.push(reasoningConfigOption(selection, model.reasoning.efforts))
      } else if (selection.reasoningEffort !== undefined) {
        options.push(reasoningConfigOption(selection, []))
      }
    } catch (error: unknown) {
      ctx.logger.warn(`acp-interactive: reasoning catalog unavailable for ${selection.provider}/${selection.model}: ${String(error)}`)
      if (selection.reasoningEffort !== undefined) options.push(reasoningConfigOption(selection, []))
    }
  }

  const permissions = permissionDirectory(ctx)
  if (permissions !== undefined && permissions.names.length > 0) {
    const currentValue = permissions.current(agent.session.events)
    const presetNames = [
      ...permissions.names,
      ...permissions.names.includes(currentValue) ? [] : [currentValue],
    ]
    options.push({
      type: 'select',
      id: PERMISSION_CONFIG_ID,
      name: 'Permission',
      description: 'Sandbox mode and approval policy for later tool calls.',
      category: '_permission',
      currentValue,
      options: presetNames.map((name) => {
        const option = permissions.optionOf(name)
        return {
          value: option.value,
          name: option.name,
          ...option.description === undefined ? {} : { description: option.description },
        }
      }),
    })
  }
  return options
}

/**
 * Whether a value belongs to the current reasoning selector.
 * @param options - complete ACP configuration list.
 * @param value - untrusted selector value received from the client.
 * @returns true only when the reasoning selector advertises the value.
 */
export function hasReasoningValue(options: readonly SessionConfigOption[], value: string): boolean {
  const reasoning = options.find(option => option.id === REASONING_CONFIG_ID)
  return reasoning?.type === 'select'
    && reasoning.options.some(option => !('group' in option) && option.value === value)
}

/**
 * Test whether a value is selectable in the projected model option.
 * @param options - one complete ACP configuration list.
 * @param value - untrusted model value received from the client.
 * @returns true only when the value was advertised in the model selector.
 */
export function hasModelValue(options: readonly SessionConfigOption[], value: string): boolean {
  for (const option of options) {
    if (option.id !== MODEL_CONFIG_ID || option.type !== 'select') continue
    return option.options.some(entry => 'group' in entry
      ? entry.options.some(candidate => candidate.value === value)
      : entry.value === value)
  }
  return false
}
