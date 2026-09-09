/** Editor-profile audit primitives and repository contract. */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  compositionPackages,
  diffSnapshot,
  officialSnapshot,
  owningPackage,
} from '../scripts/profile-audit-lib.mjs'

describe('editor profile audit', () => {
  it('parses nested Cordis groups and ignores non-Harness modules', () => {
    expect(compositionPackages(`
- id: plain
  name: local-plugin
- id: nested
  name: cordis:group
  config:
    - id: selected
      name: '@deepseek-ai/dsh-tool-selected'
`)).toEqual(['@deepseek-ai/dsh-tool-selected'])
  })

  it('resolves subpath companions to the package that must be installed', () => {
    expect(owningPackage('@deepseek-ai/dsh-agent/invariant')).toBe('@deepseek-ai/dsh-agent')
    expect(owningPackage('@deepseek-ai/dsh-agent')).toBe('@deepseek-ai/dsh-agent')
    expect(owningPackage('@deepseek-ai/dsh-tool-subagent-control/list-agents'))
      .toBe('@deepseek-ai/dsh-tool-subagent-control')
    expect(owningPackage('local-plugin/sub')).toBe('local-plugin')
  })

  it('reports stable additions and removals', () => {
    expect(diffSnapshot(['a', 'b'], ['b', 'c'])).toEqual({ added: ['c'], removed: ['a'] })
  })

  it('classifies official providers, consumers, candidates, and commands', () => {
    expect(officialSnapshot(
      ['@deepseek-ai/dsh-tool-x', '@deepseek-ai/dsh-web', '@deepseek-ai/dsh-session'],
      [{ package: '@deepseek-ai/dsh-command-x', command: 'x' }],
      {
        candidatePatterns: ['^@deepseek-ai/dsh-(?:tool-|web$)'],
        providerPatterns: ['^@deepseek-ai/dsh-web$'],
        consumerPatterns: ['^@deepseek-ai/dsh-tool-'],
      },
    )).toEqual({
      candidatePackages: ['@deepseek-ai/dsh-tool-x', '@deepseek-ai/dsh-web'],
      humanCommands: ['x'],
      requiredProviders: ['@deepseek-ai/dsh-web'],
      criticalConsumers: ['@deepseek-ai/dsh-tool-x'],
    })
  })

  it('keeps the checked-in composition synchronized with its review manifest', async () => {
    const manifest = JSON.parse(await readFile(resolve('config/editor-profile.json'), 'utf8'))
    const packages = compositionPackages(await readFile(resolve('config/cordis.yml'), 'utf8'))
    expect(packages).toEqual(manifest.localCompositionPackages)
    expect(packages).toContain('@deepseek-ai/dsh-session-title-first-prompt-llm')
    expect(packages).toContain('@deepseek-ai/dsh-tool-fs-search')
    expect(packages).toContain('@deepseek-ai/dsh-tool-call-timeout-policy')
  })
})
