import { DatabaseSync } from 'node:sqlite'
import { PiEventSearchError, notFoundError } from '../errors.ts'
import { Projector } from '../projector.ts'
import type {
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
import { buildSessionTree, branchAncestors, branchDescendants, appendNeighbors } from '../tree.ts'
import { extractRelationships, extractSessionParentEdge, type RelationshipRecord } from '../relationships.ts'
import { buildSnippet, makeTextPreview } from '../snippets.ts'
import { parseQuery } from '../query.ts'
import { isPathWithin, normalizePath } from '../auth/paths.ts'

export interface ProviderOptions {
  searchLimit?: number
  readPreviewChars?: number
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
        tool_name TEXT,
        is_error INTEGER NOT NULL DEFAULT 0,
        tool_call_id TEXT,
        custom_type TEXT
      );
      CREATE VIRTUAL TABLE fragments_fts USING fts5(
        text,
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
      INSERT INTO fragments(fragment_id, session_id, entry_id, semantic_kind, text, tool_name, is_error, tool_call_id, custom_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const entry of tree.entries) {
      for (const fragment of entry.fragments) {
        insertFragment.run(
          fragment.fragmentId,
          fragment.sessionId,
          fragment.entryId,
          fragment.semanticKind,
          fragment.text,
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

    const matchRows = this.runFtsMatch(parsed.ftsQuery, Math.max(maxHits * 50, 500))
    const grouped = new Map<string, { fragment: Fragment; count: number; rank: number }>()

    for (const row of matchRows) {
      const fragment = this.fragmentsByRowid.get(row.rowid)
      if (!fragment) continue
      const session = this.sessions.get(fragment.sessionId)
      if (!session) continue
      if (!this.isSessionAuthorized(session, authRoot)) continue
      if (!this.passesFilters(request, session, fragment)) continue
      if (!this.passesCurrentSessionPolicy(request, context.execution, session, fragment)) continue

      const key = `${fragment.sessionId}\u0000${fragment.entryId}`
      const existing = grouped.get(key)
      if (existing) {
        existing.count += 1
        continue
      }
      grouped.set(key, { fragment, count: 1, rank: row.rank })
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

  private runFtsMatch(ftsQuery: string, cap: number): Array<{ rowid: number; rank: number }> {
    try {
      return this.db
        .prepare(`SELECT rowid, bm25(fragments_fts) AS rank FROM fragments_fts WHERE fragments_fts MATCH ? ORDER BY rank LIMIT ?`)
        .all(ftsQuery, cap) as Array<{ rowid: number; rank: number }>
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

  private passesFilters(request: EventSearchRequest, session: SessionRecord, fragment: Fragment): boolean {
    const entry = session.tree.byId.get(fragment.entryId)
    if (!entry) return false

    if (request.sessionId !== undefined && fragment.sessionId !== request.sessionId) return false
    if (request.cwd !== undefined && !isPathWithin(session.header.cwd, normalizePath(request.cwd))) return false
    if (request.kinds !== undefined && request.kinds.length > 0 && !request.kinds.includes(fragment.semanticKind)) return false
    if (request.entryTypes !== undefined && request.entryTypes.length > 0 && !request.entryTypes.includes(entry.entryType)) return false
    if (request.roles !== undefined && request.roles.length > 0 && !request.roles.includes(entry.role)) return false
    if (request.toolNames !== undefined && request.toolNames.length > 0 && !(fragment.toolName !== undefined && request.toolNames.includes(fragment.toolName))) return false
    if (request.errorOnly === true && fragment.isError !== true) return false
    if (request.time !== undefined) {
      if (request.time.from !== undefined && entry.timestamp < request.time.from) return false
      if (request.time.to !== undefined && entry.timestamp > request.time.to) return false
    }
    if (request.branchStates !== undefined && request.branchStates.length > 0 && !request.branchStates.includes(entry.branchState)) return false
    if (request.selectionStates !== undefined && request.selectionStates.length > 0 && !request.selectionStates.includes(entry.selectionState)) return false
    return true
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
    const cutoffSeq = this.resolveCutoffSeq(session, execution)
    return entry.appendSeq < cutoffSeq
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
      'Current session search requires an invocation cutoff.',
    )
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  readEvent(sessionId: string, entryId: string, options: ReadEventOptions, authRoot: string): ReadEventResult {
    const session = this.requireAuthorizedSession(sessionId, authRoot)
    const entry = session.tree.byId.get(entryId)
    if (!entry) throw notFoundError(`entry ${sessionId}/${entryId}`)

    const rawEntry = entry as unknown as RawEntry
    const readProjection = this.readProjector.project(sessionId, rawEntry)
    const order = options.order ?? 'branch'
    const beforeLimit = options.before ?? 1
    const afterLimit = options.after ?? 1

    const neighbors = this.readNeighbors(sessionId, entryId, order, beforeLimit, afterLimit, authRoot)
    const fragments = readProjection.fragments.map((fragment) => ({
      semanticKind: fragment.semanticKind,
      text: fragment.text,
      toolName: fragment.toolName,
      isError: fragment.isError,
      customType: fragment.customType,
      preview: makeTextPreview(fragment.text, {
        maxChars: this.readPreviewChars,
        offset: options.offset,
        windowChars: options.windowChars,
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
  ): ReadEventResult['neighbors'] {
    const session = this.requireAuthorizedSession(sessionId, authRoot)
    const tree = session.tree
    if (order === 'append') {
      const { before, after } = appendNeighbors(entryId, tree, beforeLimit, afterLimit)
      return {
        order,
        before: before.map((entry) => this.toNeighbor(session, entry)),
        after: after.map((entry) => this.toNeighbor(session, entry)),
      }
    }
    const ancestors = branchAncestors(entryId, tree, beforeLimit)
    const descendants = branchDescendants(entryId, tree, afterLimit)
    return {
      order,
      before: ancestors.map((entry) => this.toNeighbor(session, entry)),
      after: descendants.entries.map((entry) => this.toNeighbor(session, entry)),
      fork: descendants.fork
        ? { atEntryId: descendants.fork.atEntryId, candidateChildIds: descendants.fork.candidateChildIds }
        : undefined,
    }
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

  traceEvent(sessionId: string, entryId: string, authRoot: string): EventTrace {
    const session = this.requireAuthorizedSession(sessionId, authRoot)
    const tree = session.tree
    const entry = tree.byId.get(entryId)
    if (!entry) throw notFoundError(`entry ${sessionId}/${entryId}`)

    const target: TraceNode = {
      sessionId,
      entryId,
      entryType: entry.entryType,
      timestamp: entry.timestamp,
      branchState: entry.branchState,
      selectionState: entry.selectionState,
      preview: this.previewEntry(session, entry),
    }

    const parent = entry.parentId !== null ? this.recordedEdge(session, entry, entry.parentId, 'parent') : undefined
    const allChildren = (tree.childrenByParent.get(entryId) ?? []).map((childId) =>
      this.recordedEdge(session, entry, childId, 'child'),
    )
    const allBranchSiblings = entry.parentId !== null
      ? (tree.childrenByParent.get(entry.parentId) ?? [])
          .filter((childId) => childId !== entryId)
          .map((childId) => this.derivedEdge(session, entry, childId, 'branch-sibling'))
      : []

    const related: TraceEdge[] = []
    for (const record of session.relationships) {
      if (record.sourceEntryId !== entryId && record.targetEntryId !== entryId) continue
      related.push(recordToTraceEdge(session, record))
    }

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
    const childSessionIds: string[] = []
    for (const candidate of this.sessions.values()) {
      const parentRef = candidate.header.parentSession
      const matches =
        parentRef === sessionId ||
        (parentRef !== undefined && parentRef === session.sourceInfo.filePath)
      if (matches) {
        if (this.isSessionAuthorized(candidate, normalizePath(authRoot))) {
          childSessionIds.push(candidate.header.sessionId)
        }
      }
    }
    childSessionIds.sort()
    return {
      sessionId,
      parentSessionId: session.header.parentSession ?? undefined,
      childSessionIds,
    }
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
  const target =
    record.targetRef !== null
      ? { fileRef: record.targetRef }
      : record.targetSessionId !== null && record.targetEntryId !== null
        ? { sessionId: record.targetSessionId, entryId: record.targetEntryId }
        : { sessionId: record.targetSessionId ?? session.header.sessionId }

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
