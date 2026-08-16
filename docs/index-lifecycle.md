# Persistent index lifecycle

This document records the agreed next milestone for `pi-event-search`. It is a
handoff specification, not a description of the current implementation. The
current extension still builds a bounded, disposable in-memory index.

## Outcome

The target is a versioned persistent SQLite cache fed by validated JSONL deltas
and owned by a background worker. Normal work should cost approximately the
newly appended bytes plus the affected branch depth, rather than the total
session or total index size.

Persistence, incremental ingestion, and background execution solve different
problems and must be implemented together:

- persistence avoids rebuilding unchanged history after a restart;
- delta ingestion avoids reparsing a complete changed session;
- incremental FTS/tree maintenance avoids hidden full-index work after parsing;
- a worker keeps unavoidable catch-up and rebuild work off Pi's interactive path.

Merely changing `DatabaseSync(':memory:')` to a file, or reading the source as a
stream from byte zero, does not achieve the target.

## Source checkpoint

Each source file has a durable checkpoint containing at least:

```ts
interface SourceCheckpoint {
  sessionId: string
  canonicalPath: string
  device: number
  inode: number
  size: number
  mtimeMs: number
  lastCompleteByteOffset: number
  entryCount: number
  headerHash: string
  boundaryHash: string
  schemaVersion: number
  projectorVersion: number
}
```

The exact fingerprint algorithm is an implementation choice. It must be strong
enough to distinguish a normal append from replacement, truncation, migration,
and an observed rewrite near the previous append boundary without rereading the
whole prefix on every turn.

## Delta decision

For each observed file:

1. Stat and canonicalize the source.
2. Validate file identity, header identity, non-decreasing size, and the stored
   boundary fingerprint.
3. If validation succeeds, seek to `lastCompleteByteOffset` and parse only new,
   newline-terminated JSONL records.
4. Do not advance the checkpoint past an incomplete trailing record.
5. Apply the new records and checkpoint in one transaction.
6. If validation fails, perform a transactional full rebuild while preserving
   the previous last-known-good index until the replacement commits.

Pi normally persists one JSON object plus a newline per append. File rewrites
remain legitimate—for example during format migration—so fallback rebuild is a
normal recovery path rather than an exceptional corruption path.

## Incremental provider contract

The provider should accept deltas rather than a complete reparsed session:

```ts
applySessionDelta(sessionId, newEntries, nextCheckpoint)
rebuildSession(parsedSession, nextCheckpoint)
removeSession(sessionId, observedSourceIdentity)
```

Applying a normal delta must:

- insert only new events and fragments;
- maintain FTS rows with triggers or explicit insert/delete operations, never a
  whole-table FTS `rebuild` command;
- update row-id mappings directly for changed rows;
- add relationships involving the new entries;
- extend the selected path in constant time for a linear append;
- update only the old/new path difference for a branch append; and
- apply compaction state changes with indexed range/path updates rather than a
  source reparse.

## Persistent schema

Use a disposable, versioned database under Pi's agent directory. The initial
recommendation is one user-local index with authorization applied at query time:

```text
~/.pi/agent/pi-event-search/index-v1.sqlite
```

Logical tables:

```text
metadata       schema and projector versions
sources        checkpoints, coverage, and source status
sessions       headers, workspace cwd, names, and lineage
events         entry metadata, tree position, and JSONL byte ranges
fragments      semantic fragments and bounded presentation evidence
fragments_fts  incrementally maintained FTS5 index
relationships recorded and derived edges
```

The database is derived and may be deleted. Schema or projector incompatibility
must select a new version or rebuild transactionally; it must never reinterpret
old rows silently.

Event rows should retain `byteStart` and `byteEnd`. `event_read` can then seek to
the canonical JSONL record instead of retaining complete raw sessions—including
images and private thinking—in the index process.

## Worker lifecycle

A Node worker thread owns parsing and SQLite. The extension communicates with it
through explicit requests:

```text
session_start
  -> open the cached index
  -> enqueue workspace reconciliation

agent_settled
  -> enqueue current-session suffix sync

event_search / event_read / event_trace
  -> synchronize the current session when relevant
  -> query a committed snapshot

background
  -> discover and reconcile historical sessions at lower priority
```

`fs.watch` may wake the reconciler but is never canonical because filesystem
notifications can be missed or coalesced. Pi lifecycle events plus periodic or
startup reconciliation establish durable coverage.

All SQLite access may remain in the worker, avoiding cross-thread connection
sharing. WAL mode and a bounded busy policy support readers and future
cooperative processes. If multiple Pi processes contend materially, introduce a
SQLite-backed writer lease before considering a standalone daemon.

## Query consistency and coverage

The current invoking session is synchronized before a query that could observe
it. Historical catch-up is eventually consistent. Every search response carries
or is accompanied by coverage state:

```text
ready | catching-up | partial | error
indexed/discovered session counts
last successful reconciliation time
bounded error/skipped-source details
```

An incomplete index must never produce an unqualified “no historical match.”
Missing and unauthorized sessions still share the same public failure, and
workspace-root authorization remains mandatory regardless of what the trusted
local cache has indexed.

## Required failure tests

- clean append containing one and several entries
- incomplete trailing JSONL record followed by completion
- truncation and replacement, including the same path and inode
- header/session identity change
- migration or projector-version rebuild
- selected-path append and alternate-branch append
- compaction and relationship deltas
- process interruption before and during transaction commit
- stale, partial, and error coverage receipts
- concurrent writer lease expiry and recovery
- exact read after source modification or deletion
