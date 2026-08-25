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

/** ACP config id for the provider/model selector. */
export const MODEL_CONFIG_ID = 'model'
/** ACP config id for the sandbox/approval preset selector. */
export const PERMISSION_CONFIG_ID = 'permission'

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
