import { Authorizer } from '../auth/authorizer.ts'
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
    return this.provider.searchEvents(request, context, this.searchLimit)
  }

  readEvent(
    sessionId: string,
    entryId: string,
    options: ReadEventOptions,
    invocation: ServiceInvocation,
  ): ReadEventResult {
    const root = this.resolveRoot(invocation)
    const boundedOptions: ReadEventOptions = {
      ...options,
      before: Math.min(options.before ?? 1, this.maxReadBefore),
      after: Math.min(options.after ?? 1, this.maxReadAfter),
      windowChars: Math.min(options.windowChars ?? 2000, this.maxWindowChars),
    }
    return this.provider.readEvent(sessionId, entryId, boundedOptions, root)
  }

  traceEvent(sessionId: string, entryId: string, invocation: ServiceInvocation): EventTrace {
    const root = this.resolveRoot(invocation)
    return this.provider.traceEvent(sessionId, entryId, root)
  }

  traceSession(sessionId: string, invocation: ServiceInvocation): SessionLineage {
    const root = this.resolveRoot(invocation)
    return this.provider.traceSession(sessionId, root)
  }

  private resolveRoot(invocation: ServiceInvocation): string {
    const authorizer = new Authorizer({
      cwd: invocation.cwd,
      explicitWorkspaceRoot: invocation.explicitWorkspaceRoot,
    })
    return authorizer.root
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
