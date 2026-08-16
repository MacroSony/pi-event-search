# Core concepts

This document defines the project vocabulary and the invariants that should remain independent of a particular SQLite schema or Pi tool API.

## Purpose

`pi-event-search` is a local, read-only retrieval layer over persisted Pi history. Its primary answer is an event hit with provenance. Session grouping is a presentation option, not the storage or ranking unit.

The project is an episodic-history system: it helps an agent find what happened. It is not a semantic-memory system that maintains a curated set of facts or preferences.

## Source model

### Session

A session is one Pi JSONL file and its header. The header supplies the session id, creation time, working directory, and optional parent-session path.

### Entry

An entry is one persisted Pi `SessionEntry` node. It has a stable `id`, a `parentId`, a timestamp, and a discriminated entry type. Entries form an append-only tree rather than a single active transcript.

The source identity of an entry is the pair:

```text
(sessionId, entryId)
```

Line numbers and SQLite row ids are observations of a particular representation and must not become public identity.

Pi may implement `--fork` by copying a prefix of entries into a new session.
Those copied entries retain their entry ids, so entry ids are never globally
unique. Cross-session fork anchors and continuations must always use the full
`(sessionId, entryId)` identity. The child header's recorded `parentSession`
reference establishes lineage; the exact entry-level fork is derived from the
shared prefix only when both sessions are indexed and authorized.

### Event

An event is the normalized, typed interpretation of one entry. The event retains the complete source identity and raw entry type.

“Event” is the public retrieval concept. It must not mean a transient Pi extension callback. Hooks such as `message_end` or `agent_settled` can trigger indexing, but the persisted JSONL entry remains canonical.

For the MVP, one public event always corresponds to exactly one persisted entry.
Semantic parts inside it are fragments, not independent public events. This
keeps source identity stable while still allowing a particular tool call or text
block to supply the matching evidence.

### Fragment

A fragment is one searchable semantic part of an event. One entry may produce zero, one, or several fragments.

For example, one assistant message entry can contain visible text, private thinking, and several tool-call blocks. Those parts need separate kinds and ranking behavior, but every fragment still resolves to the same source event.

A fragment identity is local to its event. Its exact encoding remains an implementation detail, but it must be deterministic for unchanged source content.

The strongest matching fragment id is public search evidence. It lets
`event_read` address a bounded window inside one particular text or tool-call
fragment without changing the event-level result identity.

### Hit

A fragment is the internal ranking unit, while an event is the public result
unit. If several fragments from one event match, they are coalesced into one hit
using the strongest fragment as evidence. A hit contains a bounded snippet,
never an invented summary. Reading or tracing the event is a separate operation.

## Canonical and derived data

Pi's session files are the only canonical history. The search database is a disposable read model containing extracted text, metadata, relationships, and source fingerprints.

The indexer must therefore:

1. Parse only complete JSONL records.
2. Preserve the last known-good index if a changed source cannot be parsed safely.
3. Detect append-only growth and ingest only the durable suffix when possible.
4. Detect rewrites, truncation, migration, or replacement and rebuild that session transactionally.
5. Remove indexed sessions only after the source observation establishes that they are gone.
6. Store no image bytes, attachment bodies, or other non-searchable payloads in the derived index.

Exact reads should return to the source file rather than treating indexed snippets as canonical event content.

## Semantic projection

The first-party projector should recognize these semantic kinds:

| Semantic kind | Pi source | Searchable text |
|---|---|---|
| `user.text` | user message | visible text blocks |
| `assistant.text` | assistant message | visible answer text |
| `assistant.thinking` | assistant message | excluded from the MVP |
| `tool.call` | assistant tool-call block | tool name and normalized arguments |
| `tool.result` | tool-result message | tool name, visible result text, and error state |
| `bash.command` | Pi `message.role = bashExecution` (plus legacy shapes) | command text |
| `bash.output` | Pi `message.role = bashExecution` (plus legacy shapes) | bounded output text |
| `summary.compaction` | compaction entry | summary text |
| `summary.branch` | branch-summary entry | summary text |
| `custom.message` | model-visible custom message | visible text and custom type |
| `session.name` | session-info entry | normalized session name |

Model changes, thinking-level changes, labels, and extension state are typed events even when they contribute no default full-text fragment. They remain available to metadata filters and relationship tracing where applicable.

Unknown custom entries must not become searchable merely because their payload contains strings. A future extractor registry can opt specific custom types into semantic projection.

## Order and tree position

Each entry has two useful positions:

- **Append order**: its durable order in the JSONL log.
- **Tree position**: its `parentId` relationship within the session.

These are not interchangeable. “Before” and “after” must therefore name whether they mean append neighbors or selected-branch neighbors.

For example, suppose a user rewinds at `B` and creates a new branch:

```text
A -> B -> C -> D     old branch
      \
       E -> F        later materialized branch

append order: A, B, C, D, E, F
```

For `E`, the previous append neighbor is `D`, even though `D` belongs to the old
branch and was never conversational context for `E`. Its previous branch
neighbor is `B`, its parent. Append order answers “what was written immediately
before or after this record?” Branch order answers “what conversation led to
this event?”

Branch predecessors are unambiguous because they follow `parentId` toward the
root. Branch successors use these rules:

1. If the target is on the root-to-materialized-leaf path, follow the child on
   that path.
2. Otherwise, follow a child only while there is exactly one child.
3. At an unresolved fork, stop and report every candidate child id rather than
   silently selecting a branch.

