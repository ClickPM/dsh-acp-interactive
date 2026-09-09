/** Tool-owned render-intent projection onto ACP tool cards. */

import { isAbsolute, relative, resolve, sep } from 'node:path'
import type {
  ContentBlock as AcpContentBlock,
  SessionNotification,
} from '@agentclientprotocol/sdk'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { assertNever, type JsonValue } from '@deepseek-ai/dsh-util-values'
import type ToolRegistry from '@deepseek-ai/dsh-tools'
import type {
  TerminalResultView,
  ToolCallView,
  ToolResultView,
} from '@deepseek-ai/dsh-tools'

/** Per-session terminal capability and workspace used by the projection. */
export interface TerminalRendering {
  /** Whether the editor advertised the Zed terminal-card extension. */
  enabled: boolean
  /** Absolute session workspace when one was recorded. */
  cwd: string | undefined
}

/** An ACP update for a pending or completed tool call. */
export type ToolCallSessionUpdate =
  | Extract<SessionNotification['update'], { sessionUpdate: 'tool_call' }>
  | Extract<SessionNotification['update'], { sessionUpdate: 'tool_call_update' }>

type AcpToolCallContent =
  | { type: 'content'; content: AcpContentBlock }
  | { type: 'diff'; path: string; oldText: string | null; newText: string }
  | { type: 'terminal'; terminalId: string }

interface PendingCall {
  name: string
  args: unknown
  card: ToolCallView['card']
}

/**
 * Resolve tool-owned presentation methods and retain call arguments for the matching result.
 */
export class ToolPresenter {
  private readonly pending = new Map<string, PendingCall>()

  /**
   * @param tools - registry that owns presentation callbacks.
   * @param onError - contained diagnostic sink for a faulty presenter.
   * @param agent - exact agent used to resolve scoped tools.
   */
  constructor(
    private readonly tools: Pick<ToolRegistry, 'get'>,
    private readonly onError: (message: string) => void,
    private readonly agent: Agent,
  ) {}

  /**
   * Resolve and remember a pending call view.
   * @param callId - durable call identity.
   * @param name - registered tool name.
   * @param argumentsJson - raw model-produced arguments.
   * @returns the tool-owned view or a generic fallback.
   */
  call(callId: string, name: string, argumentsJson: string): ToolCallView {
    const args = parseArguments(argumentsJson)
    let view: ToolCallView | undefined
    try {
      view = this.tools.get(name, this.agent)?.presentCall?.(args)
    } catch (error: unknown) {
      this.onError(`acp-interactive: tool "${name}" presentCall failed: ${String(error)}`)
    }
    const resolved = view ?? { card: 'generic', title: name, kind: 'other', rawInput: args }
    this.pending.set(callId, { name, args, card: resolved.card })
    return resolved
  }

  /**
   * Resolve and consume the completed result view.
   * @param callId - durable call identity.
   * @param content - model-facing result blocks.
   * @param isError - whether tool execution failed.
   * @param meta - persisted tool-private presentation metadata.
   * @returns the tool-owned result view or a generic raw-content fallback.
   */
  result(callId: string, content: ContentBlock[], isError: boolean, meta?: JsonValue): ToolResultView {
    const call = this.pending.get(callId)
    this.pending.delete(callId)
    if (call === undefined) return { card: 'generic', content }
    let view: ToolResultView | undefined
    try {
      view = this.tools.get(call.name, this.agent)?.presentResult?.(
        call.args,
        { content, isError, ...meta === undefined ? {} : { meta } },
      )
    } catch (error: unknown) {
      this.onError(`acp-interactive: tool "${call.name}" presentResult failed: ${String(error)}`)
    }
    if (view === undefined) return { card: 'generic', content }
    if (view.card === 'terminal' && call.card !== 'terminal') return { card: 'generic', content }
    if (view.card === 'generic' && view.content === undefined) return { ...view, content }
    if (view.card === 'read' && view.content === undefined) return { ...view, content }
    if (view.card === 'search' || view.card === 'web') {
      return { card: 'generic', ...view.title === undefined ? {} : { title: view.title }, content }
    }
    return view
  }
}

/**
 * Build an ACP pending tool-card update from a tool-owned call view.
 * @param callId - durable call identity.
 * @param view - tool-owned pending view.
 * @param terminal - session terminal capability and cwd.
 * @returns one `tool_call` session update.
 */
