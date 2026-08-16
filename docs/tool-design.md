# Tool design

This document defines the MVP capability boundaries. Exact TypeScript schemas
may still evolve, but the public names, event-level result model, provenance,
and authorization behavior are settled.

## MVP decisions

- Public Pi tools: `event_search`, `event_read`, and `event_trace`.
- One public event is one persisted Pi entry; semantic fragments are match evidence.
- Search results are events, not sessions. Session grouping is deferred.
- Branch context is the default; append context is an explicit forensic option.
- Workspace authorization uses an automatically resolved repo root with explicit overrides.
- Assistant reasoning is neither indexed nor returned.
- Large text uses fixed character bounds, head/tail previews, and movable contiguous windows.
- Search accepts plain terms and quoted phrases, with implicit AND semantics.
- The current session is searched only when explicitly targeted, with an invocation cutoff.
- Discovery uses Pi's effective session directory plus configured additional or archive directories.
- The extension is standalone. Optional pi-forge policy integration can follow later.

## Retrieval workflow

The intended model workflow is progressive:

1. Search for small event hits.
2. Read an exact useful hit with bounded context.
3. Trace relationships only when the event depends on a tool call, compaction, branch, label, or parent session.

The model should not need to load an entire old transcript to answer a narrow historical question.

## Internal capabilities

### `searchEvents`

Search semantic fragments across the authorized corpus.

Input concepts:

```ts
interface EventSearchRequest {
  query: string
  sessionId?: string
  cwd?: string
  kinds?: string[]
  roles?: string[]
  toolNames?: string[]
  errorOnly?: boolean
  time?: { from?: string; to?: string }
  branchStates?: Array<'selected' | 'alternate' | 'unknown'>
  selectionStates?: Array<'direct' | 'summarized' | 'not-selected' | 'not-applicable' | 'unknown'>
}
```

`query` contains plain terms and quoted phrases; separate terms use implicit
AND. Boolean operators, column syntax, and other raw FTS expressions are not
part of the public language. Metadata constraints use the structured fields.
Latin identifiers use token matching rather than arbitrary substring matching,
so dogfood markers embedded directly inside a longer alphanumeric run require
separators. CJK text is segmented separately to retain useful substring search.

Calls and results from `event_search`, `event_read`, and `event_trace` remain
indexed as audit evidence but are suppressed from ordinary search results. An
explicit `toolNames` filter opts into them, preventing retrieval output from
recursively becoming the strongest evidence for its own query.

The Pi tool should own the result limit and provider pagination. A model-controlled unbounded limit is not part of the first contract.

Each result contains at least:

```ts
interface EventSearchHit {
  sessionId: string
  sessionName?: string
  cwd: string
  entryId: string
  entryType: string
  matchingFragmentId: string
  semanticKind: string
  timestamp: string
  branchState: string
  selectionState: string
  snippet: string
  matchingFragmentCount: number
}
```

FTS ranks fragments internally. Fragments with the same `(sessionId, entryId)`
are coalesced into one `EventSearchHit`, using the strongest fragment for
`matchingFragmentId`, `semanticKind`, and `snippet`. Other matching fragments
may be named in bounded metadata, but they do not produce duplicate event
results.

### `readEvent`

Read one authorized source event by `(sessionId, entryId)`.

The operation returns:

- normalized event metadata
- the source entry type and searchable semantic fragments
- explicit truncation/omission receipts
- optional neighboring events

Pi's tree makes an unqualified `before`/`after` ambiguous. The request supports:

- `order: 'branch'` for ancestors and descendants on one conversational path
- `order: 'append'` for neighboring durable JSONL records regardless of branch

`branch` is the default because it reconstructs conversational context. Before
the target, it follows `parentId`; the closest requested predecessors are
returned in conversational order. After the target, it follows the child toward
the materialized leaf when the target is on that path. On an alternate branch,
it follows a sole-child chain but stops at the first unresolved fork. The read
reports the chosen continuation and all visible alternatives at each encountered
fork, including Pi forks that copied history into another session.

Fork receipts are plural because one bounded path may cross several forks.
Every identity includes its session because Pi's `--fork` workflow copies entry
ids into the child session:

```ts
interface BranchForkReceipt {
  kind: 'in-session' | 'session-fork'
  at: { sessionId: string; entryId: string }
  candidates: Array<{ sessionId: string; entryId: string }>
  chosen?: { sessionId: string; entryId: string }
}
```

For `session-fork`, the parent-session event is the canonical `at` identity.
The fork anchor and continuations are derived only when the recorded parent
session is indexed and authorized. A missing, skipped, or unauthorized parent
does not expose its source path through the receipt.

Alternative branch contents are not mixed into the linear neighbor window.
`append` is deterministic log chronology and is useful for debugging indexing,
branch creation, and extension events, but may place unrelated alternate-branch
entries beside the target.

### Bounded content windows

Every textual field is subject to a configured character budget. A normal read
shows both the beginning and end of oversized content and returns a receipt:

```ts
interface TextPreview {
  text: string
  totalChars: number
  shownRanges: Array<{ start: number; end: number }>
  omittedRanges: Array<{ start: number; end: number }>
  truncated: boolean
}
```

Instead of a special “jump to middle” operation, `event_read` accepts the
`matchingFragmentId` returned by search plus an optional character offset for a
fixed-size contiguous window. This lets the caller inspect the middle—or any
other omitted range—of one exact fragment without allowing it to raise the
output cap. Offsets and ranges use non-negative Unicode code-point integers,
not UTF-16 code units, so they remain stable for non-ASCII text.

An unfiltered read returns at most a configured number of fragments and reports
`total`, `returned`, `omitted`, and `truncated` fragment coverage. A targeted
fragment read is not displaced by that cap.

### `traceEvent`

Return the bounded local relationship graph for one event. Its default shape is:

```ts
interface EventTrace {
  target: TraceNode
  parent?: TraceEdge
  children: TraceEdge[]
  branchSiblings: TraceEdge[]
  related: TraceEdge[]
  truncated: boolean
}
```

`parent` and `children` are direct edges backed by recorded `parentId` values.
`branchSiblings` are the other children of the same parent and are explicitly
marked as derived adjacency. Nodes and edges report selected/alternate/unknown
branch state and whether they lead toward the materialized leaf.

`related` contains associated tool call/result, compaction or branch-summary
edges, labels, file evidence, and derived cross-session fork edges when present.
Trace nodes contain bounded metadata and previews; `event_read` remains the
content operation.

Transitive traversal should be opt-in and bounded. Every inferred edge is marked as inferred.

### `traceSession`

Return the authorized parent/child session lineage without loading complete transcripts. This can remain an internal capability until a concrete model workflow requires a fourth public tool.

## Public tools

```text
event_search
event_read
event_trace
```

The compact names avoid collision with existing Pi extensions that register
`session_search`. `traceSession` remains internal until a concrete workflow
justifies a fourth public tool.

## Tool result rules

- Search results are bounded and cursor-free at the model boundary.
- Provider cursors remain internal to one tool execution.
- The model can move a fixed-size read window but cannot raise character caps.
- Head/tail truncation always includes exact shown and omitted ranges.
- The current calling event cannot match itself.
- Cross-session results exclude the caller session unless the request explicitly targets it; an invocation cutoff then excludes the caller event and later entries.
- Result ordering is deterministic after relevance ties.
- A missing session and an unauthorized session produce the same public failure.
- Operational details and source paths are logged locally but sanitized at the model boundary.
- A read-only declaration describes product intent, not OS sandboxing.

## Current index policy

The extension builds a disposable workspace-scoped index at startup, then
synchronizes only the current session on hot paths. Startup source bytes and
session count are bounded; partial coverage is explicitly reported to the
caller. The agreed next-milestone replacement is recorded in
[Persistent index lifecycle](index-lifecycle.md); it is not part of the current
implementation.

## Remaining implementation choices

1. **Initial budgets:** continue tuning search-result counts, character caps, and startup coverage from dogfood measurements.

## Current vertical slice

The parser/projector, disposable FTS5 provider, search/read/trace services, and
three Pi tools are implemented and covered by unit and entrypoint registration
tests. The next product step is controlled dogfooding; the next indexing
architecture milestone is the persistent lifecycle specified above.
