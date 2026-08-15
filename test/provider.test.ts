import test from 'node:test'
import assert from 'node:assert/strict'
import { SearchProvider } from '../src/index/provider.ts'
import { parseSessionText } from '../src/parser.ts'
import { TREE_SESSION, TOOL_SESSION, makeSourceInfo } from './helpers.ts'
import { PiEventSearchError } from '../src/errors.ts'

function providerWith(...texts: string[]): SearchProvider {
  const provider = new SearchProvider()
  for (const text of texts) {
    const parsed = parseSessionText(text)
    provider.indexSession(parsed, makeSourceInfo(parsed))
  }
  return provider
}

test('search returns event hits with provenance', () => {
  const provider = providerWith(TREE_SESSION)
  const hits = provider.searchEvents({ query: 'searchable' }, { authRoot: '/tmp/ws' })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].sessionId, 's1')
  assert.equal(hits[0].entryId, 'A')
  assert.equal(hits[0].semanticKind, 'user.text')
  assert.equal(hits[0].matchingFragmentCount, 1)
  provider.close()
})

test('search phrase matching uses implicit AND for separate terms', () => {
  const provider = providerWith(TREE_SESSION)
  assert.equal(provider.searchEvents({ query: 'searchable world' }, { authRoot: '/tmp/ws' }).length, 1)
  assert.equal(provider.searchEvents({ query: 'searchable absent' }, { authRoot: '/tmp/ws' }).length, 0)
  assert.equal(provider.searchEvents({ query: '"new branch"' }, { authRoot: '/tmp/ws' }).length, 2)
  provider.close()
})

test('private thinking is neither indexed nor returned', () => {
  const provider = providerWith(TREE_SESSION)
  assert.equal(provider.searchEvents({ query: 'secret' }, { authRoot: '/tmp/ws' }).length, 0)
  const read = provider.readEvent('s1', 'B', {}, '/tmp/ws')
  assert.deepEqual(read.fragments.map((fragment) => fragment.semanticKind), ['assistant.text'])
  provider.close()
})

test('multiple matching fragments in one entry coalesce into one hit', () => {
  const provider = providerWith(TOOL_SESSION)
  const hits = provider.searchEvents({ query: 'install' }, { authRoot: '/tmp/ws' })
  const hitB = hits.find((hit) => hit.entryId === 'B')
  assert.ok(hitB)
  assert.equal(hitB.matchingFragmentCount, 2)
  assert.equal(hits.filter((hit) => hit.entryId === 'B').length, 1)
  provider.close()
})

test('metadata filters apply to structured fields', () => {
  const provider = providerWith(TREE_SESSION, TOOL_SESSION)
  assert.deepEqual(
    provider.searchEvents({ query: 'branch', kinds: ['user.text'] }, { authRoot: '/tmp/ws' }).map((hit) => hit.entryId),
    ['C', 'E'],
  )
  assert.deepEqual(
    provider.searchEvents({ query: 'install', roles: ['assistant'] }, { authRoot: '/tmp/ws' }).map((hit) => hit.entryId),
    ['B'],
  )
  assert.deepEqual(
    provider.searchEvents({ query: 'package', toolNames: ['bash'] }, { authRoot: '/tmp/ws' }).map((hit) => hit.entryId).sort(),
    ['B', 'C', 'D'],
  )
  assert.equal(provider.searchEvents({ query: 'file', errorOnly: true }, { authRoot: '/tmp/ws' }).length, 1)
  provider.close()
})

test('time and branch filters are honored', () => {
  const provider = providerWith(TREE_SESSION)
  assert.deepEqual(
    provider.searchEvents({ query: 'branch', time: { from: '2026-01-01T00:00:05.000Z' } }, { authRoot: '/tmp/ws' }).map((hit) => hit.entryId),
    ['E', 'F'],
  )
  assert.deepEqual(
    provider.searchEvents({ query: 'branch', branchStates: ['alternate'] }, { authRoot: '/tmp/ws' }).map((hit) => hit.entryId),
    ['C', 'D'],
  )
  provider.close()
})

test('unauthorized sessions are excluded from cross-session search', () => {
  const provider = providerWith(TREE_SESSION)
  assert.equal(provider.searchEvents({ query: 'searchable' }, { authRoot: '/tmp/other' }).length, 0)
  provider.close()
})

test('missing and unauthorized sessions produce the same public failure', () => {
  const provider = providerWith(TREE_SESSION)
  assert.throws(
    () => provider.searchEvents({ query: 'x', sessionId: 'missing' }, { authRoot: '/tmp/ws' }),
    (err: unknown) => err instanceof PiEventSearchError && (err as PiEventSearchError).code === 'NOT_FOUND',
  )
  assert.throws(
    () => provider.searchEvents({ query: 'x', sessionId: 's1' }, { authRoot: '/tmp/other' }),
    (err: unknown) => err instanceof PiEventSearchError && (err as PiEventSearchError).code === 'NOT_FOUND',
  )
  provider.close()
})