export function projectToolCall(
  callId: string,
  view: ToolCallView,
  terminal: TerminalRendering,
): ToolCallSessionUpdate {
  switch (view.card) {
    case 'generic':
      return {
        sessionUpdate: 'tool_call',
        toolCallId: callId,
        title: displayTitle(view.title, view.locations?.[0]?.path, terminal.cwd),
        kind: view.kind ?? 'other',
        status: 'in_progress',
        ...view.rawInput === undefined ? {} : { rawInput: view.rawInput },
        ...view.locations === undefined ? {} : { locations: view.locations },
        ...view.content === undefined ? {} : { content: projectContent(view.content) },
      }
    case 'diff': {
      const path = view.locations?.[0]?.path ?? view.diffs[0]?.path
      return {
        sessionUpdate: 'tool_call',
        toolCallId: callId,
        title: displayTitle(view.title, path, terminal.cwd),
        kind: 'edit',
        status: 'in_progress',
        ...view.locations === undefined ? {} : { locations: view.locations },
        ...view.diffs.length === 0 ? {} : { content: projectDiffs(view.diffs) },
      }
    }
    case 'terminal': {
      const description: AcpToolCallContent[] = view.description === undefined
        ? []
        : [{ type: 'content', content: { type: 'text', text: view.description } }]
      const content: AcpToolCallContent[] = terminal.enabled
        ? [...description, { type: 'terminal', terminalId: callId }]
        : description
      return {
        sessionUpdate: 'tool_call',
        toolCallId: callId,
        title: view.title,
        kind: 'execute',
        status: 'in_progress',
        rawInput: view.title,
        ...content.length === 0 ? {} : { content },
        ...terminal.enabled
          ? { _meta: { terminal_info: { terminal_id: callId, cwd: terminalCwd(view.cwd, terminal.cwd) } } }
          : {},
      }
    }
    default:
      return assertNever(view, 'ToolCallView.card')
  }
}

/**
 * Build an ACP completed tool-card update from a tool-owned result view.
 * @param callId - durable call identity.
 * @param view - tool-owned completed view.
 * @param isError - whether execution failed.
 * @param terminal - session terminal capability and cwd.
 * @returns one `tool_call_update` session update.
 */
export function projectToolResult(
  callId: string,
  view: ToolResultView,
  isError: boolean,
  terminal: TerminalRendering,
): ToolCallSessionUpdate {
  const status = isError ? 'failed' as const : 'completed' as const
  switch (view.card) {
    case 'terminal':
      return projectTerminalResult(callId, view, status, terminal.enabled)
    case 'diff': {
      const title = view.title === undefined
        ? undefined
        : displayTitle(view.title, view.diffs[0]?.path, terminal.cwd)
      return {
        sessionUpdate: 'tool_call_update',
        toolCallId: callId,
        status,
        ...title === undefined ? {} : { title },
        ...view.diffs.length === 0 ? {} : { content: projectDiffs(view.diffs) },
      }
    }
    case 'generic':
      return genericResult(callId, status, view.title, view.content)
    case 'read':
      return {
        ...genericResult(callId, status, view.title, view.content),
        locations: [{ path: view.path, line: view.offset }],
      }
    case 'search':
    case 'web':
      return genericResult(callId, status, view.title, undefined)
    default:
      return assertNever(view, 'ToolResultView.card')
  }
}

function genericResult(
  callId: string,
  status: 'completed' | 'failed',
  title: string | undefined,
  content: ContentBlock[] | undefined,
): ToolCallSessionUpdate {
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId: callId,
    status,
    ...title === undefined ? {} : { title },
    ...content === undefined ? {} : { content: projectContent(content) },
  }
}

function projectTerminalResult(
  callId: string,
  view: TerminalResultView,
  status: 'completed' | 'failed',
  enabled: boolean,
): ToolCallSessionUpdate {
  const output = view.output ?? ''
  if (!enabled) {
    return {
      sessionUpdate: 'tool_call_update',
      toolCallId: callId,
      status,
      content: [{
        type: 'content',
        content: { type: 'text', text: `\`\`\`console\n${output.replace(/\n+$/, '')}\n\`\`\`` },
      }],
      ...view.title === undefined ? {} : { title: view.title },
    }
  }
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId: callId,
    status,
    ...view.title === undefined ? {} : { title: view.title },
    _meta: {
      terminal_output: { terminal_id: callId, data: output },
      ...terminalExit(callId, view),
    },
  }
}

function terminalExit(callId: string, view: TerminalResultView): Record<string, unknown> {
  if (view.signal !== undefined) return { terminal_exit: { terminal_id: callId, signal: view.signal } }
  if (view.exitCode !== undefined) return { terminal_exit: { terminal_id: callId, exit_code: view.exitCode } }
  return {}
}

function projectDiffs(diffs: readonly { path: string; oldText: string | null; newText: string }[]): AcpToolCallContent[] {
  return diffs.map(diff => ({ type: 'diff', ...diff }))
}

function projectContent(blocks: readonly ContentBlock[]): AcpToolCallContent[] {
  return blocks.flatMap((block): AcpToolCallContent[] => block.type === 'text'
    ? [{ type: 'content', content: { type: 'text', text: block.text } }]
    : [])
}

function parseArguments(value: string): unknown {
  try {
    return value.length === 0 ? {} : JSON.parse(value)
  } catch {
    return value
  }
}

function displayTitle(title: string, rawPath: string | undefined, cwd: string | undefined): string {
  if (rawPath === undefined || cwd === undefined || !isAbsolute(rawPath) || !isAbsolute(cwd)) return title
  const displayPath = relative(cwd, rawPath)
  if (displayPath.length === 0 || displayPath === '..' || displayPath.startsWith(`..${sep}`)) return title
  return title.split(rawPath).join(displayPath)
}

function terminalCwd(viewCwd: string | undefined, sessionCwd: string | undefined): string | undefined {
  if (viewCwd === undefined) return sessionCwd
  if (isAbsolute(viewCwd)) return viewCwd
  return sessionCwd === undefined ? viewCwd : resolve(sessionCwd, viewCwd)
}
