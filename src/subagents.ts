/**
 * Delegated child-agent projection onto the parent's ACP tool card.
 *
 * The harness owns delegation: `dsh-tool-subagent` starts a child agent on
 * `ctx.subagents`, the child runs in its own session with the parent's sandbox
 * override and a pinned `never` approval policy, and the parent receives only
 * the child's final output as its tool result. This module adds the editor's
 * view of that lifecycle without adding a second one: the exact tool execution
 * that started a child is remembered, the child's durable events fold into a
 * bounded transcript inside the parent's tool card, and the card settles with
 * the parent's own `tool/result`. Nothing here enters model context, and no
 * child event can reach a card after its call has settled.
 * @module dsh-acp-interactive/subagents
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentRunEndInfo, SubagentRunInfo } from '@deepseek-ai/dsh-subagent'
import type ToolRegistry from '@deepseek-ai/dsh-tools'
import { ToolPresenter, projectContent, type ToolCallSessionUpdate } from './presentation.js'

/** `_meta` key that carries the child identity on the parent's tool card. */
export const DELEGATION_META_KEY = 'dsh_subagent'
/** Transcript entries kept per card; older ones fold into a single elision line. */
export const MAX_TRANSCRIPT_ENTRIES = 48
const MAX_ENTRY_TEXT = 160

const RUNNING = '▸'
const DONE = '✓'
const FAILED = '✗'
const SAID = '·'

/** The exact tool execution a delegation was started from. */
export interface DelegationOrigin {
  readonly agent: Agent
  readonly callId: ToolCallId
}

/** One card and the update that reflects its latest state. */
export interface SubagentCardUpdate {
  readonly card: SubagentCard
  readonly update: ToolCallSessionUpdate
}

type CatalogData = Extract<SessionEvent, { type: 'subagent/catalog' }>['data']
type CardContent = NonNullable<ToolCallSessionUpdate['content']>[number]

interface ChildIdentity {
  readonly label: string | undefined
  readonly name?: string
}

interface TranscriptEntry {
  readonly key: string | undefined
  readonly depth: number
  marker: string
  text: string
}

interface ChildLink {
  readonly card: SubagentCard
  readonly depth: number
  readonly presenter: ToolPresenter
  readonly provider: string
  readonly originKey?: string
  label: string | undefined
}

/**
 * Whether a persisted header belongs to a delegated child rather than a
 * top-level editor session. Children inherit their parent's cwd, so without
 * this test they would be listed and restorable as ordinary sessions.
 * @param header - the session header to classify.
 * @returns true for a subagent child session.
 */
export function isDelegatedSession(header: Pick<SessionHeader, 'origin'>): boolean {
  return header.origin === 'subagent'
}

/** The parent-card state of one direct child and every descendant below it. */
export class SubagentCard {
  private readonly entries: TranscriptEntry[] = []
  private omitted = 0
  private outcome: string | undefined
  private finalOutput: readonly ContentBlock[] | undefined
  private parentResult: ToolCallSessionUpdate | undefined

  /**
   * @param root - the bridge-owned parent agent whose card this is.
   * @param callId - the parent's tool call that started the child.
   * @param childId - the direct child's session id.
   * @param provider - the `ctx.subagents` provider that established the child.
   * @param labelValue - the delegation's durable creation label, when one was recorded.
   * @param nameValue - the child's sibling-unique model-facing name, when cataloged.
   */
  constructor(
    readonly root: Agent,
    readonly callId: ToolCallId,
    readonly childId: SessionId,
    readonly provider: string,
    private labelValue: string | undefined,
    private nameValue?: string,
  ) {}

  /** Durable creation label recorded for this direct child. */
  get label(): string | undefined {
    return this.labelValue
  }

  /** Whether the direct child activation has reported its `subagent/end`. */
  get isFinished(): boolean {
    return this.outcome !== undefined
  }

  /** Whether the parent's non-error `tool/result` arrived while the child was running. */
  get hasParentResult(): boolean {
    return this.parentResult !== undefined
  }

  /** Update label/name when `subagent/catalog` arrives after `subagent/start`. */
  updateCatalog(label: string | undefined, name: string | undefined): boolean {
    const labelChanged = label !== undefined && label !== this.labelValue
    const nameChanged = name !== undefined && name !== this.nameValue
    if (!labelChanged && !nameChanged) return false
    if (labelChanged) this.labelValue = label
    if (nameChanged) this.nameValue = name
    return true
  }

  /** The first update after attribution: the label as title plus the identity meta. */
  opening(): ToolCallSessionUpdate {
    return { ...this.progress(), ...this.labelValue === undefined ? {} : { title: this.labelValue } }
  }

  /** A replacement of the card content with the current transcript. */
  progress(): ToolCallSessionUpdate {
    return {
      sessionUpdate: 'tool_call_update',
      toolCallId: this.callId,
      content: [this.transcriptBlock()],
      _meta: { [DELEGATION_META_KEY]: this.meta() },
    }
  }

