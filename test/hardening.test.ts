import test from 'node:test'
import assert from 'node:assert/strict'
import { SearchProvider } from '../src/index/provider.ts'
import { targetEntryId } from './helpers.ts'
import { parseSessionText } from '../src/parser.ts'
import { makeSourceInfo, TREE_SESSION } from './helpers.ts'
import { makeTextPreview } from '../src/snippets.ts'

test('Unicode code-point offsets remain stable for non-ASCII text', () => {
  const text = '😀'.repeat(200) + '中'.repeat(200)
  const preview = makeTextPreview(text, { offset: 100, windowChars: 10 })
  assert.equal(preview.text, '😀'.repeat(10))
  assert.deepEqual(preview.shownRanges, [{ start: 100, end: 110 }])
  assert.equal(preview.truncated, true)

  const preview2 = makeTextPreview('日本語のテキスト', { maxChars: 4 })
  assert.equal(preview2.totalChars, 8)
  assert.equal(preview2.truncated, true)
  assert.deepEqual(preview2.shownRanges, [
    { start: 0, end: 2 },
    { start: 6, end: 8 },
  ])
  assert.deepEqual(preview2.omittedRanges, [{ start: 2, end: 6 }])
})

test('search snippets are bounded and deterministic after relevance ties', () => {
  const parsed = parseSessionText(TREE_SESSION)
  const provider = new SearchProvider()
  provider.indexSession(parsed, makeSourceInfo(parsed))
  const first = provider.searchEvents({ query: 'branch' }, { authRoot: '/tmp/ws' }).map((hit) => hit.entryId)
  const second = provider.searchEvents({ query: 'branch' }, { authRoot: '/tmp/ws' }).map((hit) => hit.entryId)
  assert.deepEqual(first, second)
  for (const hit of provider.searchEvents({ query: 'branch' }, { authRoot: '/tmp/ws' })) {
    assert.ok(hit.snippet.length <= 240)
  }
  provider.close()
})

test('punctuation-only queries return no hits instead of leaking FTS errors', () => {
  const parsed = parseSessionText(TREE_SESSION)
  const provider = new SearchProvider()
  provider.indexSession(parsed, makeSourceInfo(parsed))
  assert.deepEqual(provider.searchEvents({ query: '!!!' }, { authRoot: '/tmp/ws' }), [])
  provider.close()
})

test('readEvent reports an unresolved fork on an alternate branch', () => {
  const text = `{"sessionId":"s1","createdAt":"2026-01-01T00:00:00.000Z","cwd":"/tmp/ws"}
{"id":"A","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","type":"user","text":"root"}
{"id":"B","parentId":"A","timestamp":"2026-01-01T00:00:02.000Z","type":"user","text":"left"}
{"id":"C","parentId":"B","timestamp":"2026-01-01T00:00:03.000Z","type":"user","text":"fork parent"}
{"id":"D","parentId":"C","timestamp":"2026-01-01T00:00:04.000Z","type":"user","text":"fork child 1"}
{"id":"E","parentId":"B","timestamp":"2026-01-01T00:00:05.000Z","type":"user","text":"selected"}
{"id":"G","parentId":"C","timestamp":"2026-01-01T00:00:06.000Z","type":"user","text":"fork child 2"}
{"id":"F","parentId":"E","timestamp":"2026-01-01T00:00:07.000Z","type":"user","text":"leaf"}
`
  const parsed = parseSessionText(text)
  const provider = new SearchProvider()
  provider.indexSession(parsed, makeSourceInfo(parsed))
  const read = provider.readEvent('s1', 'C', { order: 'branch', after: 2 }, '/tmp/ws')
  assert.deepEqual(read.neighbors.forks, [
    {
      kind: 'in-session',
      at: { sessionId: 's1', entryId: 'B' },
      candidates: [{ sessionId: 's1', entryId: 'C' }, { sessionId: 's1', entryId: 'E' }],
      chosen: { sessionId: 's1', entryId: 'C' },
    },
    {
      kind: 'in-session',
      at: { sessionId: 's1', entryId: 'C' },
      candidates: [{ sessionId: 's1', entryId: 'D' }, { sessionId: 's1', entryId: 'G' }],
      chosen: undefined,
    },
  ])
  const trace = provider.traceEvent('s1', 'C', '/tmp/ws')
  assert.deepEqual(trace.children.map((edge) => targetEntryId(edge.to)), ['D', 'G'])
  provider.close()
})

test('an offset at or beyond the end returns an empty exact window', () => {
  const atEnd = makeTextPreview('abc', { offset: 3, windowChars: 2 })
  assert.equal(atEnd.text, '')
  assert.deepEqual(atEnd.shownRanges, [])
  assert.deepEqual(atEnd.omittedRanges, [{ start: 0, end: 3 }])
  assert.equal(atEnd.truncated, true)

  const beyond = makeTextPreview('abc', { offset: 99, windowChars: 2 })
  assert.deepEqual(beyond, atEnd)
})