Thus reading `C` in the example can continue to `D`, while reading `B` follows
the materialized `E -> F` branch and reports `C` as an alternative. A branch
read does not insert the contents of `C` into that linear context;
`event_trace` exposes the fork explicitly.

### Materialized leaf

Pi does not persist a separate current-leaf pointer in the session header. For a cold session, the last appended entry is the last materialized leaf, but a branch selection followed by no append can remain process-local.

The index must call this a **materialized leaf**, not an unquestionably current leaf. A later version may append a private selection marker on `session_tree`, but doing so mutates user sessions and needs an explicit decision.

### Branch and context classification

DSH's `current | shadowed | log-only` surface cannot be copied directly because Pi stores a tree. The initial model keeps separate facts:

- `branchState`: `selected | alternate | unknown`
- `contextRole`: `conversation | summary | control | metadata`
- `selectionState`: `direct | summarized | not-selected | not-applicable | unknown`

`selected` means the entry is on the root-to-materialized-leaf path. `direct` means it contributes directly to the selected, compaction-aware model context. `summarized` means its information is represented through a compaction or branch summary instead. `not-applicable` covers metadata/control entries that never directly become model messages.

These classifications are derived observations. Search results should report `unknown` rather than guess when an old or malformed session lacks enough information.

## Relationships

Relationships are typed edges between source identities. The initial relationship vocabulary is:

| Relationship | Source |
|---|---|
| `parent` / `child` | entry `parentId` |
| `tool-result-for` | matching `toolCallId` |
| `compacts` | compaction boundary and retained context |
| `branch-summary-from` | branch-summary `fromId` |
| `labels` | label `targetId` |
| `session-parent` | session header `parentSession` |
| `file-read` / `file-changed` | recognized tool calls and summary details |

An event trace should distinguish direct recorded relationships from inferred relationships. Inference must be labeled and should never overwrite source facts.

The default local branch trace includes:

- the target's direct parent, when present;
- all immediate children of the target;
- the target's branch siblings: the other children of its parent; and
- which adjacent node, if any, lies toward the materialized leaf.

Parent and child edges come directly from recorded `parentId` values. A sibling
edge is derived adjacency—two events share a parent—so it is labeled `derived`
rather than presented as a recorded relationship. For example, tracing `E` in
the tree above returns parent `B`, child `F`, and branch sibling `C`. Tracing
`B` returns both child branches, `C` and `E`.

Trace results contain bounded node metadata and small previews, not the full
contents of every adjacent event. The caller uses `event_read` on a returned id
when a branch neighbor is actually relevant.

## Search corpus and authorization

The trusted local service may index all discoverable Pi sessions. A model-facing Pi tool must apply authorization before returning hits or exact content.

Pi storing its logs under `~/.pi` determines where sessions are discovered; it
does not determine which sessions a tool may reveal. Each session header records
the working directory in which that session was created.

The MVP resolves an authorization root for the caller as follows:

1. Use an explicitly configured absolute workspace root when present.
2. Otherwise use the current Git worktree root.
3. Fall back to the caller's normalized current working directory outside Git.

A target session is authorized when its recorded, normalized `cwd` equals that
root or is a descendant of it on a path-component boundary. Existing paths
should be canonicalized before comparison. Multiple roots, monorepo subscopes,
and linked worktrees can be represented by explicit configuration rather than
by fuzzy path matching.

The current session is excluded by default. An explicit `sessionId` may target
it, but only events durably preceding the invocation cutoff are eligible. The
event containing the invoking tool call and anything appended later are
excluded, preventing self-matches and observation of future results.

Session discovery covers Pi's effective session directory plus explicitly
configured additional or archive directories. Discovery never grants access:
every discovered session still passes the workspace-root authorization rule.

## Retrieval and ranking

The first provider should use SQLite FTS5 plus metadata filters. Lexical retrieval is sufficient to validate event boundaries, provenance, filters, snippets, incremental indexing, and authorization without introducing embedding lifecycle concerns.

The MVP query language accepts plain terms and quoted phrases. Separate terms
have implicit AND semantics. Raw FTS operators and field syntax are not exposed;
event types, roles, tools, time, and other constraints use structured filters.

Cross-session search ranks fragments, then coalesces matching fragments with the
same `(sessionId, entryId)` into one event result. Session grouping is deferred;
when introduced, it must not change the underlying event identity and should
expose the strongest event rather than only a generated session summary.

Useful metadata filters include:

- session id and cwd
- event and semantic kind
- role and tool name
- time range
- error state
- branch and selection state
- file evidence

Semantic embeddings remain a provider-level extension. If added, they should target event or turn-sized windows and still resolve to exact source events.

## Presentation and fidelity

Search snippets are bounded plain text. They may normalize whitespace and mark matching spans, but they must not silently paraphrase source content.

Oversized indexed fragments preserve bounded head and tail evidence so final
errors and status lines remain searchable. A visible omission marker separates
the two ranges and prevents phrase matching across content that was not adjacent
in the source.

Exact reads distinguish source fidelity from transport size:

- The event identity and metadata are always exact.
- Omitted or truncated payload fields are reported explicitly.
- Large content may be exposed through a bounded preview and a local source locator.
- Private reasoning, image data, and provider-private metadata are excluded from the MVP.

## Non-goals for the first version

- Curated fact or preference memory
- Automatic prompt injection
- LLM-generated session summaries for indexing
- Vector embeddings or reranking
- Remote/cloud indexes
- Cross-machine synchronization
- Editing, deleting, compacting, or resuming sessions
- Searching arbitrary strings inside unknown extension state
- Treating transient Pi hooks as an independent durable history
