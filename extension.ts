/**
 * Pi extension entrypoint for pi-event-search.
 *
 * Run with:
 *   pi -e ./extension.ts
 *
 * The extension indexes persisted Pi session JSONL files into a disposable
 * SQLite FTS5 read model and registers three read-only public tools:
 * event_search, event_read, event_trace.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { SearchProvider } from './src/index/provider.ts'
import { IndexMaintainer } from './src/index/maintainer.ts'
import { defaultSessionDir } from './src/auth/discovery.ts'
import { PiEventSearchService, type ServiceInvocation } from './src/api/service.ts'
import { PiEventSearchError } from './src/errors.ts'
import { parsedSessionFromSessionManager, sourceInfoForParsedSession } from './src/pi-adapter.ts'

export default function (pi: ExtensionAPI) {
  const provider = new SearchProvider()
  const service = new PiEventSearchService({ provider })
  let maintainer: IndexMaintainer | null = null

  function invocationFrom(ctx: any): ServiceInvocation {
    const cwd = ctx.sessionManager.getCwd?.() ?? process.cwd()
    return {
      cwd,
      currentSessionId: ctx.sessionManager.getSessionId?.() ?? undefined,
      invocationEntryId: ctx.sessionManager.getLeafId?.() ?? undefined,
    }
  }

  function refresh(ctx: any): void {
    const sessionDir = ctx.sessionManager.getSessionDir?.()
    const sessionFile = ctx.sessionManager.getSessionFile?.()

    if (sessionDir !== undefined) {
      const roots = new Set<string>()
      roots.add(defaultSessionDir())
      roots.add(sessionDir)
      if (maintainer === null) {
        maintainer = new IndexMaintainer({ provider, discovery: { sessionDirs: [...roots] } })
      }
      maintainer.refresh()
    } else {
      const adapted = parsedSessionFromSessionManager(ctx.sessionManager)
      if (adapted) {
        provider.indexSession(adapted.parsed, sourceInfoForParsedSession(adapted.parsed, adapted.sourceFilePath))
      }
    }

    if (sessionFile !== undefined && maintainer !== null) {
      maintainer.syncFile(sessionFile)
    }
  }

  pi.on('session_start', async (_event, ctx) => {
    refresh(ctx)
  })

  pi.on('agent_settled', async (_event, ctx) => {
    refresh(ctx)
  })

  pi.registerTool({
    name: 'event_search',
    label: 'Event Search',
    description:
      'Read-only search over persisted Pi session events as typed semantic fragments. Returns bounded event hits with (sessionId, entryId) provenance.',
    parameters: Type.Object({
      query: Type.String({ minLength: 1, description: 'Plain terms and quoted phrases; separate terms use implicit AND.' }),
      sessionId: Type.Optional(Type.String({ description: 'Optional explicit session to search.' })),
      cwd: Type.Optional(Type.String({ description: 'Optional workspace directory filter.' })),
      kinds: Type.Optional(Type.Array(Type.String())),
      entryTypes: Type.Optional(Type.Array(Type.String())),
      roles: Type.Optional(Type.Array(Type.String())),
      toolNames: Type.Optional(Type.Array(Type.String())),
      errorOnly: Type.Optional(Type.Boolean()),
      time: Type.Optional(Type.Object({
        from: Type.Optional(Type.String()),
        to: Type.Optional(Type.String()),
      })),
      branchStates: Type.Optional(Type.Array(Type.String())),
      selectionStates: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      refresh(ctx)
      try {
        const hits = service.searchEvents(params as any, invocationFrom(ctx))
        return {
          content: [{ type: 'text', text: JSON.stringify(hits, null, 2) }],
          details: {},
        }
      } catch (err) {
        if (err instanceof PiEventSearchError) throw new Error(err.publicMessage)
        throw err
      }
    },
  })

  pi.registerTool({
    name: 'event_read',
    label: 'Event Read',
    description:
      'Read-only lookup of one authorized source event by (sessionId, entryId) with bounded text windows and exact truncation receipts.',
    parameters: Type.Object({
      sessionId: Type.String(),
      entryId: Type.String(),
      order: Type.Optional(Type.Union([Type.Literal('branch'), Type.Literal('append')])),
      before: Type.Optional(Type.Number({ minimum: 0, maximum: 20 })),
      after: Type.Optional(Type.Number({ minimum: 0, maximum: 20 })),
      offset: Type.Optional(Type.Number({ minimum: 0 })),
      windowChars: Type.Optional(Type.Number({ minimum: 1, maximum: 4000 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      refresh(ctx)
      try {
        const result = service.readEvent(params.sessionId, params.entryId, {
          order: params.order,
          before: params.before,
          after: params.after,
          offset: params.offset,
          windowChars: params.windowChars,
        }, invocationFrom(ctx))
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          details: {},
        }
      } catch (err) {
        if (err instanceof PiEventSearchError) throw new Error(err.publicMessage)
        throw err
      }
    },
  })

  pi.registerTool({
    name: 'event_trace',
    label: 'Event Trace',
    description:
      'Read-only trace of the bounded local relationship graph for one event: parent, children, derived branch siblings, and related edges.',
    parameters: Type.Object({
      sessionId: Type.String(),
      entryId: Type.String(),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      refresh(ctx)
      try {
        const trace = service.traceEvent(params.sessionId, params.entryId, invocationFrom(ctx))
        return {
          content: [{ type: 'text', text: JSON.stringify(trace, null, 2) }],
          details: {},
        }
      } catch (err) {
        if (err instanceof PiEventSearchError) throw new Error(err.publicMessage)
        throw err
      }
    },
  })
}
