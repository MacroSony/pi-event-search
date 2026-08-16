import { DatabaseSync } from 'node:sqlite'
import { PiEventSearchError, notFoundError } from '../errors.ts'
import { Projector } from '../projector.ts'
import type {
  BranchForkReceipt,
  EntryIdentity,
  EventSearchHit,
  EventSearchRequest,
  EventTrace,
  ExecutionContext,
  Fragment,
  ParsedSession,
  RawEntry,
  ReadEventOptions,
  ReadEventResult,
  SessionHeader,
  SessionLineage,
  SessionSourceInfo,
  TraceEdge,
  TraceNode,
} from '../types.ts'
import {
  appendNeighbors,
  branchAncestors,
  branchDescendants,
  branchForkForEdge,
  buildSessionTree,
  type BranchFork,
} from '../tree.ts'
import { extractRelationships, extractSessionParentEdge, type RelationshipRecord } from '../relationships.ts'
import { buildSnippet, makeTextPreview } from '../snippets.ts'
import { parseQuery } from '../query.ts'
import { segmentForIndex } from '../cjk.ts'
import { isPathWithin, normalizePath } from '../auth/paths.ts'

const SELF_RETRIEVAL_TOOL_NAMES = ['event_search', 'event_read', 'event_trace'] as const

interface CrossSessionForkGroup {
  at: EntryIdentity
  participantSessionIds: Set<string>
  candidates: EntryIdentity[]
}

export interface ProviderOptions {
  searchLimit?: number
  readPreviewChars?: number
  /** Aggregate character budget across all fragments returned by readEvent. */
  readAggregateChars?: number
  /** Maximum fragments returned by an unfiltered readEvent call. */
  readMaxFragments?: number
  traceMaxRelated?: number
  traceMaxChildren?: number
  projector?: Projector
}

export interface SearchContext {
  authRoot: string
  execution?: ExecutionContext
}

export interface SessionRecord {
  header: SessionHeader
  sourceInfo: SessionSourceInfo
  tree: ReturnType<typeof buildSessionTree>
  relationships: RelationshipRecord[]
  sessionParentEdge: RelationshipRecord | null
  sessionName?: string
}

export class SearchProvider {
  readonly projector: Projector
  private readonly readProjector: Projector
  private readonly searchLimit: number
  private readonly readPreviewChars: number
  private readonly readAggregateChars: number
  private readonly readMaxFragments: number
  private readonly traceMaxRelated: number
  private readonly traceMaxChildren: number
  private db: DatabaseSync
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly fragmentsByRowid = new Map<number, Fragment>()

  constructor(options: ProviderOptions = {}) {
    this.projector = options.projector ?? new Projector()
    this.readProjector = new Projector({ maxIndexedTextChars: Number.MAX_SAFE_INTEGER })
    this.searchLimit = options.searchLimit ?? 20
    this.readPreviewChars = options.readPreviewChars ?? 2000
    this.readAggregateChars = options.readAggregateChars ?? 6000
    this.readMaxFragments = options.readMaxFragments ?? 20
    this.traceMaxRelated = options.traceMaxRelated ?? 20
    this.traceMaxChildren = options.traceMaxChildren ?? 50
    this.db = this.createDatabase()
  }

  private createDatabase(): DatabaseSync {
    const db = new DatabaseSync(':memory:')
    db.exec(`
      CREATE TABLE fragments (
        rowid INTEGER PRIMARY KEY,
        fragment_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        semantic_kind TEXT NOT NULL,
        text TEXT NOT NULL,
        text_index TEXT NOT NULL,
        tool_name TEXT,
        is_error INTEGER NOT NULL DEFAULT 0,
        tool_call_id TEXT,
        custom_type TEXT
      );
      CREATE VIRTUAL TABLE fragments_fts USING fts5(
        text_index,
        content='fragments',
        content_rowid='rowid',
        tokenize="unicode61 tokenchars '_-.'"
      );
    `)
    return db
  }

  close(): void {
    this.db.close()
  }

  // -------------------------------------------------------------------------
  // Indexing
  // -------------------------------------------------------------------------

  indexSession(parsed: ParsedSession, sourceInfo: SessionSourceInfo): void {
    const { header } = parsed
    const entryRecords = this.buildEntryRecords(parsed)
    const tree = buildSessionTree(header.sessionId, entryRecords)
    const relationships = extractRelationships(header.sessionId, tree)
    const sessionParentEdge = extractSessionParentEdge(header.sessionId, header)
    const sessionName = this.computeSessionName(tree)

    // Replace any existing session transactionally.
    this.db.exec('BEGIN')
    try {
      this.deleteSessionRows(header.sessionId)
      this.insertFragments(tree)
      this.db.exec(`INSERT INTO fragments_fts(fragments_fts) VALUES('rebuild')`)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      this.rebuildFragmentRowidMap()
      throw err
    }
    this.sessions.set(header.sessionId, {
      header,
      sourceInfo,
      tree,
      relationships,
      sessionParentEdge,
      sessionName,
    })
    this.rebuildFragmentRowidMap()
  }

