/** ACP form elicitation provider for the dsh user-questions service. */

import {
  CreateElicitationResponse,
  type CreateElicitationRequest,
  type ElicitationPropertySchema,
  type SendRequestOptions,
} from '@agentclientprotocol/sdk'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import type {
  AskUserQuestionAnswer,
  AskUserQuestionItem,
  AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'

interface QuestionField {
  question: AskUserQuestionItem
  valueKey: string
  customKey?: string
}

function presentation(request: AskUserQuestionRequest): string {
  return request.questions.map((question) => {
    const heading = question.header === undefined ? question.question : `${question.header}: ${question.question}`
    const detail = question.detail === undefined ? '' : `\n\n${question.detail}`
    const options = (question.options ?? []).map(option => option.description === undefined
      ? `- ${option.label}`
      : `- ${option.label}: ${option.description}`).join('\n')
    return `${heading}${detail}${options.length === 0 ? '' : `\n\n${options}`}`
  }).join('\n\n---\n\n')
}

function propertyFor(question: AskUserQuestionItem): ElicitationPropertySchema {
  const options = question.options ?? []
  const common = {
    title: question.header ?? question.question,
    ...question.detail === undefined ? {} : { description: question.detail },
  }
  if (options.length === 0) return { type: 'string', ...common, minLength: 1 }
  const choices = options.map(option => ({ const: option.label, title: option.label }))
  return question.multiSelect === true
    ? { type: 'array', ...common, items: { anyOf: choices }, minItems: 1 }
    : { type: 'string', ...common, oneOf: choices }
}

function formRequest(request: AskUserQuestionRequest, sessionId: string): {
  fields: QuestionField[]
  wire: CreateElicitationRequest
} {
  const properties: Record<string, ElicitationPropertySchema> = {}
  const required: string[] = []
  const fields = request.questions.map((question, index): QuestionField => {
    const valueKey = `q${index}`
    const hasOptions = (question.options?.length ?? 0) > 0
    properties[valueKey] = propertyFor(question)
    if (!hasOptions) required.push(valueKey)
    if (!hasOptions) return { question, valueKey }
    const customKey = `${valueKey}_custom`
    properties[customKey] = {
      type: 'string',
      title: `${question.header ?? question.question} — Other`,
      description: 'Optional free-text answer when the listed choices are insufficient.',
    }
    return { question, valueKey, customKey }
  })
  return {
    fields,
    wire: {
      mode: 'form',
      sessionId,
      message: presentation(request),
      requestedSchema: { type: 'object', properties, required },
    },
  }
}

function acceptedAnswer(
  fields: readonly QuestionField[],
  response: Extract<CreateElicitationResponse, { action: 'accept' }>,
): AskUserQuestionAnswer {
  const content = response.content ?? {}
  return {
    answers: fields.map(({ question, valueKey, customKey }) => {
      const value = content[valueKey]
      const customValue = customKey === undefined ? undefined : content[customKey]
      const allowed = new Set((question.options ?? []).map(option => option.label))
      const selected = Array.isArray(value)
        ? value
        : allowed.size > 0 && typeof value === 'string'
          ? [value]
          : []
      if (selected.some(item => typeof item !== 'string' || !allowed.has(item))) {
        throw new UserQuestionError(`elicitation returned an unknown option for question ${question.id}`, 'INVALID_ANSWER')
      }
      const freeText = allowed.size === 0 ? value : customValue
      if (freeText !== undefined && typeof freeText !== 'string') {
        throw new UserQuestionError(`elicitation returned invalid text for question ${question.id}`, 'INVALID_ANSWER')
      }
      if (selected.length === 0 && (typeof freeText !== 'string' || freeText.length === 0)) {
        throw new UserQuestionError(`elicitation did not answer question ${question.id}`, 'INVALID_ANSWER')
      }
      return {
        id: question.id,
        selected,
        ...typeof freeText === 'string' && freeText.length > 0 ? { custom: freeText } : {},
      }
    }),
  }
}

async function awaitElicitation(
  request: AskUserQuestionRequest,
  operation: Promise<CreateElicitationResponse>,
): Promise<CreateElicitationResponse> {
  const signal = request.signal
  if (signal === undefined) return operation
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const aborted = (): void => {
      reject(new UserQuestionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED'))
    }
    signal.addEventListener('abort', aborted, { once: true })
    void operation.then((value) => {
      signal.removeEventListener('abort', aborted)
      resolve(value)
    }, (error: unknown) => {
      signal.removeEventListener('abort', aborted)
      reject(error instanceof Error ? error : new Error(String(error)))
    })
  })
}

/**
 * Build the answerer that routes only bridge-owned root agents to ACP form
 * elicitation.
 *
 * The user-questions service dispatches a scope-filtered waterfall rather than
 * a provider registry, so a request this connection does not own is delegated
 * with `next()` instead of rejected here: the service already refuses a
 * non-live or delegated caller before dispatch, and its terminal step reports
 * `NO_PROVIDER` when no composed answerer claims the request. Declining to
 * claim is therefore how this transport keeps agents owned by another
 * connection, and clients that never advertised form elicitation, out of the
 * ACP elicitation path.
 * @param owns - returns the session id only for an exact bridge-owned agent.
 * @param enabled - whether the initialized client advertised form elicitation.
 * @param create - ACP client request method.
 * @returns listener suitable for `ctx.on('user-questions/request', ...)`.
 */
export function acpQuestionAnswerer(
  owns: (request: AskUserQuestionRequest) => string | undefined,
  enabled: () => boolean,
  create: (
    request: CreateElicitationRequest,
    options?: SendRequestOptions,
  ) => Promise<CreateElicitationResponse>,
): (
  request: AskUserQuestionRequest,
  next: () => Promise<AskUserQuestionAnswer>,
) => Promise<AskUserQuestionAnswer> {
  return async (request, next) => {
    const sessionId = owns(request)
    if (sessionId === undefined || !enabled()) return next()
    const { fields, wire } = formRequest(request, sessionId)
    const response = await awaitElicitation(request, create(
      wire,
      request.signal === undefined ? undefined : { cancellationSignal: request.signal },
    ))
    if (!CreateElicitationResponse.isAccept(response)) {
      if (!CreateElicitationResponse.isDecline(response) && !CreateElicitationResponse.isCancel(response)) {
        throw new UserQuestionError('elicitation returned an unsupported action', 'INVALID_ANSWER')
      }
      throw new UserQuestionError('the user dismissed the question without answering', 'ASK_CANCELLED')
    }
    return acceptedAnswer(fields, response)
  }
}