  /** Record parent tool-result context and keep the card in progress until `subagent/end`. */
  recordParentResult(result: ToolCallSessionUpdate): ToolCallSessionUpdate {
    this.parentResult = result
    return {
      ...result,
      status: 'in_progress',
      content: [this.transcriptBlock()],
      _meta: { ...result._meta, [DELEGATION_META_KEY]: this.meta() },
    }
  }

  /**
   * Place the transcript ahead of the final child output or parent result projection.
   * @param result - the update produced from the parent's `tool/result`.
   * @returns the same update carrying the transcript and identity meta.
   */
  settle(result: ToolCallSessionUpdate): ToolCallSessionUpdate {
    const content = result.status === 'failed' || this.finalOutput === undefined
      ? result.content ?? []
      : projectContent(this.finalOutput)
    return {
      ...result,
      ...result.status === 'failed' || this.outcome === undefined
        ? {}
        : { status: this.outcome === 'completed' ? 'completed' : 'failed' },
      content: [this.transcriptBlock(), ...content],
      _meta: { ...result._meta, [DELEGATION_META_KEY]: this.meta() },
    }
  }

  /** Settle a previously deferred card when the direct child ends. */
  settleDeferred(): ToolCallSessionUpdate {
    const output = this.finalOutput === undefined ? [] : projectContent(this.finalOutput)
    return {
      ...this.parentResult,
      sessionUpdate: 'tool_call_update',
      toolCallId: this.callId,
      status: this.outcome === 'completed' ? 'completed' : 'failed',
      content: [this.transcriptBlock(), ...output],
      _meta: { ...this.parentResult?._meta, [DELEGATION_META_KEY]: this.meta() },
    }
  }

  /**
   * Append one transcript entry, folding the oldest into the elision count
   * once the bound is reached.
   * @param depth - delegation depth below the card's root (1 for the direct child).
   * @param marker - the leading status glyph.
   * @param text - the entry text; whitespace is collapsed and long text truncated.
   * @param key - identity for a later status change, when the entry is a tool call.
   */
  append(depth: number, marker: string, text: string, key?: string): void {
    this.entries.push({ key, depth, marker, text: compact(text) })
    while (this.entries.length > MAX_TRANSCRIPT_ENTRIES) {
      this.entries.shift()
      this.omitted += 1
    }
  }

  /**
   * Replace the text of a keyed entry that is still running.
   * @param key - the identity given to {@link append}.
   * @param text - the replacement text.
   */
  retitle(key: string, text: string): void {
    const entry = this.entries.find(candidate => candidate.key === key)
    if (entry !== undefined) entry.text = compact(text)
  }

  /**
   * Settle a keyed entry. An entry already folded away leaves nothing to change.
   * @param key - the identity given to {@link append}.
   * @param failed - whether the call ended in error.
   * @param text - replacement text, when the result view offers a better title.
   */
  complete(key: string, failed: boolean, text?: string): void {
    const entry = this.entries.find(candidate => candidate.key === key)
    if (entry === undefined) return
    entry.marker = failed ? FAILED : DONE
    if (text !== undefined) entry.text = compact(text)
  }

  /**
   * Record a child's terminal stop reason and final assistant output. The direct
   * child's reason is also carried in the identity meta.
   * @param depth - delegation depth of the settled child.
   * @param stopReason - the seam's terminal vocabulary for the run.
   * @param lastAssistantMessage - the child's final output blocks, when present.
   */
  finish(depth: number, stopReason: string, lastAssistantMessage?: readonly ContentBlock[]): void {
    if (depth === 1) {
      this.outcome = stopReason
      this.finalOutput = lastAssistantMessage
    }
    this.append(depth, stopReason === 'completed' ? DONE : FAILED, `Subagent ${stopReason}`)
  }

  /** Render the bounded transcript as one Markdown block. */
  render(): string {
    const lines = [`Subagent \`${this.provider}\` · session \`${this.childId}\``]
    if (this.omitted > 0) lines.push(`- … ${this.omitted} earlier entries omitted`)
    for (const entry of this.entries) {
      lines.push(`${'  '.repeat(entry.depth - 1)}- ${entry.marker} ${entry.text}`)
    }
    return lines.join('\n')
  }

  private transcriptBlock(): CardContent {
    return { type: 'content', content: { type: 'text', text: this.render() } }
  }

  private meta(): Record<string, unknown> {
    return {
      session_id: this.childId,
      provider: this.provider,
      ...this.labelValue === undefined ? {} : { label: this.labelValue },
      ...this.nameValue === undefined ? {} : { name: this.nameValue },
      ...this.outcome === undefined ? {} : { stop_reason: this.outcome },
    }
  }
}

