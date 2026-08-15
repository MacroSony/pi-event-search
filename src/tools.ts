import type { EventSearchRequest, ReadEventOptions } from './types.ts'
import { PiEventSearchError } from './errors.ts'
import type { PiEventSearchService, ServiceInvocation } from './api/service.ts'

export interface ToolSuccess<T> {
  ok: true
  result: T
}

export interface ToolFailure {
  ok: false
  code: string
  message: string
}

export type ToolResponse<T> = ToolSuccess<T> | ToolFailure

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export const eventSearchToolDefinition: ToolDefinition = {
  name: 'event_search',
  description:
    'Read-only search over persisted Pi session events. Use 1-3 short concrete terms; terms are ANDed, so too many terms or filters usually return no hits. Start broad, then narrow.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Short concrete terms or quoted phrases. Terms are ANDed. Good: "edit", "write_file". Bad: "修改 edit write 文件 CJK 中文 分词".',
      },
      sessionId: { type: 'string', description: 'Optional explicit session to search. Use "current" to target the invoking session (still honors the invocation cutoff).' },
      cwd: { type: 'string', description: 'Optional workspace directory filter.' },
      kinds: { type: 'array', items: { type: 'string' } },
      entryTypes: { type: 'array', items: { type: 'string' } },
      roles: { type: 'array', items: { type: 'string' } },
      toolNames: { type: 'array', items: { type: 'string' } },
      errorOnly: { type: 'boolean' },
      time: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } },
      branchStates: { type: 'array', items: { type: 'string' } },
      selectionStates: { type: 'array', items: { type: 'string' } },
    },
    required: ['query'],
  },
}

export const eventReadToolDefinition: ToolDefinition = {
  name: 'event_read',
  description:
    'Read-only lookup of one authorized source event by (sessionId, entryId) with bounded text windows and exact truncation receipts.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'Session id, or "current" for the invoking session.' },
      entryId: { type: 'string' },
      order: { type: 'string', enum: ['branch', 'append'] },
      before: { type: 'number', description: 'Neighbor count before the target.' },
      after: { type: 'number', description: 'Neighbor count after the target.' },
      offset: { type: 'number', description: 'Unicode code-point offset for a fixed-size contiguous window.' },
      windowChars: { type: 'number', description: 'Fixed window size in Unicode code points.' },
    },
    required: ['sessionId', 'entryId'],
  },
}

export const eventTraceToolDefinition: ToolDefinition = {
  name: 'event_trace',
  description:
    'Read-only trace of the bounded local relationship graph for one event: parent, children, derived branch siblings, and related edges.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'Session id, or "current" for the invoking session.' },
      entryId: { type: 'string' },
    },
    required: ['sessionId', 'entryId'],
  },
}

function failure(err: unknown): ToolFailure {
  if (err instanceof PiEventSearchError) {
    return { ok: false, code: err.code, message: err.publicMessage }
  }
  const message = err instanceof Error ? err.message : String(err)
  return { ok: false, code: 'INTERNAL', message: 'Internal error.' }
}

export function handleEventSearch(
  service: PiEventSearchService,
  args: EventSearchRequest,
  invocation: ServiceInvocation,
): ToolResponse<ReturnType<PiEventSearchService['searchEvents']>> {
  try {
    return { ok: true, result: service.searchEvents(args, invocation) }
  } catch (err) {
    return failure(err)
  }
}

export function handleEventRead(
  service: PiEventSearchService,
  args: { sessionId: string; entryId: string } & ReadEventOptions,
  invocation: ServiceInvocation,
): ToolResponse<ReturnType<PiEventSearchService['readEvent']>> {
  try {
    const { sessionId, entryId, ...options } = args
    return { ok: true, result: service.readEvent(sessionId, entryId, options, invocation) }
  } catch (err) {
    return failure(err)
  }
}

export function handleEventTrace(
  service: PiEventSearchService,
  args: { sessionId: string; entryId: string },
  invocation: ServiceInvocation,
): ToolResponse<ReturnType<PiEventSearchService['traceEvent']>> {
  try {
    return { ok: true, result: service.traceEvent(args.sessionId, args.entryId, invocation) }
  } catch (err) {
    return failure(err)
  }
}
