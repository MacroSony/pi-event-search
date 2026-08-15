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

The Pi tool should own the result limit and provider pagination. A model-controlled unbounded limit is not part of the first contract.

Each result contains at least:

```ts
interface EventSearchHit {
  sessionId: string
  sessionName?: string
  cwd: string
  entryId: string
  entryType: string
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
`semanticKind` and `snippet`. Other matching fragments may be named in bounded
metadata, but they do not produce duplicate event results.

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
reports the chosen child and any alternate child ids at each encountered fork.

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

Instead of a special “jump to middle” operation, `event_read` accepts an
optional character offset for a fixed-size contiguous window. This lets the
caller inspect the middle—or any other omitted range—without allowing it to
raise the output cap. Offsets and ranges use Unicode code points, not UTF-16
code units, so they remain stable for non-ASCII text.

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
edges, labels, and file evidence when present. Trace nodes contain bounded
metadata and previews; `event_read` remains the content operation.

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

## Remaining implementation choices

1. **Index placement and refresh:** one global derived index with authorization at query time is the current recommendation; startup and post-turn incremental refresh still need concrete triggers.
2. **Initial budgets:** exact search-result counts and character caps should be chosen as dogfood defaults and made locally configurable.

## Recommended first vertical slice

Implement one parser/projector over test fixture sessions, one disposable in-memory FTS5 provider, and two programmatic operations: `searchEvents` and `readEvent`. Do not register Pi tools until their authorization behavior and source fidelity are covered by tests.
