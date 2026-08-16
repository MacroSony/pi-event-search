/**
 * Core public and internal types for pi-event-search.
 *
 * The persisted JSONL is canonical. Every public hit resolves to an exact
 * `(sessionId, entryId)` source identity. Index observations such as line
 * numbers or SQLite rowids are never public identity.
 */

// ---------------------------------------------------------------------------
// Source model
// ---------------------------------------------------------------------------

export interface SessionHeader {
  /** Header field names mirror the persisted JSONL vocabulary. */
  sessionId: string
  createdAt: string
  cwd: string
  parentSession?: string | null
}

export interface RawEntry {
  id: string
  parentId: string | null
  timestamp: string
  type: string
  [key: string]: unknown
}

export interface ParsedSession {
  header: SessionHeader
  entries: RawEntry[]
}

/** Source file observation used for append detection and rebuild decisions. */
export interface SessionSourceInfo {
  filePath: string
  size: number
  mtimeMs: number
  header: SessionHeader
  entryCount: number
  firstEntryId: string | null
  lastEntryId: string | null
  /** Hash per raw entry line, used to detect mid-file rewrites. */
  entryHashes: string[]
  /** Hash of canonical header fields; header changes force a rebuild. */
  headerHash: string
}

// ---------------------------------------------------------------------------
// Entry and event model
// ---------------------------------------------------------------------------

export interface EntryIdentity {
  sessionId: string
  entryId: string
}

/** An entry enriched with append and tree position plus classifications. */
export type EntryRecord = RawEntry & {
  sessionId: string
  entryType: string
  appendSeq: number
  branchState: BranchState
  selectionState: SelectionState
  contextRole: ContextRole
  role: Role
  fragments: Fragment[]
}

export type BranchState = 'selected' | 'alternate' | 'unknown'
export type SelectionState =
  | 'direct'
  | 'summarized'
  | 'not-selected'
  | 'not-applicable'
  | 'unknown'
export type ContextRole = 'conversation' | 'summary' | 'control' | 'metadata'
export type Role = 'user' | 'assistant' | 'tool' | 'summary' | 'metadata' | 'custom'

// ---------------------------------------------------------------------------
// Fragments and events
// ---------------------------------------------------------------------------

export type SemanticKind =
  | 'user.text'
  | 'assistant.text'
  | 'assistant.thinking'
  | 'tool.call'
  | 'tool.result'
  | 'bash.command'
  | 'bash.output'
  | 'summary.compaction'
  | 'summary.branch'
  | 'custom.message'
  | 'session.name'

/** One searchable semantic part of an entry. */
export interface Fragment {
  /** Local to its event and deterministic for unchanged source content. */
  fragmentId: string
  sessionId: string
  entryId: string
  semanticKind: SemanticKind
  /** Searchable text. Bounded at projection time for output-heavy sources. */
  text: string
  toolName?: string
  toolCallId?: string
  isError?: boolean
  customType?: string
  /** Best-effort file evidence for recognized tool calls (inferred, not recorded). */
  filePaths?: string[]
  fileEvidenceType?: 'file-read' | 'file-changed'
}

/** The public retrieval concept: one entry projected to typed fragments. */
export interface EventRecord {
  sessionId: string
  entryId: string
  entryType: string
  timestamp: string
  parentId: string | null
  appendSeq: number
  branchState: BranchState
  selectionState: SelectionState
  contextRole: ContextRole
  role: Role
  fragments: Fragment[]
}

// ---------------------------------------------------------------------------
// Search API
// ---------------------------------------------------------------------------

export interface EventSearchRequest {
  query: string
  sessionId?: string
  cwd?: string
  kinds?: string[]
  entryTypes?: string[]
  roles?: string[]
  toolNames?: string[]
  errorOnly?: boolean
  time?: { from?: string; to?: string }
  branchStates?: Array<BranchState>
  selectionStates?: Array<SelectionState>
}

