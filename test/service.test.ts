import test from 'node:test'
import assert from 'node:assert/strict'
import { SearchProvider } from '../src/index/provider.ts'
import { PiEventSearchService, CURRENT_SESSION_ID } from '../src/api/service.ts'
import { parseSessionText } from '../src/parser.ts'
import { TREE_SESSION, makeSourceInfo } from './helpers.ts'
import { PiEventSearchError } from '../src/errors.ts'

function service(): PiEventSearchService {
  const parsed = parseSessionText(TREE_SESSION)
  const provider = new SearchProvider()
  provider.indexSession(parsed, makeSourceInfo(parsed))
  return new PiEventSearchService({ provider, searchLimit: 10 })
}

// TREE_SESSION entries: A(user), B(assistant), C(user), D(assistant),
// E(user), F(assistant). Invoking entry F means the cutoff excludes F only.
const CURRENT = { cwd: '/tmp/ws', currentSessionId: 's1', invocationEntryId: 'F' }

test('CURRENT_SESSION_ID is the "current" alias', () => {
  assert.equal(CURRENT_SESSION_ID, 'current')
})

test('searchEvents resolves "current" to the invoking session and honors the cutoff', () => {
  const svc = service()
  const hits = svc.searchEvents({ query: 'searchable', sessionId: 'current' }, CURRENT)
  assert.deepEqual(hits.map((hit) => hit.entryId), ['A'])
  // "branch" matches C, D, E, F, but F is at/after the cutoff and is excluded.
  const branchHits = svc.searchEvents({ query: 'branch', sessionId: 'current' }, CURRENT)
  assert.deepEqual(branchHits.map((hit) => hit.entryId).sort(), ['C', 'D', 'E'])
})

test('searchEvents "current" without a current session fails clearly', () => {
  const svc = service()
  assert.throws(
    () => svc.searchEvents({ query: 'searchable', sessionId: 'current' }, { cwd: '/tmp/ws' }),
    (err: unknown) => err instanceof PiEventSearchError && err.code === 'INVALID_ARGUMENT',
  )
})

test('readEvent and traceEvent accept "current"', () => {
  const svc = service()
  const invocation = { cwd: '/tmp/ws', currentSessionId: 's1' }
  const read = svc.readEvent('current', 'A', {}, invocation)
  assert.equal(read.entryId, 'A')
  const trace = svc.traceEvent('current', 'E', invocation)
  assert.equal(trace.target.entryId, 'E')
})