test('current session is excluded unless explicitly targeted', () => {
  const provider = providerWith(TREE_SESSION)
  const execution = { currentSessionId: 's1', invocationEntryId: 'F' }
  assert.equal(provider.searchEvents({ query: 'searchable' }, { authRoot: '/tmp/ws', execution }).length, 0)
  const explicit = provider.searchEvents({ query: 'searchable', sessionId: 's1' }, { authRoot: '/tmp/ws', execution })
  assert.equal(explicit.length, 1)
  assert.equal(explicit[0].entryId, 'A')
  provider.close()
})

test('current session explicit search excludes invocation entry and later entries', () => {
  const provider = providerWith(TREE_SESSION)
  const execution = { currentSessionId: 's1', invocationEntryId: 'E' }
  const hits = provider.searchEvents({ query: 'branch', sessionId: 's1' }, { authRoot: '/tmp/ws', execution })
  assert.deepEqual(hits.map((hit) => hit.entryId), ['C', 'D'])
  provider.close()
})

test('readEvent returns truncation receipts for oversized text', () => {
  const text = `{"sessionId":"s1","createdAt":"2026-01-01T00:00:00.000Z","cwd":"/tmp/ws"}
{"id":"A","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","type":"user","text":"${'x'.repeat(5000)}"}
`
  const provider = providerWith(text)
  const read = provider.readEvent('s1', 'A', {}, '/tmp/ws')
  const preview = read.fragments[0].preview
  assert.equal(preview.totalChars, 5000)
  assert.equal(preview.truncated, true)
  assert.equal(preview.shownRanges.length, 2)
  assert.deepEqual(preview.omittedRanges, [{ start: 1000, end: 4000 }])
  provider.close()
})

test('readEvent offset moves a fixed-size contiguous window', () => {
  const text = `{"sessionId":"s1","createdAt":"2026-01-01T00:00:00.000Z","cwd":"/tmp/ws"}
{"id":"A","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","type":"user","text":"${'abcdefghij'.repeat(500)}"}
`
  const provider = providerWith(text)
  const read = provider.readEvent('s1', 'A', { offset: 100, windowChars: 20 }, '/tmp/ws')
  const preview = read.fragments[0].preview
  assert.equal(preview.text, 'abcdefghij'.repeat(20).slice(0, 20))
  assert.deepEqual(preview.shownRanges, [{ start: 100, end: 120 }])
  assert.equal(preview.truncated, true)
  provider.close()
})

test('readEvent branch order reconstructs conversational context', () => {
  const provider = providerWith(TREE_SESSION)
  const read = provider.readEvent('s1', 'B', { order: 'branch', before: 2, after: 2 }, '/tmp/ws')
  assert.deepEqual(read.neighbors.before.map((neighbor) => neighbor.entryId), ['A'])
  assert.deepEqual(read.neighbors.after.map((neighbor) => neighbor.entryId), ['E', 'F'])
  provider.close()
})

test('readEvent append order uses durable JSONL chronology', () => {
  const provider = providerWith(TREE_SESSION)
  const read = provider.readEvent('s1', 'E', { order: 'append', before: 2, after: 2 }, '/tmp/ws')
  assert.deepEqual(read.neighbors.before.map((neighbor) => neighbor.entryId), ['C', 'D'])
  assert.deepEqual(read.neighbors.after.map((neighbor) => neighbor.entryId), ['F'])
  provider.close()
})

test('traceEvent reports recorded parent/children and derived branch siblings', () => {
  const provider = providerWith(TREE_SESSION)
  const traceE = provider.traceEvent('s1', 'E', '/tmp/ws')
  assert.equal(traceE.parent?.to.entryId, 'B')
  assert.deepEqual(traceE.children.map((edge) => edge.to.entryId), ['F'])
  assert.deepEqual(traceE.branchSiblings.map((edge) => edge.to.entryId), ['C'])
  assert.equal(traceE.branchSiblings[0].derived, true)
  assert.equal(traceE.branchSiblings[0].recorded, false)

  const traceB = provider.traceEvent('s1', 'B', '/tmp/ws')
  assert.deepEqual(traceB.children.map((edge) => edge.to.entryId), ['C', 'E'])
  assert.equal(traceB.parent?.to.entryId, 'A')
  provider.close()
})

test('traceEvent reports tool-result-for relationship', () => {
  const provider = providerWith(TOOL_SESSION)
  const traceC = provider.traceEvent('s2', 'C', '/tmp/ws')
  const toolEdge = traceC.related.find((edge) => edge.type === 'tool-result-for')
  assert.ok(toolEdge)
  assert.equal(toolEdge.to.entryId, 'B')
  assert.equal(toolEdge.recorded, true)
  provider.close()
})
