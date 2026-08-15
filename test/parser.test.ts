import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSessionText, parseLines, decideIncremental } from '../src/parser.ts'
import { SourceParseError } from '../src/errors.ts'

test('parses a valid session with header and entries', () => {
  const parsed = parseSessionText(`{"sessionId":"s1","createdAt":"2026-01-01T00:00:00.000Z","cwd":"/tmp/ws"}
{"id":"A","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","type":"user","text":"hi"}
`)
  assert.equal(parsed.header.sessionId, 's1')
  assert.equal(parsed.entries.length, 1)
  assert.equal(parsed.entries[0].id, 'A')
})

test('skips blank lines but keeps record line numbers', () => {
  const lines = parseLines(`{"sessionId":"s1","createdAt":"2026-01-01T00:00:00.000Z","cwd":"/tmp/ws"}

{"id":"A","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","type":"user","text":"hi"}
`)
  assert.equal(lines.entries.length, 1)
  assert.deepEqual(lines.entryLineNumbers, [3])
})

test('rejects invalid JSONL with a parse error', () => {
  assert.throws(
    () => parseSessionText(`{"sessionId":"s1","createdAt":"2026-01-01T00:00:00.000Z","cwd":"/tmp/ws"}\n{broken\n`),
    (err: unknown) => err instanceof SourceParseError && (err as SourceParseError).line === 2,
  )
})

test('rejects missing header', () => {
  assert.throws(() => parseSessionText(''), SourceParseError)
})

test('rejects entries missing required identity fields', () => {
  assert.throws(
    () => parseSessionText(`{"sessionId":"s1","createdAt":"2026-01-01T00:00:00.000Z","cwd":"/tmp/ws"}
{"parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","type":"user"}
`),
    SourceParseError,
  )
})

test('detects append vs rebuild decisions', () => {
  const text = `{"sessionId":"s1","createdAt":"2026-01-01T00:00:00.000Z","cwd":"/tmp/ws"}
{"id":"A","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","type":"user","text":"hi"}
{"id":"B","parentId":"A","timestamp":"2026-01-01T00:00:02.000Z","type":"user","text":"there"}
`
  const lines = parseLines(text)
  const info = {
    filePath: '<m>', size: text.length, mtimeMs: 0, header: lines.header,
    entryCount: 1, firstEntryId: 'A', lastEntryId: 'A', entryHashes: lines.entryHashes.slice(0, 1),
  }
  const current = {
    filePath: '<m>', size: text.length, mtimeMs: 0, header: lines.header,
    entryCount: 2, firstEntryId: 'A', lastEntryId: 'B', entryHashes: lines.entryHashes,
  }
  assert.equal(decideIncremental(info, current), 'append')

  const truncated = { ...current, entryCount: 1, entryHashes: current.entryHashes.slice(0, 1) }
  assert.equal(decideIncremental(current, truncated), 'rebuild')

  const rewritten = { ...current, entryHashes: ['hash-0', 'different'] }
  assert.equal(decideIncremental(current, rewritten), 'rebuild')
})