  /**
   * Append only the durable suffix of an append-only session. The full file is
   * parsed for validation and tree recomputation, but only new fragments are
   * inserted into the disposable FTS index.
   */
  appendSession(parsed: ParsedSession, sourceInfo: SessionSourceInfo, previousEntryCount: number): void {
    const { header } = parsed
    const entryRecords = this.buildEntryRecords(parsed)
    const tree = buildSessionTree(header.sessionId, entryRecords)
    const relationships = extractRelationships(header.sessionId, tree)
    const sessionParentEdge = extractSessionParentEdge(header.sessionId, header)
    const sessionName = this.computeSessionName(tree)
    const newEntries = tree.entries.filter((entry) => entry.appendSeq >= previousEntryCount)

    this.db.exec('BEGIN')
    try {
      this.insertFragments({ ...tree, entries: newEntries } as ReturnType<typeof buildSessionTree>)
      this.db.exec(`INSERT INTO fragments_fts(fragments_fts) VALUES('rebuild')`)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      this.rebuildFragmentRowidMap()
      throw err
    }
    this.sessions.set(header.sessionId, {
      header,
      sourceInfo,
      tree,
      relationships,
      sessionParentEdge,
      sessionName,
    })
    this.rebuildFragmentRowidMap()
  }

  removeSession(sessionId: string): void {
    if (!this.sessions.has(sessionId)) return
    this.db.exec('BEGIN')
    try {
      this.deleteSessionRows(sessionId)
      this.db.exec(`INSERT INTO fragments_fts(fragments_fts) VALUES('rebuild')`)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      this.rebuildFragmentRowidMap()
      throw err
    }
    this.sessions.delete(sessionId)
    this.rebuildFragmentRowidMap()
  }

  private buildEntryRecords(parsed: ParsedSession): Array<import('../types.ts').EntryRecord> {
    const { header, entries } = parsed
    return entries.map((entry, index) => {
      const projection = this.projector.project(header.sessionId, entry)
      return {
        ...entry,
        ...projection,
        id: entry.id,
        type: entry.type,
        appendSeq: index,
        branchState: 'unknown',
        selectionState: 'unknown',
        fragments: projection.fragments,
      } as import('../types.ts').EntryRecord
    })
  }