/**
 * Attribute published children to the tool executions that started them and
 * fold their session events into the owning parent cards.
 *
 * Attribution rides Node's async context: every tool dispatch runs inside
 * {@link runDelegation}, and the seam publishes `subagent/start` from within
 * the same asynchronous chain as the tool body that called `ctx.subagents`,
 * so parallel delegations from one parent step resolve to their own calls
 * without inferring from timing or labels.
 */
export class SubagentTracker {
  private readonly origins = new AsyncLocalStorage<DelegationOrigin>()
  private readonly cards = new Map<string, SubagentCard>()
  private readonly links = new Map<SessionId, ChildLink>()
  private readonly identities = new Map<SessionId, ChildIdentity>()

  /**
   * @param tools - registry used to resolve child-scoped presentation callbacks.
   * @param onError - contained diagnostic sink for a faulty child presenter.
   */
  constructor(
    private readonly tools: Pick<ToolRegistry, 'get'>,
    private readonly onError: (message: string) => void,
  ) {}

  /**
   * Run one tool dispatch with its execution recorded as the delegation origin.
   * @param origin - the calling agent and call id.
   * @param dispatch - the rest of the dispatch pipeline.
   * @returns whatever the dispatch returns.
   */
  runDelegation<T>(origin: DelegationOrigin, dispatch: () => T): T {
    return this.origins.run(origin, dispatch)
  }

  /**
   * Remember or update the durable creation identity a parent recorded for a child.
   * When `subagent/catalog` arrives after `subagent/start`, update the already-linked
   * card or descendant entry and return its updated ACP payload when anything changed.
   * @param data - the parent's `subagent/catalog` payload.
   */
  catalog(data: CatalogData): SubagentCardUpdate | undefined {
    const name = 'name' in data ? data.name : undefined
    const link = this.links.get(data.childId)
    if (link !== undefined) {
      if (link.card.childId === data.childId) {
        return link.card.updateCatalog(data.label, name)
          ? { card: link.card, update: link.card.opening() }
          : undefined
      }
      if (link.originKey !== undefined && data.label !== undefined && data.label !== link.label) {
        link.label = data.label
        link.card.retitle(link.originKey, `Subagent \`${link.provider}\`: ${data.label}`)
        return { card: link.card, update: link.card.progress() }
      }
      return undefined
    }
    this.identities.set(data.childId, { label: data.label, ...name === undefined ? {} : { name } })
    return undefined
  }

  /**
   * Attribute one published child to the execution that started it.
   * @param info - the seam's start payload.
   * @param child - the live child agent, resolved by the caller during the notification.
   * @param isRoot - whether an agent is a bridge-owned session that owns cards.
   * @returns the card and its opening update, or undefined when the child is not
   *   below a bridge-owned session or was started outside a tool execution.
   */
  start(
    info: SubagentRunInfo,
    child: Agent | undefined,
    isRoot: (agent: Agent) => boolean,
  ): SubagentCardUpdate | undefined {
    const identity = this.identities.get(info.id)
    this.identities.delete(info.id)
    const origin = this.origins.getStore()
    if (origin === undefined || child === undefined) return undefined
    if (child.session.header.parentSession !== origin.agent.session.id) return undefined
    const label = identity?.label ?? descriptorLabel(child.session)
    const presenter = new ToolPresenter(this.tools, this.onError, child)
    const parent = this.links.get(origin.agent.session.id)
    if (parent !== undefined) {
      const depth = parent.depth + 1
      const originKey = entryKey(origin.agent.session.id, origin.callId)
      this.links.set(child.session.id, {
        card: parent.card, depth, presenter, provider: info.provider, originKey, label,
      })
      // The descendant's own tool call is already a running entry; name it.
      parent.card.retitle(
        originKey,
        `Subagent \`${info.provider}\`${label === undefined ? '' : `: ${label}`}`,
      )
      return { card: parent.card, update: parent.card.progress() }
    }
    if (!isRoot(origin.agent)) return undefined
    const card = new SubagentCard(origin.agent, origin.callId, child.session.id, info.provider, label, identity?.name)
    const key = cardKey(origin.agent.session.id, origin.callId)
    const previous = this.cards.get(key)
    if (previous !== undefined) this.unlink(previous)
    this.cards.set(key, card)
    this.links.set(child.session.id, { card, depth: 1, presenter, provider: info.provider, label })
    return { card, update: card.opening() }
  }

