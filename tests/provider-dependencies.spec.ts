/** Published provider dependencies read routes from the configured dsh home. */

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import * as AgentInstructions from '@deepseek-ai/dsh-agent-instructions'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import PermissionPresetService from '@deepseek-ai/dsh-permission-presets'
import PlanModeController from '@deepseek-ai/dsh-plan-mode'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import * as ToolExecutorNative from '@deepseek-ai/dsh-tool-executor-native'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as ToolFsSearch from '@deepseek-ai/dsh-tool-fs-search'
import * as ToolGoal from '@deepseek-ai/dsh-tool-goal'
import * as ToolPwsh from '@deepseek-ai/dsh-tool-pwsh'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import * as WebSearchDeepseek from '@deepseek-ai/dsh-web-search-deepseek'
import WorkingDirectoryService from '@deepseek-ai/dsh-working-directory'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { compositionPackages } from '../scripts/profile-audit-lib.mjs'
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

  it('aligns composed runtime plugins with published 0.2.2-rc.5 inject contracts', async () => {
    expect(AgentRegistry.inject).toEqual(['sessionProjections'])
    expect(ApprovalService.inject).toEqual(['sessionProjections'])
    expect(PlanModeController.inject).toEqual(['tools', 'systemPrompt', 'sessionProjections', 'agents'])
    expect(PermissionPresetService.inject).toEqual(['shell', 'approval', 'sessions', 'agents', 'sessionProjections'])
    expect(SessionTitleService.inject).toEqual(['sessions', 'sessionProjections', 'agents'])
    expect(AgentInstructions.inject).toEqual(['agents', 'workingDirectory'])
    expect(SubagentRuntime.inject).toEqual(['workingDirectory', 'sessionProjections'])
    expect(ToolBash.inject).toEqual(['tools', 'shell', 'systemPrompt', 'shellEnv', 'workingDirectory'])
    expect(ToolPwsh.inject).toEqual(['tools', 'shell', 'systemPrompt', 'shellEnv', 'workingDirectory'])
    expect(ToolFs.inject).toEqual(['tools', 'fs', 'systemPrompt', 'workingDirectory'])
    expect(ToolFsSearch.inject).toEqual(['tools', 'systemPrompt', 'subprocess', 'workingDirectory'])
    expect(ToolSkill.inject).toEqual(['agents', 'tools', 'skills', 'workingDirectory'])
    expect(ToolGoal.inject).toEqual(['agents', 'goals', 'tools', 'systemPrompt'])
    expect(ToolExecutorNative.inject).toEqual(['tools'])
    expect(WorkingDirectoryService.inject).toEqual(['fs', 'sessionProjections', 'systemPrompt'])
    expect(WebSearchDeepseek.inject).toEqual(['web'])

    const packages = compositionPackages(await readFile(resolve('config/cordis.yml'), 'utf8'))
    expect(packages).toEqual(expect.arrayContaining([
      '@deepseek-ai/dsh-agent',
      '@deepseek-ai/dsh-session-projection',
      '@deepseek-ai/dsh-tool-executor-native',
      '@deepseek-ai/dsh-web',
      '@deepseek-ai/dsh-web-search-deepseek',
      '@deepseek-ai/dsh-working-directory',
    ]))
    expect(packages).not.toContain('@deepseek-ai/dsh-web-deepseek-api')
  })
})
