import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolCallView, ToolDefinition, ToolResultView } from '@deepseek-ai/dsh-tools'
import { projectToolCall, projectToolResult, ToolPresenter } from '../src/presentation.js'

const agent = {} as Agent
const text = (value: string): ContentBlock[] => [{ type: 'text', text: value }]

function registry(definition: Partial<ToolDefinition>) {
  return {
    get: () => definition as ToolDefinition,
  }
}

describe('interactive ACP tool presentation', () => {
  it('uses tool-owned diff intent and retains the real path for follow-along', () => {
    const presenter = new ToolPresenter(registry({
      presentCall: () => ({
        card: 'diff',
        title: 'Edit C:\\work\\src\\a.ts',
        diffs: [{ path: 'C:\\work\\src\\a.ts', oldText: 'old', newText: 'new' }],
        locations: [{ path: 'C:\\work\\src\\a.ts' }],
      }),
    }), () => {}, agent)
    const view = presenter.call('c1', 'edit', '{}')
    expect(projectToolCall('c1', view, { enabled: false, cwd: 'C:\\work' })).toMatchObject({
      sessionUpdate: 'tool_call',
      toolCallId: 'c1',
      kind: 'edit',
      locations: [{ path: 'C:\\work\\src\\a.ts' }],
      content: [{ type: 'diff', path: 'C:\\work\\src\\a.ts', oldText: 'old', newText: 'new' }],
    })
  })

  it('maps terminal output to the Zed extension or a console fallback', () => {
    const result = { card: 'terminal' as const, output: 'ok\n', exitCode: 0 }
    expect(projectToolResult('t1', result, false, { enabled: true, cwd: '/work' })).toMatchObject({
      sessionUpdate: 'tool_call_update',
      status: 'completed',
      _meta: {
        terminal_output: { terminal_id: 't1', data: 'ok\n' },
        terminal_exit: { terminal_id: 't1', exit_code: 0 },
      },
    })
    expect(projectToolResult('t1', result, false, { enabled: false, cwd: '/work' })).toMatchObject({
      content: [{ type: 'content', content: { type: 'text', text: '```console\nok\n```' } }],
    })
  })

  it('contains a faulty tool presenter and falls back to raw arguments', () => {
    const diagnostics: string[] = []
    const presenter = new ToolPresenter(registry({
      presentCall: () => { throw new Error('bad card') },
    }), (message) => { diagnostics.push(message) }, agent)
    expect(presenter.call('c1', 'custom', '{"x":1}')).toEqual({
      card: 'generic',
      title: 'custom',
      kind: 'other',
      rawInput: { x: 1 },
    })
    expect(diagnostics[0]).toContain('bad card')
  })

  it('parses call arguments and falls back when no call presenter exists', () => {
    const presenter = new ToolPresenter(registry({}), () => {}, agent)
    expect(presenter.call('empty', 'plain', '')).toMatchObject({ rawInput: {} })
    expect(presenter.call('json', 'plain', '{"x":1}')).toMatchObject({ rawInput: { x: 1 } })
    expect(presenter.call('raw', 'plain', '{')).toMatchObject({ rawInput: '{' })
  })

  it('contains result presenter failures and preserves raw fallback content', () => {
    const diagnostics: string[] = []
    const throwing = new ToolPresenter(registry({
      presentResult: () => { throw new Error('bad result card') },
    }), message => diagnostics.push(message), agent)
    throwing.call('throw', 'custom', '{}')
    expect(throwing.result('throw', text('raw'), true, { source: 'tool' })).toEqual({
      card: 'generic',
      content: text('raw'),
    })
    expect(diagnostics[0]).toContain('bad result card')

    const absent = new ToolPresenter(registry({}), () => {}, agent)
    expect(absent.result('missing', text('orphan'), false)).toEqual({ card: 'generic', content: text('orphan') })
    absent.call('known', 'custom', '{}')
    expect(absent.result('known', text('known raw'), false)).toEqual({ card: 'generic', content: text('known raw') })
  })

  it('normalizes unsupported and incomplete result intents', () => {
    let nextResult: ToolResultView = { card: 'generic' }
    const presenter = new ToolPresenter(registry({
      presentCall: () => ({ card: 'generic', title: 'call' }),
      presentResult: (_args, result) => {
        expect(result.meta).toEqual({ persisted: true })
        return nextResult
      },
    }), () => {}, agent)
    const resolve = (id: string): ToolResultView => {
      presenter.call(id, 'custom', '{}')
      return presenter.result(id, text('raw'), false, { persisted: true })
    }

    expect(resolve('generic')).toEqual({ card: 'generic', content: text('raw') })
    nextResult = { card: 'read', path: 'a.ts', offset: 4, lines: [], totalLines: 0 }
    expect(resolve('read')).toMatchObject({ card: 'read', content: text('raw') })
    nextResult = { card: 'search', shape: 'paths', title: 'Search', paths: [], truncated: false, total: 0 }
    expect(resolve('search')).toEqual({ card: 'generic', title: 'Search', content: text('raw') })
    nextResult = { card: 'web', kind: 'fetch', url: 'https://example.test', statusCode: 200, truncated: false }
    expect(resolve('web')).toEqual({ card: 'generic', content: text('raw') })
    nextResult = { card: 'diff', title: 'Applied', diffs: [] }
    expect(resolve('diff')).toEqual(nextResult)
  })

  it('rejects a result-only terminal intent and accepts a matching terminal pair', () => {
    let callView: ToolCallView = { card: 'generic', title: 'call' }
    const presenter = new ToolPresenter(registry({
      presentCall: () => callView,
      presentResult: () => ({ card: 'terminal', output: 'ok' }),
    }), () => {}, agent)
    presenter.call('generic', 'custom', '{}')
    expect(presenter.result('generic', text('raw'), false)).toEqual({ card: 'generic', content: text('raw') })
    callView = { card: 'terminal', title: 'echo ok' }
    presenter.call('terminal', 'custom', '{}')
    expect(presenter.result('terminal', text('raw'), false)).toEqual({ card: 'terminal', output: 'ok' })
  })

  it('projects complete and minimal generic calls', () => {
    expect(projectToolCall('g1', {
      card: 'generic',
      title: 'Read C:\\work\\src\\a.ts',
      kind: 'read',
      rawInput: { path: 'a.ts' },
      content: [...text('pending'), { type: 'reasoning', text: 'hidden' }],
      locations: [{ path: 'C:\\work\\src\\a.ts', line: 2 }],
    }, { enabled: false, cwd: 'C:\\work' })).toEqual({
      sessionUpdate: 'tool_call',
      toolCallId: 'g1',
      title: 'Read src\\a.ts',
      kind: 'read',
      status: 'in_progress',
      rawInput: { path: 'a.ts' },
      content: [{ type: 'content', content: { type: 'text', text: 'pending' } }],
      locations: [{ path: 'C:\\work\\src\\a.ts', line: 2 }],
    })
    expect(projectToolCall('g2', { card: 'generic', title: 'Plain' }, { enabled: false, cwd: undefined }))
      .toEqual({
        sessionUpdate: 'tool_call', toolCallId: 'g2', title: 'Plain', kind: 'other', status: 'in_progress',
      })
  })

  it('projects minimal diff calls and keeps titles for paths outside the workspace', () => {
    expect(projectToolCall('d1', {
      card: 'diff', title: 'Edit C:\\other\\a.ts', diffs: [],
    }, { enabled: false, cwd: 'C:\\work' })).toEqual({
      sessionUpdate: 'tool_call',
      toolCallId: 'd1',
      title: 'Edit C:\\other\\a.ts',
      kind: 'edit',
      status: 'in_progress',
    })
    expect(projectToolCall('d2', {
      card: 'diff', title: 'Edit a.ts', diffs: [{ path: 'a.ts', oldText: null, newText: 'new' }], locations: [],
    }, { enabled: false, cwd: 'C:\\work' })).toMatchObject({
      content: [{ type: 'diff', path: 'a.ts', oldText: null, newText: 'new' }],
      locations: [],
    })
  })

  it('projects terminal call capability, descriptions, and cwd resolution', () => {
    expect(projectToolCall('t1', {
      card: 'terminal', title: 'pnpm test', description: 'Run tests', cwd: 'packages/acp',
    }, { enabled: true, cwd: 'C:\\work' })).toMatchObject({
      content: [
        { type: 'content', content: { type: 'text', text: 'Run tests' } },
        { type: 'terminal', terminalId: 't1' },
      ],
      _meta: { terminal_info: { terminal_id: 't1', cwd: 'C:\\work\\packages\\acp' } },
    })
    expect(projectToolCall('t2', {
      card: 'terminal', title: 'pwd', cwd: 'C:\\absolute',
    }, { enabled: true, cwd: 'C:\\work' })).toMatchObject({
      content: [{ type: 'terminal', terminalId: 't2' }],
      _meta: { terminal_info: { cwd: 'C:\\absolute' } },
    })
    expect(projectToolCall('t3', {
      card: 'terminal', title: 'pwd', cwd: 'relative',
    }, { enabled: true, cwd: undefined })).toMatchObject({
      _meta: { terminal_info: { cwd: 'relative' } },
    })
    expect(projectToolCall('t4', {
      card: 'terminal', title: 'pwd',
    }, { enabled: false, cwd: 'C:\\work' })).not.toHaveProperty('content')
    expect(projectToolCall('t5', {
      card: 'terminal', title: 'pwd',
    }, { enabled: true, cwd: 'C:\\work' })).toMatchObject({
      _meta: { terminal_info: { cwd: 'C:\\work' } },
    })
  })

  it('projects every completed result card and optional field', () => {
    const terminal = { enabled: false, cwd: 'C:\\work' }
    expect(projectToolResult('g', { card: 'generic', title: 'Done', content: text('ok') }, true, terminal))
      .toMatchObject({ status: 'failed', title: 'Done', content: [{ type: 'content' }] })
    expect(projectToolResult('g2', { card: 'generic' }, false, terminal)).toEqual({
      sessionUpdate: 'tool_call_update', toolCallId: 'g2', status: 'completed',
    })
    expect(projectToolResult('r', {
      card: 'read', path: 'src/a.ts', offset: 3, lines: [], totalLines: 10, content: text('line'),
    }, false, terminal)).toMatchObject({ locations: [{ path: 'src/a.ts', line: 3 }], content: [{ type: 'content' }] })
    expect(projectToolResult('s', {
      card: 'search', shape: 'paths', title: 'Found', paths: [], truncated: false, total: 0,
    }, false, terminal)).toMatchObject({ title: 'Found' })
    expect(projectToolResult('w', {
      card: 'web', kind: 'fetch', url: 'https://example.test', statusCode: 200, truncated: false,
    }, false, terminal)).not.toHaveProperty('title')
  })

  it('projects completed diffs with optional title and content', () => {
    expect(projectToolResult('d1', {
      card: 'diff', title: 'Edit C:\\work\\a.ts', diffs: [{ path: 'C:\\work\\a.ts', oldText: 'a', newText: 'b' }],
    }, false, { enabled: false, cwd: 'C:\\work' })).toMatchObject({
      title: 'Edit a.ts', content: [{ type: 'diff', path: 'C:\\work\\a.ts' }],
    })
    expect(projectToolResult('d2', { card: 'diff', diffs: [] }, false, { enabled: false, cwd: undefined }))
      .toEqual({ sessionUpdate: 'tool_call_update', toolCallId: 'd2', status: 'completed' })
  })

  it('projects terminal fallbacks, signals, exits, and missing output', () => {
    expect(projectToolResult('signal', {
      card: 'terminal', title: 'Killed', output: 'partial\n', signal: 'SIGTERM',
    }, true, { enabled: true, cwd: undefined })).toMatchObject({
      status: 'failed', title: 'Killed', _meta: { terminal_exit: { signal: 'SIGTERM' } },
    })
    expect(projectToolResult('unknown', { card: 'terminal' }, false, { enabled: true, cwd: undefined }))
      .toEqual({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'unknown',
        status: 'completed',
        _meta: { terminal_output: { terminal_id: 'unknown', data: '' } },
      })
    expect(projectToolResult('plain', { card: 'terminal' }, false, { enabled: false, cwd: undefined }))
      .toMatchObject({ content: [{ type: 'content', content: { type: 'text', text: '```console\n\n```' } }] })
    expect(projectToolResult('plain-title', {
      card: 'terminal', title: 'Done',
    }, false, { enabled: false, cwd: undefined })).toMatchObject({ title: 'Done' })
  })

  it('keeps titles when a path is the workspace or its parent', () => {
    const same: ToolCallView = { card: 'generic', title: 'Read C:\\work', locations: [{ path: 'C:\\work' }] }
    expect(projectToolCall('same', same, { enabled: false, cwd: 'C:\\work' })).toMatchObject({ title: 'Read C:\\work' })
    const parent: ToolCallView = { card: 'generic', title: 'Read C:\\', locations: [{ path: 'C:\\' }] }
    expect(projectToolCall('parent', parent, { enabled: false, cwd: 'C:\\work' })).toMatchObject({ title: 'Read C:\\' })
  })

  it('guards closed presentation unions', () => {
    expect(() => projectToolCall('x', { card: 'future' } as never, { enabled: false, cwd: undefined }))
      .toThrow(/ToolCallView.card/)
    expect(() => projectToolResult('x', { card: 'future' } as never, false, { enabled: false, cwd: undefined }))
      .toThrow(/ToolResultView.card/)
  })
})
