# Implementation Plan

Event-oriented cross-session history retrieval for the Pi coding agent.

## Milestones

- **M0 P0+P1+P2** — Project skeleton, core types, JSONL parser, semantic projector.
  - Parse only complete JSONL records; preserve last known-good index on parse failure.
  - Project entries into typed fragments per the semantic projection table.
  - Exclude `assistant.thinking`; unknown custom entries are not searchable.
- **M1 P3** — In-memory SQLite FTS5 provider with programmatic `searchEvents` and `readEvent`.
  - Plain terms + quoted phrases, implicit AND.
  - Structured metadata filters.
  - Fragment ranking -> coalescing to one hit per `(sessionId, entryId)`.
  - Bounded snippets; deterministic ordering.
- **M2 P4** — Tree position, materialized leaf, branch/selection classification, relationships, programmatic `traceEvent`.
  - Append order vs branch order.
  - Branch successor rules (root-to-leaf path, sole child, stop at fork and report candidates).
  - `parent`/`children` recorded; `branchSiblings` derived.
- **M3 P5** — Session discovery and workspace authorization.
  - Explicit root -> git worktree root -> cwd fallback.
  - Path-component boundary comparison; canonicalization.
  - Missing and unauthorized sessions produce the same public failure.
  - Current session excluded by default; invocation cutoff.
- **M4 P6** — Public Pi tool layer `event_search`, `event_read`, `event_trace`.
  - Tool-owned limits; bounded text windows with exact shown/omitted ranges.
- **M5 P7** — Source lifecycle: append detection, incremental fragment insertion,
  transactional rebuild, and removal only after a source is observed gone. The
  current implementation still reparses a changed source and rebuilds derived
  tree/FTS maps; true suffix ingestion moves to M7.
- **M6 P8** — Hardening: fixtures, authorization matrix, Unicode/offset stability, large text, malformed logs, fork traces.
- **M7** — Persistent background incremental index. This is the next milestone;
  its implementation is intentionally separate from the current correctness pass.
  - Replace whole-file append checks with validated byte-offset checkpoints and
    suffix-only JSONL parsing.
  - Apply event, tree, relationship, row-map, and FTS changes incrementally;
    full rebuild remains the safe fallback for rewrites and migrations.
  - Move the disposable database to a versioned, persistent SQLite cache with
    source fingerprints, schema/projector versions, and canonical byte ranges.
  - Put parsing and SQLite ownership in a worker thread so reconciliation does
    not block Pi's interactive path.
  - Synchronize the current session before a query; reconcile historical
    sessions eventually and report `ready | catching-up | partial | error`
    coverage explicitly.
  - Defer a cross-process indexing daemon until concurrent Pi processes prove
    that a worker plus SQLite writer lease is insufficient.

## Architecture

- `src/types.ts` — public types and invariants.
- `src/parser.ts` — session JSONL reader.
- `src/projector.ts` — entry -> typed fragments.
- `src/tree.ts` — branch/append positions, materialized leaf, branch successors.
- `src/relationships.ts` — recorded/inferred edges.
- `src/snippets.ts` — bounded snippets, code-point text windows.
- `src/query.ts` — public query language parsing.
- `src/index/*` — SQLite FTS5 provider.
- `src/auth/*` — discovery and authorization.
- `src/api/*` — programmatic operations and Pi tool layer.
- `docs/index-lifecycle.md` — M7 persistence, delta ingestion, and background-worker design.

## Non-goals for MVP

Embeddings, prompt injection, memory curation, remote indexes, editing/resuming sessions,
searching arbitrary extension state, treating transient hooks as history.