  private insertFragments(tree: ReturnType<typeof buildSessionTree>): void {
    const insertFragment = this.db.prepare(`
      INSERT INTO fragments(fragment_id, session_id, entry_id, semantic_kind, text, text_index, tool_name, is_error, tool_call_id, custom_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const entry of tree.entries) {
      for (const fragment of entry.fragments) {
        insertFragment.run(
          fragment.fragmentId,
          fragment.sessionId,
          fragment.entryId,
          fragment.semanticKind,
          fragment.text,
          segmentForIndex(fragment.text),
          fragment.toolName ?? null,
          fragment.isError === true ? 1 : 0,
          fragment.toolCallId ?? null,
          fragment.customType ?? null,
        )
      }
    }
  }

  private deleteSessionRows(sessionId: string): void {
    const rows = this.db.prepare(`SELECT rowid FROM fragments WHERE session_id = ?`).all(sessionId) as Array<{ rowid: number }>
    const deleteFragment = this.db.prepare(`DELETE FROM fragments WHERE rowid = ?`)
    for (const row of rows) {
      deleteFragment.run(row.rowid)
    }
  }

  /** Rebuild the rowid->fragment map from the database after any mutation. */
  private rebuildFragmentRowidMap(): void {
    this.fragmentsByRowid.clear()
    const rows = this.db.prepare(`SELECT rowid, session_id, fragment_id FROM fragments`).all() as Array<{
      rowid: number
      session_id: string
      fragment_id: string
    }>
    for (const row of rows) {
      const session = this.sessions.get(row.session_id)
      if (!session) continue
      let found: Fragment | undefined
      for (const entry of session.tree.entries) {
        for (const fragment of entry.fragments) {
          if (fragment.fragmentId === row.fragment_id) {
            found = fragment
            break
          }
        }
        if (found) break
      }
      if (found) this.fragmentsByRowid.set(row.rowid, found)
    }
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  getSession(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId)
  }

  get sessionsList(): SessionRecord[] {
    return [...this.sessions.values()]
  }

  private computeSessionName(tree: ReturnType<typeof buildSessionTree>): string | undefined {
    for (const entry of tree.entries) {
      for (const fragment of entry.fragments) {
        if (fragment.semanticKind === 'session.name') return fragment.text
      }
    }
    return undefined
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  searchEvents(request: EventSearchRequest, context: SearchContext, limit?: number): EventSearchHit[] {
    const parsed = parseQuery(request.query)
    const authRoot = normalizePath(context.authRoot)
    const maxHits = limit ?? this.searchLimit

    if (request.sessionId !== undefined) {
      const session = this.sessions.get(request.sessionId)
      if (!session || !this.isSessionAuthorized(session, authRoot)) {
        throw notFoundError(`session ${request.sessionId}`)
      }
    }

    const sessionFilter = this.authorizedSessionFilter(request, authRoot)
    if (sessionFilter.sessionIds.length === 0) return []

    const grouped = new Map<string, { fragment: Fragment; count: number; rank: number }>()
    const sqlFilter = this.buildSqlFilter(request, sessionFilter.sessionIds)
    const pageSize = 1000
    let offset = 0

    while (grouped.size < maxHits) {
      const rows = this.runFtsPage(parsed.ftsQuery, sqlFilter, pageSize, offset)
      if (rows.length === 0) break
      for (const row of rows) {
        const fragment = this.fragmentsByRowid.get(row.rowid)
        if (!fragment) continue
        const session = this.sessions.get(fragment.sessionId)
        if (!session) continue
        if (!this.passesRemainingFilters(request, session, fragment)) continue
        if (!this.passesCurrentSessionPolicy(request, context.execution, session, fragment)) continue

        const key = `${fragment.sessionId}\u0000${fragment.entryId}`
        const existing = grouped.get(key)
        if (existing) {
          existing.count += 1
          continue
        }
        grouped.set(key, { fragment, count: 1, rank: row.rank })
      }
      offset += pageSize
      if (rows.length < pageSize) break
    }

    const hits: EventSearchHit[] = []
    for (const { fragment, count } of grouped.values()) {
      const session = this.sessions.get(fragment.sessionId)
      if (!session) continue
      const entry = session.tree.byId.get(fragment.entryId)
      if (!entry) continue
      hits.push({
        sessionId: fragment.sessionId,
        sessionName: session.sessionName,
        cwd: session.header.cwd,
        entryId: fragment.entryId,
        entryType: entry.entryType,
        matchingFragmentId: fragment.fragmentId,
        semanticKind: fragment.semanticKind,
        timestamp: entry.timestamp,
        branchState: entry.branchState,
        selectionState: entry.selectionState,
        snippet: buildSnippet(fragment.text, [...parsed.terms, ...parsed.phrases]),
        matchingFragmentCount: count,
      })
    }
    return hits.slice(0, maxHits)
  }

  /** Resolve session ids that pass authorization and the optional cwd filter. */
  private authorizedSessionFilter(request: EventSearchRequest, authRoot: string): { sessionIds: string[] } {
    const ids: string[] = []
    for (const session of this.sessions.values()) {
      if (!this.isSessionAuthorized(session, authRoot)) continue
      if (request.sessionId !== undefined && session.header.sessionId !== request.sessionId) continue
      if (request.cwd !== undefined && !isPathWithin(session.header.cwd, normalizePath(request.cwd))) continue
      ids.push(session.header.sessionId)
    }
    ids.sort()
    return { sessionIds: ids }
  }

  /** Push session, kind, tool-name and error filters into SQL. */
  private buildSqlFilter(request: EventSearchRequest, sessionIds: string[]): { where: string; params: unknown[] } {
    const conditions: string[] = []
    const params: unknown[] = []
    conditions.push(`f.session_id IN (${sessionIds.map(() => '?').join(', ')})`)
    params.push(...sessionIds)
    if (request.kinds !== undefined && request.kinds.length > 0) {
      conditions.push(`f.semantic_kind IN (${request.kinds.map(() => '?').join(', ')})`)
      params.push(...request.kinds)
    }
    if (request.toolNames !== undefined && request.toolNames.length > 0) {
      conditions.push(`f.tool_name IN (${request.toolNames.map(() => '?').join(', ')})`)
      params.push(...request.toolNames)
    } else {
      // Retrieval calls are retained as evidence, but suppress them from
      // ordinary searches so search/read responses do not recursively become
      // the strongest hits for their own query terms. An explicit toolNames
      // filter opts back into this audit traffic.
      conditions.push(`COALESCE(f.tool_name, '') NOT IN (${SELF_RETRIEVAL_TOOL_NAMES.map(() => '?').join(', ')})`)
      params.push(...SELF_RETRIEVAL_TOOL_NAMES)
    }
    if (request.errorOnly === true) {
      conditions.push('f.is_error = 1')
    }
    return { where: conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '', params }
  }

  /** Filters that need tree metadata and therefore stay in JS. */
  private passesRemainingFilters(request: EventSearchRequest, session: SessionRecord, fragment: Fragment): boolean {
    const entry = session.tree.byId.get(fragment.entryId)
    if (!entry) return false
    if (request.entryTypes !== undefined && request.entryTypes.length > 0 && !request.entryTypes.includes(entry.entryType)) return false
    if (request.roles !== undefined && request.roles.length > 0 && !request.roles.includes(entry.role)) return false
    if (request.time !== undefined) {
      if (request.time.from !== undefined && entry.timestamp < request.time.from) return false
      if (request.time.to !== undefined && entry.timestamp > request.time.to) return false
    }
    if (request.branchStates !== undefined && request.branchStates.length > 0 && !request.branchStates.includes(entry.branchState)) return false
    if (request.selectionStates !== undefined && request.selectionStates.length > 0 && !request.selectionStates.includes(entry.selectionState)) return false
    return true
  }

  private runFtsPage(
    ftsQuery: string,
    sqlFilter: { where: string; params: unknown[] },
    limit: number,
    offset: number,
  ): Array<{ rowid: number; rank: number }> {
    const sql = `
      SELECT fragments_fts.rowid AS rowid, bm25(fragments_fts) AS rank
      FROM fragments_fts
      JOIN fragments f ON f.rowid = fragments_fts.rowid
      WHERE fragments_fts MATCH ?
        ${sqlFilter.where}
      ORDER BY rank, fragments_fts.rowid
      LIMIT ? OFFSET ?
    `
    try {
      return (this.db.prepare(sql).all as any)(ftsQuery, ...sqlFilter.params, limit, offset) as Array<{ rowid: number; rank: number }>
    } catch (err) {
      const message = (err as Error).message
      if (message.includes('fts5') || message.includes('syntax error')) {
        throw new PiEventSearchError('INVALID_QUERY', 'Invalid search query.', message)
      }
      throw err
    }
  }

  private isSessionAuthorized(session: SessionRecord, authRoot: string): boolean {
    return isPathWithin(session.header.cwd, authRoot)
  }

  private passesCurrentSessionPolicy(
    request: EventSearchRequest,
    execution: ExecutionContext | undefined,
    session: SessionRecord,
    fragment: Fragment,
  ): boolean {
    const currentSessionId = execution?.currentSessionId
    if (currentSessionId === undefined) return true
    if (fragment.sessionId !== currentSessionId) return true
    if (request.sessionId !== currentSessionId) {
      return false
    }
    const entry = session.tree.byId.get(fragment.entryId)
    if (!entry) return false
    return this.isEntryBeforeCutoff(session, entry, execution!)
  }

  private resolveCutoffSeq(session: SessionRecord, execution: ExecutionContext): number {
    if (execution.invocationEntryId !== undefined) {
      const invocation = session.tree.byId.get(execution.invocationEntryId)
      if (invocation) return invocation.appendSeq
    }
    if (execution.invocationTimestamp !== undefined) {
      let firstAtOrAfter = session.tree.entries.findIndex((entry) => entry.timestamp >= execution.invocationTimestamp!)
      if (firstAtOrAfter === -1) firstAtOrAfter = session.tree.entries.length
      return firstAtOrAfter
    }
    throw new PiEventSearchError(
      'INVALID_ARGUMENT',
      'Current session retrieval requires an invocation cutoff.',
    )
  }

  private cutoffSeqForSession(
    session: SessionRecord,
    execution: ExecutionContext | undefined,
  ): number | undefined {
    if (execution?.currentSessionId !== session.header.sessionId) return undefined
    return this.resolveCutoffSeq(session, execution)
  }

  private isEntryBeforeCutoff(
    session: SessionRecord,
    entry: import('../types.ts').EntryRecord,
    execution: ExecutionContext | undefined,
  ): boolean {
    const cutoffSeq = this.cutoffSeqForSession(session, execution)
    return cutoffSeq === undefined || entry.appendSeq < cutoffSeq
  }

  private requireEntryBeforeCutoff(
    session: SessionRecord,
    entry: import('../types.ts').EntryRecord | undefined,
    execution: ExecutionContext | undefined,
    identity: string,
  ): import('../types.ts').EntryRecord {
    if (!entry || !this.isEntryBeforeCutoff(session, entry, execution)) {
      throw notFoundError(identity)
    }
    return entry
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  readEvent(
    sessionId: string,
    entryId: string,
    options: ReadEventOptions,
    authRoot: string,
    execution?: ExecutionContext,
  ): ReadEventResult {
    const session = this.requireAuthorizedSession(sessionId, authRoot)
    const entry = this.requireEntryBeforeCutoff(
      session,
      session.tree.byId.get(entryId),
      execution,
      `entry ${sessionId}/${entryId}`,
    )

    const rawEntry = entry as unknown as RawEntry
    const readProjection = this.readProjector.project(sessionId, rawEntry)
    const order = options.order ?? 'branch'
    const beforeLimit = options.before ?? 1
    const afterLimit = options.after ?? 1

    const neighbors = this.readNeighbors(sessionId, entryId, order, beforeLimit, afterLimit, authRoot, execution)
    const allProjectedFragments = readProjection.fragments
    let projectedFragments: Fragment[]
    if (options.fragmentId !== undefined) {
      const selectedFragment = allProjectedFragments.find((fragment) => fragment.fragmentId === options.fragmentId)
      if (selectedFragment === undefined) {
        throw notFoundError(`fragment ${sessionId}/${entryId}/${options.fragmentId}`)
      }
      projectedFragments = [selectedFragment]
    } else {
      projectedFragments = allProjectedFragments.slice(0, this.readMaxFragments)
    }
    const perFragmentBudget = projectedFragments.length === 0
      ? 0
      : Math.max(1, Math.floor(this.readAggregateChars / projectedFragments.length))
    const fragments = projectedFragments.map((fragment) => ({
      fragmentId: fragment.fragmentId,
      semanticKind: fragment.semanticKind,
      toolName: fragment.toolName,
      isError: fragment.isError,
      customType: fragment.customType,
      preview: makeTextPreview(fragment.text, {
        maxChars: Math.min(this.readPreviewChars, perFragmentBudget),
        offset: options.offset,
        windowChars: options.windowChars === undefined
          ? perFragmentBudget
          : Math.min(options.windowChars, perFragmentBudget),
      }),
    }))

    return {
      sessionId,
      entryId,
      entryType: entry.entryType,
      timestamp: entry.timestamp,
      parentId: entry.parentId,
      branchState: entry.branchState,
      selectionState: entry.selectionState,
      role: entry.role,
      contextRole: entry.contextRole,
      fragments,
      fragmentCoverage: {
        total: allProjectedFragments.length,
        returned: projectedFragments.length,
        omitted: allProjectedFragments.length - projectedFragments.length,
        truncated: options.fragmentId === undefined && allProjectedFragments.length > this.readMaxFragments,
      },
      neighbors,
    }
  }

  private readNeighbors(
    sessionId: string,
    entryId: string,
    order: 'branch' | 'append',
    beforeLimit: number,
    afterLimit: number,
    authRoot: string,
    execution?: ExecutionContext,
  ): ReadEventResult['neighbors'] {
    const session = this.requireAuthorizedSession(sessionId, authRoot)
    const tree = session.tree
    const eligible = (entry: import('../types.ts').EntryRecord) =>
      this.isEntryBeforeCutoff(session, entry, execution)
    if (order === 'append') {
      const { before, after } = appendNeighbors(entryId, tree, beforeLimit, afterLimit)
      return {
        order,
        before: before.filter(eligible).map((entry) => this.toNeighbor(session, entry)),
        after: after.filter(eligible).map((entry) => this.toNeighbor(session, entry)),
        forks: [],
      }
    }
    const ancestors = branchAncestors(entryId, tree, beforeLimit)
    const descendants = branchDescendants(entryId, tree, afterLimit)
    const target = tree.byId.get(entryId)
    const pathThroughTarget = target === undefined ? ancestors : [...ancestors, target]
    const ancestorForks: BranchFork[] = []
    for (let index = 0; index + 1 < pathThroughTarget.length; index += 1) {
      const fork = branchForkForEdge(pathThroughTarget[index].id, pathThroughTarget[index + 1].id, tree)
      if (fork !== undefined) ancestorForks.push(fork)
    }
    const localForks = [...ancestorForks, ...descendants.forks]
      .map((fork) => this.visibleFork(fork, session, eligible))
      .filter((fork): fork is NonNullable<typeof fork> => fork !== undefined)
    const visibleAncestors = ancestors.filter(eligible)
    const visibleDescendants = descendants.entries.filter(eligible)
    const visiblePath = target === undefined
      ? visibleAncestors
      : [...visibleAncestors, target, ...visibleDescendants]
    const crossSessionForks = this.crossSessionForksForPath(
      session,
      visiblePath,
      authRoot,
      execution,
    )
    const crossSessionAnchorIds = new Set(crossSessionForks.map((fork) => fork.at.entryId))
    return {
      order,
      before: visibleAncestors.map((entry) => this.toNeighbor(session, entry)),
      after: visibleDescendants.map((entry) => this.toNeighbor(session, entry)),
      // A cross-session receipt contains both the parent-local and copied
      // continuations, so it supersedes a narrower local receipt at the same
      // copied anchor.
      forks: [
        ...localForks.filter((fork) => !crossSessionAnchorIds.has(fork.at.entryId)),
        ...crossSessionForks,
      ],
    }
  }

  private visibleFork(
    fork: BranchFork,
    session: SessionRecord,
    eligible: (entry: import('../types.ts').EntryRecord) => boolean,
  ): ReadEventResult['neighbors']['forks'][number] | undefined {
    const tree = session.tree
    const candidateChildIds = fork.candidateChildIds.filter((candidateId) => {
      const candidate = tree.byId.get(candidateId)
      return candidate !== undefined && eligible(candidate)
    })
    if (candidateChildIds.length <= 1) return undefined
    const chosenChildId = fork.chosenChildId !== undefined && candidateChildIds.includes(fork.chosenChildId)
      ? fork.chosenChildId
      : undefined
    return {
      kind: 'in-session',
      at: { sessionId: session.header.sessionId, entryId: fork.atEntryId },
      candidates: candidateChildIds.map((candidateId) => ({
        sessionId: session.header.sessionId,
        entryId: candidateId,
      })),
      chosen: chosenChildId === undefined
        ? undefined
        : { sessionId: session.header.sessionId, entryId: chosenChildId },
    }
  }

  private crossSessionForksForPath(
    session: SessionRecord,
    path: import('../types.ts').EntryRecord[],
    authRoot: string,
    execution?: ExecutionContext,
  ): BranchForkReceipt[] {
    if (path.length < 2) return []
    const groups = this.crossSessionForkGroups(authRoot, execution)
    const receipts: BranchForkReceipt[] = []
    const seen = new Set<string>()
    for (let index = 0; index + 1 < path.length; index += 1) {
      const from = path[index]
      const to = path[index + 1]
      for (const group of groups) {
        if (group.at.entryId !== from.id) continue
        if (!group.participantSessionIds.has(session.header.sessionId)) continue
        const chosen = group.candidates.find((candidate) =>
          candidate.sessionId === session.header.sessionId && candidate.entryId === to.id,
        )
        if (chosen === undefined) continue
        const key = identityKey(group.at)
        if (seen.has(key)) continue
        seen.add(key)
        receipts.push({
          kind: 'session-fork',
          at: group.at,
          candidates: group.candidates,
          chosen,
        })
      }
    }
    return receipts
  }

  private crossSessionForkGroups(
    authRoot: string,
    execution?: ExecutionContext,
  ): CrossSessionForkGroup[] {
    const normalizedRoot = normalizePath(authRoot)
    const groups = new Map<string, CrossSessionForkGroup>()

    for (const child of this.sessions.values()) {
      if (!this.isSessionAuthorized(child, normalizedRoot)) continue
      const parent = this.resolveParentSession(child, normalizedRoot)
      if (parent === undefined) continue
      const continuation = this.firstChildSessionContinuation(parent, child)
      if (continuation === undefined) continue
      const anchorId = child.tree.byId.get(continuation.entryId)?.parentId
      if (anchorId === null || anchorId === undefined) continue

      const at = { sessionId: parent.header.sessionId, entryId: anchorId }
      const key = identityKey(at)
      let group = groups.get(key)
      if (group === undefined) {
        group = {
          at,
          participantSessionIds: new Set([parent.header.sessionId]),
          candidates: [],
        }
        for (const candidateId of parent.tree.childrenByParent.get(anchorId) ?? []) {
          group.candidates.push({ sessionId: parent.header.sessionId, entryId: candidateId })
        }
        groups.set(key, group)
      }
      group.participantSessionIds.add(child.header.sessionId)
      group.candidates.push(continuation)
    }

    const result: CrossSessionForkGroup[] = []
    for (const group of groups.values()) {
      const uniqueCandidates = new Map<string, EntryIdentity>()
      for (const candidate of group.candidates) {
        const candidateSession = this.sessions.get(candidate.sessionId)
        const candidateEntry = candidateSession?.tree.byId.get(candidate.entryId)
        if (
          candidateSession === undefined ||
          candidateEntry === undefined ||
          !this.isSessionAuthorized(candidateSession, normalizedRoot) ||
          !this.isEntryBeforeCutoff(candidateSession, candidateEntry, execution)
        ) {
          continue
        }
        uniqueCandidates.set(identityKey(candidate), candidate)
      }
      const candidates = [...uniqueCandidates.values()].sort((left, right) => {
        if (left.sessionId === group.at.sessionId && right.sessionId !== group.at.sessionId) return -1
        if (right.sessionId === group.at.sessionId && left.sessionId !== group.at.sessionId) return 1
        return left.sessionId.localeCompare(right.sessionId) || left.entryId.localeCompare(right.entryId)
      })
      if (candidates.length <= 1) continue
      result.push({ ...group, candidates })
    }
    result.sort((left, right) => identityKey(left.at).localeCompare(identityKey(right.at)))
    return result
  }

  private resolveParentSession(child: SessionRecord, authRoot: string): SessionRecord | undefined {
    const parentRef = child.header.parentSession
    if (typeof parentRef !== 'string' || parentRef.length === 0) return undefined

    const direct = this.sessions.get(parentRef)
    if (direct !== undefined && this.isSessionAuthorized(direct, authRoot)) return direct

    const normalizedRef = normalizePath(parentRef)
    for (const candidate of this.sessions.values()) {
      if (!this.isSessionAuthorized(candidate, authRoot)) continue
      if (normalizePath(candidate.sourceInfo.filePath) === normalizedRef) return candidate
    }
    return undefined
  }

  private firstChildSessionContinuation(
    parent: SessionRecord,
    child: SessionRecord,
  ): EntryIdentity | undefined {
    let sawSharedEntry = false
    for (const entry of child.tree.entries) {
      const parentEntry = parent.tree.byId.get(entry.id)
      if (parentEntry !== undefined) {
        const parentHash = parent.sourceInfo.entryHashes[parentEntry.appendSeq]
        const childHash = child.sourceInfo.entryHashes[entry.appendSeq]
        if (
          parentHash !== undefined &&
          childHash !== undefined &&
          isDurableEntryHash(parentHash) &&
          isDurableEntryHash(childHash) &&
          parentHash !== childHash
        ) {
          return undefined
        }
        sawSharedEntry = true
        continue
      }
      if (!sawSharedEntry || entry.parentId === null) return undefined
      if (!parent.tree.byId.has(entry.parentId) || !child.tree.byId.has(entry.parentId)) return undefined
      return { sessionId: child.header.sessionId, entryId: entry.id }
    }
    return undefined
  }

  private toNeighbor(session: SessionRecord, entry: import('../types.ts').EntryRecord): ReadEventResult['neighbors']['before'][number] {
    return {
      sessionId: session.header.sessionId,
      entryId: entry.id,
      entryType: entry.entryType,
      timestamp: entry.timestamp,
      branchState: entry.branchState,
      selectionState: entry.selectionState,
      preview: this.previewEntry(session, entry),
    }
  }

  private previewEntry(session: SessionRecord, entry: import('../types.ts').EntryRecord): string {
    if (entry.fragments.length === 0) return ''
    const first = entry.fragments[0]
    return buildSnippet(first.text, [], { maxChars: 120 })
  }

  // -------------------------------------------------------------------------
  // Trace
  // -------------------------------------------------------------------------

  traceEvent(
    sessionId: string,
    entryId: string,
    authRoot: string,
    execution?: ExecutionContext,
  ): EventTrace {
    const session = this.requireAuthorizedSession(sessionId, authRoot)
    const tree = session.tree
    const entry = this.requireEntryBeforeCutoff(
      session,
      tree.byId.get(entryId),
      execution,
      `entry ${sessionId}/${entryId}`,
    )
    const cutoffSeq = this.cutoffSeqForSession(session, execution)
    const eligibleEntryId = (candidateId: string | null): boolean => {
      if (cutoffSeq === undefined) return true
      if (candidateId === null) return true
      const candidate = tree.byId.get(candidateId)
      return candidate !== undefined && candidate.appendSeq < cutoffSeq
    }

    const target: TraceNode = {
      sessionId,
      entryId,
      entryType: entry.entryType,
      timestamp: entry.timestamp,
      branchState: entry.branchState,
      selectionState: entry.selectionState,
      preview: this.previewEntry(session, entry),
    }

    const parent = entry.parentId !== null && eligibleEntryId(entry.parentId)
      ? this.recordedEdge(session, entry, entry.parentId, 'parent')
      : undefined
    const allChildren = (tree.childrenByParent.get(entryId) ?? [])
      .filter(eligibleEntryId)
      .map((childId) => this.recordedEdge(session, entry, childId, 'child'))
    const allBranchSiblings = entry.parentId !== null
      ? (tree.childrenByParent.get(entry.parentId) ?? [])
          .filter((childId) => childId !== entryId)
          .filter(eligibleEntryId)
          .map((childId) => this.derivedEdge(session, entry, childId, 'branch-sibling'))
      : []

    const related: TraceEdge[] = []
    for (const record of session.relationships) {
      if (record.sourceEntryId !== entryId && record.targetEntryId !== entryId) continue
      if (!eligibleEntryId(record.sourceEntryId) || !eligibleEntryId(record.targetEntryId)) continue
      related.push(recordToTraceEdge(session, record))
    }
    related.push(...this.crossSessionForkTraceEdges(session, entry, authRoot, execution))

    const children = allChildren.slice(0, this.traceMaxChildren)
    const branchSiblings = allBranchSiblings.slice(0, this.traceMaxChildren)
    const allRelated = related.slice(0, this.traceMaxRelated)
    return {
      target,
      parent,
      children,
      branchSiblings,
      related: allRelated,
      truncated:
        allChildren.length > this.traceMaxChildren ||
        allBranchSiblings.length > this.traceMaxChildren ||
        related.length > this.traceMaxRelated,
    }
  }

  /**
   * Return the authorized parent/child session lineage without loading
   * complete transcripts. Internal until a concrete model workflow requires
   * a fourth public tool.
   */
  traceSession(sessionId: string, authRoot: string): SessionLineage {
    const session = this.requireAuthorizedSession(sessionId, authRoot)
    const normalizedRoot = normalizePath(authRoot)
    const parent = this.resolveParentSession(session, normalizedRoot)
    const childSessionIds: string[] = []
    for (const candidate of this.sessions.values()) {
      if (!this.isSessionAuthorized(candidate, normalizedRoot)) continue
      const candidateParent = this.resolveParentSession(candidate, normalizedRoot)
      if (candidateParent?.header.sessionId === sessionId) {
        childSessionIds.push(candidate.header.sessionId)
      }
    }
    childSessionIds.sort()
    return {
      sessionId,
      parentSessionId: parent?.header.sessionId,
      childSessionIds,
    }
  }

  private crossSessionForkTraceEdges(
    session: SessionRecord,
    entry: import('../types.ts').EntryRecord,
    authRoot: string,
    execution?: ExecutionContext,
  ): TraceEdge[] {
    const target = { sessionId: session.header.sessionId, entryId: entry.id }
    const edges: TraceEdge[] = []
    const seen = new Set<string>()
    for (const group of this.crossSessionForkGroups(authRoot, execution)) {
      let destinations: EntryIdentity[] = []
      const isParticipantAnchor =
        group.at.entryId === entry.id && group.participantSessionIds.has(session.header.sessionId)
      if (isParticipantAnchor) {
        destinations = group.candidates
      } else if (group.candidates.some((candidate) => sameIdentity(candidate, target))) {
        destinations = group.candidates.filter((candidate) => !sameIdentity(candidate, target))
      }
      for (const destination of destinations) {
        if (sameIdentity(destination, target)) continue
        const edgeKey = identityKey(destination)
        if (seen.has(edgeKey)) continue
        seen.add(edgeKey)
        const destinationSession = this.sessions.get(destination.sessionId)
        const destinationEntry = destinationSession?.tree.byId.get(destination.entryId)
        edges.push({
          type: 'session-fork',
          from: target,
          to: destination,
          recorded: false,
          derived: true,
          detail: `fork at ${group.at.sessionId}/${group.at.entryId}`,
          targetBranchState: destinationEntry?.branchState ?? 'unknown',
          leadsToMaterializedLeaf:
            destinationSession !== undefined && destinationSession.tree.selectedSet.has(destination.entryId),
        })
      }
    }
    return edges
  }

  private recordedEdge(session: SessionRecord, fromEntry: import('../types.ts').EntryRecord, toEntryId: string, type: string): TraceEdge {
    const toEntry = session.tree.byId.get(toEntryId)
    return {
      type,
      from: { sessionId: session.header.sessionId, entryId: fromEntry.id },
      to: { sessionId: session.header.sessionId, entryId: toEntryId },
      recorded: true,
      targetBranchState: toEntry?.branchState ?? 'unknown',
      leadsToMaterializedLeaf:
        toEntry !== undefined && session.tree.selectedSet.has(toEntry.id),
    }
  }

  private derivedEdge(session: SessionRecord, fromEntry: import('../types.ts').EntryRecord, toEntryId: string, type: string): TraceEdge {
    const toEntry = session.tree.byId.get(toEntryId)
    return {
      type,
      from: { sessionId: session.header.sessionId, entryId: fromEntry.id },
      to: { sessionId: session.header.sessionId, entryId: toEntryId },
      recorded: false,
      derived: true,
      targetBranchState: toEntry?.branchState ?? 'unknown',
      leadsToMaterializedLeaf:
        toEntry !== undefined && session.tree.selectedSet.has(toEntry.id),
    }
  }

  private requireAuthorizedSession(sessionId: string, authRoot: string): SessionRecord {
    const session = this.sessions.get(sessionId)
    if (!session || !this.isSessionAuthorized(session, normalizePath(authRoot))) {
      throw notFoundError(`session ${sessionId}`)
    }
    return session
  }
}

function recordToTraceEdge(session: SessionRecord, record: RelationshipRecord): TraceEdge {
  const targetEntry =
    record.targetSessionId !== null && record.targetEntryId !== null
      ? session.tree.byId.get(record.targetEntryId)
      : undefined
  const target: { sessionId: string; entryId: string } | { fileRef: string } =
    record.targetRef !== null
      ? { fileRef: record.targetRef }
      : record.targetSessionId !== null && record.targetEntryId !== null
        ? { sessionId: record.targetSessionId, entryId: record.targetEntryId }
        : { sessionId: record.targetSessionId ?? session.header.sessionId, entryId: record.targetEntryId ?? '' }

  return {
    type: record.type,
    from: { sessionId: record.sourceSessionId, entryId: record.sourceEntryId ?? '' },
    to: target,
    recorded: record.recorded,
    derived: record.derived,
    detail: record.detail,
    targetBranchState: targetEntry?.branchState ?? 'unknown',
    leadsToMaterializedLeaf:
      targetEntry !== undefined && session.tree.selectedSet.has(targetEntry.id),
  }
}

function identityKey(identity: EntryIdentity): string {
  return `${identity.sessionId}\u0000${identity.entryId}`
}

function sameIdentity(left: EntryIdentity, right: EntryIdentity): boolean {
  return left.sessionId === right.sessionId && left.entryId === right.entryId
}

function isDurableEntryHash(value: string): boolean {
  return /^[0-9a-f]{8}$/.test(value)
}
