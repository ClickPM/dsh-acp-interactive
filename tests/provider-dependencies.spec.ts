/** Published provider dependencies read routes from the configured dsh home. */

import { Context } from '@deepseek-ai/cordis'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadUserPatches } from '../src/setup.js'

let home: string | undefined
let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (home !== undefined) await rm(home, { recursive: true, force: true })
  home = undefined
})

describe('user model provider dependencies', () => {
  it('registers a custom provider from settings.yaml under the selected dsh home', async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-acp-model-home-'))
    await writeFile(join(home, 'settings.yaml'), [
      'llm-pi-ai:',
      '  providers:',
      '    local-probe:',
      '      displayName: Local Probe',
      '      api: openai-completions',
      '      baseURL: http://127.0.0.1:1/v1',
      '      models:',
      '        - id: probe-model',
      '          name: Probe Model',
      '          input: [text, image]',
      '',
    ].join('\n'))

    const patches = loadUserPatches('test', home)
    const piAiConfig = patches?.find(patch => patch.id === 'llm-pi-ai')?.config ?? {}
    ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LocalCredentialProvider, { dshHome: home, watch: false })
    await ctx.plugin(LlmPiAi, piAiConfig)

    expect(ctx.llm.listProviders()).toEqual([{ id: 'local-probe', name: 'Local Probe' }])
    await expect(ctx.llm.listModels('local-probe')).resolves.toMatchObject([
      { provider: 'local-probe', id: 'probe-model', name: 'Probe Model', inputModalities: ['text', 'image'] },
    ])
  })

  it('registers a custom provider from cordis.patch.yml under the selected dsh home', async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-acp-model-home-'))
    await writeFile(join(home, 'cordis.patch.yml'), [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      local-probe:',
      '        displayName: Local Probe',
      '        api: openai-completions',
      '        baseURL: http://127.0.0.1:1/v1',
      '        models:',
      '          - id: probe-model',
      '            name: Probe Model',
      '            input: [text, image]',
      '',
    ].join('\n'))

    const patches = loadUserPatches('test', home)
    const piAiConfig = patches?.find(patch => patch.id === 'llm-pi-ai')?.config ?? {}
    ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LocalCredentialProvider, { dshHome: home, watch: false })
    await ctx.plugin(LlmPiAi, piAiConfig)

    expect(ctx.llm.listProviders()).toEqual([{ id: 'local-probe', name: 'Local Probe' }])
    await expect(ctx.llm.listModels('local-probe')).resolves.toMatchObject([
      { provider: 'local-probe', id: 'probe-model', name: 'Probe Model', inputModalities: ['text', 'image'] },
    ])
  })
})
