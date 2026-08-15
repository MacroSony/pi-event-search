# pi-event-search

Event-oriented cross-session history retrieval for the Pi coding agent.

`pi-event-search` treats Pi's persisted session entries as durable evidence. It builds a disposable local index of searchable event fragments, returns hits anchored to exact session entries, and lets callers inspect the surrounding branch and relationships when a snippet is not enough.

The MVP public tools are `event_search`, `event_read`, and `event_trace`.
The core search/read/trace engine is implemented and tested; the extension
entrypoint in `extension.ts` registers those tools with the Pi coding agent.

## Why this exists

Most session-search tools answer “which old session mentions this?” They commonly flatten a complete session into one search document or expose event-shaped data internally while returning only a session summary.

This project instead starts from the event:

```text
Pi session JSONL
  -> persisted session entry
  -> one or more semantic fragments
  -> ranked event hit
  -> exact entry read and relationship trace
```

A search result should retain what produced it: the session, entry, fragment kind, time, branch position, and source relationship. Search snippets are discovery aids, never substitutes for the underlying entry.

## Principles

- **Session logs are canonical.** The index is derived and can be deleted and rebuilt.
- **Every hit has provenance.** Search results lead back to a stable `(sessionId, entryId)` source.
- **Events remain typed.** User text, assistant text, tool calls, tool results, compactions, and branch summaries are not flattened into an indistinguishable transcript.
- **Pi's tree matters.** Parentage, alternate branches, compaction, and the selected materialized branch remain queryable facts.
- **Retrieval is bounded and explicit.** Search returns small snippets; exact reads report any presentation truncation.
- **Model access is scoped.** A Pi tool must not silently expose sessions from unrelated workspaces.
- **Private reasoning is excluded from the MVP.** Raw sessions remain untouched, but thinking content is neither indexed nor returned.
- **Memory is a separate concern.** This project retrieves historical evidence; it does not extract durable facts, rewrite history, or decide what a user should remember.

## Design documents

- [Core concepts](docs/concepts.md)
- [Tool design](docs/tool-design.md)

## Implementation status

- `src/parser.ts` — JSONL parser for fixture and Pi persisted session formats; header-only reader for scoped discovery.
- `src/projector.ts` — typed semantic projection; private thinking excluded.
- `src/tree.ts` — append/branch order, materialized leaf, fork rules.
- `src/relationships.ts` — recorded/inferred relationship extraction.
- `src/index/provider.ts` — in-memory SQLite FTS5 search/read/trace provider.
- `src/index/maintainer.ts` — incremental append/rebuild/removal lifecycle; scoped root refresh plus hot-path stat fast path.
- `src/auth/*` — session discovery and workspace-root authorization.
- `src/api/service.ts`, `src/tools.ts` — bounded public tool layer.
- `src/pi-adapter.ts` — indexes the current session from Pi's SessionManager.
- `extension.ts` — Pi extension entrypoint (`pi -e ./extension.ts`). Full scoped discovery runs only at startup/workspace change; turns and tools sync only the current session file.

Run the test suite and typecheck:

```bash
npm install
npm run check
```

`npm run check` runs `tsc --noEmit` plus the full `node --test` suite.

## Initial boundary

The first useful version should provide lexical, event-level search and bounded
source reads over local Pi JSONL sessions. It uses an automatically resolved Git
worktree root (falling back to the current working directory) as its default
authorization scope, with explicit root overrides for unusual layouts.

Embeddings, automatic recall injection, memory consolidation, session grouping,
reasoning retrieval, and custom-event extractor registries can be considered
after the event model and authorization boundary are proven.