  /**
   * Record a child's settlement on its card. Settled descendants unlink immediately;
   * settled direct children finalize and unlink once the parent tool result has arrived.
   * @param info - the seam's end payload.
   * @returns the card and its update, or undefined for an untracked child.
   */
  end(info: SubagentRunEndInfo): SubagentCardUpdate | undefined {
    const link = this.links.get(info.id)
    if (link === undefined) return undefined
    link.card.finish(link.depth, info.stopReason, info.lastAssistantMessage)
    if (link.depth > 1) {
      this.links.delete(info.id)
      return { card: link.card, update: link.card.progress() }
    }
    if (link.card.hasParentResult) {
      this.cards.delete(cardKey(link.card.root.session.id, link.card.callId))
      this.unlink(link.card)
      return { card: link.card, update: link.card.settleDeferred() }
    }
    return { card: link.card, update: link.card.progress() }
  }

  /**
   * Fold one event of a tracked child or descendant session into its card.
   * @param session - the emitting session.
   * @param event - the durable event.
   * @returns the card and its update when the event changed the transcript.
   */
  childEvent(session: Session, event: SessionEvent): SubagentCardUpdate | undefined {
    const link = this.links.get(session.id)
    if (link === undefined) return undefined
    const card = link.card
    switch (event.type) {
      case 'subagent/catalog':
        return this.catalog(event.data)
      case 'tool/call': {
        const view = link.presenter.call(event.data.callId, event.data.name, event.data.arguments)
        card.append(link.depth, RUNNING, view.title, entryKey(session.id, event.data.callId))
        return { card, update: card.progress() }
      }
      case 'tool/result': {
        if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') return undefined
        const message = event.data.message
        const isError = message.isError === true
        const view = link.presenter.result(message.toolCallId, message.content as ContentBlock[], isError, event.data.meta)
        card.complete(entryKey(session.id, message.toolCallId), isError, view.title)
        return { card, update: card.progress() }
      }
      case 'assistant/message': {
        const text = event.data.message.content
          .flatMap(block => block.type === 'text' ? [block.text] : [])
          .join('')
          .trim()
        if (text.length === 0) return undefined
        card.append(link.depth, SAID, text)
        return { card, update: card.progress() }
      }
      default:
        return undefined
    }
  }

  /**
   * Handle the parent's `tool/result` projection for a delegated call. Fails and
   * already-finished children settle and unlink immediately; active children remain
   * linked in progress until their direct `subagent/end`.
   * @param root - the bridge-owned parent agent.
   * @param callId - the parent's completed tool call.
   * @param result - the ACP update produced from the parent's `tool/result`.
   * @param isError - whether the parent tool call returned an error.
   * @returns the card update to emit, or undefined when the call started no child.
   */
  parentResult(
    root: Agent,
    callId: ToolCallId,
    result: ToolCallSessionUpdate,
    isError: boolean,
  ): ToolCallSessionUpdate | undefined {
    const key = cardKey(root.session.id, callId)
    const card = this.cards.get(key)
    if (card === undefined) return undefined
    if (isError || card.isFinished) {
      this.cards.delete(key)
      this.unlink(card)
      return card.settle(result)
    }
    return card.recordParentResult(result)
  }

  /**
   * Settle the card of a parent tool call and stop routing child events to it.
   * @param root - the bridge-owned parent agent.
   * @param callId - the parent's settled tool call.
   * @returns the card, or undefined when the call started no child.
   */
  settle(root: Agent, callId: ToolCallId): SubagentCard | undefined {
    const key = cardKey(root.session.id, callId)
    const card = this.cards.get(key)
    if (card === undefined) return undefined
    this.cards.delete(key)
    this.unlink(card)
    return card
  }

  /** List every currently linked child or descendant session id belonging to a root agent. */
  activeChildIds(root: Agent): SessionId[] {
    const ids: SessionId[] = []
    for (const [id, link] of this.links) {
      if (link.card.root === root) ids.push(id)
    }
    return ids
  }

  /**
   * Forget pending identities and cards owned by a disposed root agent. Child
   * links remain intact across child agent disposal so the trailing `subagent/end`
   * lifecycle event can still finalize its card.
   * @param agent - the agent that left the registry.
   */
  dispose(agent: Agent): void {
    this.identities.delete(agent.session.id)
    for (const [key, card] of this.cards) {
      if (card.root !== agent) continue
      this.cards.delete(key)
      this.unlink(card)
    }
  }

  private unlink(card: SubagentCard): void {
    for (const [id, link] of this.links) {
      if (link.card === card) this.links.delete(id)
    }
  }
}

function cardKey(rootId: SessionId, callId: ToolCallId): string {
  return `${rootId}:${callId}`
}

function entryKey(sessionId: SessionId, callId: ToolCallId): string {
  return `${sessionId}:${callId}`
}

function descriptorLabel(session: Session): string | undefined {
  if (typeof session.snapshotEvents !== 'function') return undefined
  for (const event of session.snapshotEvents()) {
    if (event.type === 'subagent/descriptor') return event.data.label
  }
  return undefined
}

function compact(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length <= MAX_ENTRY_TEXT ? collapsed : `${collapsed.slice(0, MAX_ENTRY_TEXT - 1)}…`
}
