import { Authorizer } from '../auth/authorizer.ts'
import { PiEventSearchError } from '../errors.ts'
import type {
  EventSearchHit,
  EventSearchRequest,
  EventTrace,
  ExecutionContext,
  ReadEventOptions,
  ReadEventResult,
  SessionLineage,
} from '../types.ts'
import type { SearchProvider } from '../index/provider.ts'

export interface ServiceInvocation {
  /** Caller working directory for workspace-root resolution. */
  cwd: string
  explicitWorkspaceRoot?: string
  currentSessionId?: string
  invocationEntryId?: string
  invocationTimestamp?: string
}

export interface ServiceOptions {
  provider: SearchProvider
  searchLimit?: number
  maxReadBefore?: number
  maxReadAfter?: number
  maxWindowChars?: number
}

const DEFAULT_MAX_READ_BEFORE = 5
const DEFAULT_MAX_READ_AFTER = 5
const DEFAULT_MAX_WINDOW_CHARS = 4000

/**
 * Special `sessionId` value that resolves to the caller's current session.
 * Targeting the current session still honors the invocation cutoff: entries
 * at or after the invoking tool call are never returned.
 */
export const CURRENT_SESSION_ID = 'current'

export class PiEventSearchService {
  readonly provider: SearchProvider
  readonly searchLimit: number
  readonly maxReadBefore: number
  readonly maxReadAfter: number
  readonly maxWindowChars: number

  constructor(options: ServiceOptions) {
    this.provider = options.provider
    this.searchLimit = options.searchLimit ?? 20
    this.maxReadBefore = options.maxReadBefore ?? DEFAULT_MAX_READ_BEFORE
    this.maxReadAfter = options.maxReadAfter ?? DEFAULT_MAX_READ_AFTER
    this.maxWindowChars = options.maxWindowChars ?? DEFAULT_MAX_WINDOW_CHARS
  }

  searchEvents(request: EventSearchRequest, invocation: ServiceInvocation): EventSearchHit[] {
    const context = this.toSearchContext(invocation)
    const resolvedRequest =
      request.sessionId !== undefined
        ? { ...request, sessionId: this.resolveSessionId(request.sessionId, invocation) }
        : request
    return this.provider.searchEvents(resolvedRequest, context, this.searchLimit)
  }

  readEvent(
    sessionId: string,
    entryId: string,
    options: ReadEventOptions,
    invocation: ServiceInvocation,
  ): ReadEventResult {
    const context = this.toSearchContext(invocation)
    const resolvedSessionId = this.resolveSessionId(sessionId, invocation)
    if (options.fragmentId !== undefined && options.fragmentId.length === 0) {
      throw new PiEventSearchError('INVALID_ARGUMENT', 'fragmentId must be a non-empty string.')
    }
    const boundedOptions: ReadEventOptions = {
      ...options,
      before: boundedInteger('before', options.before, 1, 0, this.maxReadBefore),
      after: boundedInteger('after', options.after, 1, 0, this.maxReadAfter),
      offset: options.offset === undefined
        ? undefined
        : boundedInteger('offset', options.offset, 0, 0, Number.MAX_SAFE_INTEGER),
      windowChars: boundedInteger('windowChars', options.windowChars, 2000, 1, this.maxWindowChars),
    }
    return this.provider.readEvent(resolvedSessionId, entryId, boundedOptions, context.authRoot, context.execution)
  }

  traceEvent(sessionId: string, entryId: string, invocation: ServiceInvocation): EventTrace {
    const context = this.toSearchContext(invocation)
    return this.provider.traceEvent(
      this.resolveSessionId(sessionId, invocation),
      entryId,
      context.authRoot,
      context.execution,
    )
  }

  traceSession(sessionId: string, invocation: ServiceInvocation): SessionLineage {
    const root = this.resolveRoot(invocation)
    return this.provider.traceSession(this.resolveSessionId(sessionId, invocation), root)
  }

  private resolveRoot(invocation: ServiceInvocation): string {
    const authorizer = new Authorizer({
      cwd: invocation.cwd,
      explicitWorkspaceRoot: invocation.explicitWorkspaceRoot,
    })
    return authorizer.root
  }

  /** Map the public "current" alias to the invoking session id. */
  private resolveSessionId(sessionId: string, invocation: ServiceInvocation): string {
    if (sessionId !== CURRENT_SESSION_ID) return sessionId
    if (invocation.currentSessionId === undefined) {
      throw new PiEventSearchError(
        'INVALID_ARGUMENT',
        'The "current" session is not available in this invocation context.',
      )
    }
    return invocation.currentSessionId
  }

  private toSearchContext(invocation: ServiceInvocation): { authRoot: string; execution?: ExecutionContext } {
    const execution: ExecutionContext | undefined =
      invocation.currentSessionId !== undefined || invocation.invocationEntryId !== undefined || invocation.invocationTimestamp !== undefined
        ? {
            currentSessionId: invocation.currentSessionId,
            invocationEntryId: invocation.invocationEntryId,
            invocationTimestamp: invocation.invocationTimestamp,
          }
        : undefined
    return { authRoot: this.resolveRoot(invocation), execution }
  }
}

function boundedInteger(
  name: string,
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < minimum) {
    throw new PiEventSearchError(
      'INVALID_ARGUMENT',
      `${name} must be an integer greater than or equal to ${minimum}.`,
    )
  }
  return Math.min(resolved, maximum)
}