export interface EventSearchHit {
  sessionId: string
  sessionName?: string
  cwd: string
  entryId: string
  entryType: string
  /** Strongest matching fragment retained as evidence for the event hit. */
  matchingFragmentId: string
  semanticKind: string
  timestamp: string
  branchState: string
  selectionState: string
  snippet: string
  matchingFragmentCount: number
}

// ---------------------------------------------------------------------------
// Read API
// ---------------------------------------------------------------------------

export type ReadOrder = 'branch' | 'append'

export interface ReadEventOptions {
  order?: ReadOrder
  before?: number
  after?: number
  /** Read only this deterministic fragment within the event. */
  fragmentId?: string
  /** Unicode code-point offset for a fixed-size contiguous window. */
  offset?: number
  windowChars?: number
}

export interface ReadEventNeighbor {
  sessionId: string
  entryId: string
  entryType: string
  timestamp: string
  branchState: BranchState
  selectionState: SelectionState
  preview: string
  /** True when this neighbor is on the alternate fork at a branch point. */
  alternateBranch?: boolean
}

export interface ReadEventFragment {
  fragmentId: string
  semanticKind: SemanticKind
  toolName?: string
  isError?: boolean
  customType?: string
  /** The only public text surface; bounded by aggregate and per-fragment caps. */
  preview: TextPreview
}

export interface ReadEventResult {
  sessionId: string
  entryId: string
  entryType: string
  timestamp: string
  parentId: string | null
  branchState: BranchState
  selectionState: SelectionState
  role: Role
  contextRole: ContextRole
  fragments: ReadEventFragment[]
  fragmentCoverage: {
    total: number
    returned: number
    omitted: number
    truncated: boolean
  }
  neighbors: {
    order: ReadOrder
    before: ReadEventNeighbor[]
    after: ReadEventNeighbor[]
    /** Forks encountered on the returned branch path. */
    forks: BranchForkReceipt[]
  }
}

export interface BranchForkReceipt {
  kind: 'in-session' | 'session-fork'
  /** Canonical event at which the continuations diverge. */
  at: EntryIdentity
  /** All continuations visible and authorized for this invocation. */
  candidates: EntryIdentity[]
  /** Present when branch order selected a continuation. */
  chosen?: EntryIdentity
}

// ---------------------------------------------------------------------------
// Bounded text windows
// ---------------------------------------------------------------------------

export interface TextRange {
  /** Unicode code-point offsets into the original text. */
  start: number
  end: number
}

export interface TextPreview {
  text: string
  totalChars: number
  shownRanges: TextRange[]
  omittedRanges: TextRange[]
  truncated: boolean
}

// ---------------------------------------------------------------------------
// Trace API
// ---------------------------------------------------------------------------

export interface TraceNode {
  sessionId: string
  entryId: string
  entryType: string
  timestamp: string
  branchState: BranchState
  selectionState: SelectionState
  preview: string
}

export interface TraceEdge {
  type: string
  from: EntryIdentity
  to: EntryIdentity | { fileRef: string }
  recorded: boolean
  derived?: boolean
  detail?: string
  targetBranchState?: BranchState
  leadsToMaterializedLeaf?: boolean
}

export interface EventTrace {
  target: TraceNode
  parent?: TraceEdge
  children: TraceEdge[]
  branchSiblings: TraceEdge[]
  related: TraceEdge[]
  truncated: boolean
}

export interface SessionLineage {
  sessionId: string
  parentSessionId?: string
  childSessionIds: string[]
}

// ---------------------------------------------------------------------------
// Authorization context
// ---------------------------------------------------------------------------

export interface ExecutionContext {
  /** Current invoking session, excluded unless explicitly targeted. */
  currentSessionId?: string
  /** The entry containing the invoking tool call. Excluded with later entries. */
  invocationEntryId?: string
  invocationTimestamp?: string
}

export interface AuthConfig {
  explicitWorkspaceRoot?: string
  cwd: string
}
