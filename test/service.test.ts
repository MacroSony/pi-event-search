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

test('readEvent and traceEvent accept "current" and enforce the invocation cutoff', () => {
  const svc = service()
  const read = svc.readEvent('current', 'E', { after: 2 }, CURRENT)
  assert.deepEqual(read.neighbors.after, [])
  const appendRead = svc.readEvent('current', 'E', { order: 'append', after: 2 }, CURRENT)
  assert.deepEqual(appendRead.neighbors.after, [])
  assert.throws(
    () => svc.readEvent('current', 'F', {}, CURRENT),
    (err: unknown) => err instanceof PiEventSearchError && err.code === 'NOT_FOUND',
  )

  const trace = svc.traceEvent('current', 'E', CURRENT)
  assert.deepEqual(trace.children, [])
  assert.throws(
    () => svc.traceEvent('current', 'F', CURRENT),
    (err: unknown) => err instanceof PiEventSearchError && err.code === 'NOT_FOUND',
  )

  // The same policy applies when callers use the concrete current session id.
  const concrete = svc.readEvent('s1', 'A', {}, CURRENT)
  assert.equal(concrete.entryId, 'A')
  assert.throws(
    () => svc.traceEvent('s1', 'F', CURRENT),
    (err: unknown) => err instanceof PiEventSearchError && err.code === 'NOT_FOUND',
  )

  assert.equal(read.entryId, 'E')
  assert.equal(trace.target.entryId, 'E')
})

test('traceEvent cutoff hides branch siblings appended at or after invocation', () => {
  const svc = service()
  const invocation = { cwd: '/tmp/ws', currentSessionId: 's1', invocationEntryId: 'E' }
  const trace = svc.traceEvent('current', 'C', invocation)
  assert.deepEqual(trace.branchSiblings, [])
})

test('readEvent rejects fractional bounds and empty fragment ids', () => {
  const svc = service()
  assert.throws(
    () => svc.readEvent('s1', 'A', { offset: 1.5 }, { cwd: '/tmp/ws' }),
    (err: unknown) => err instanceof PiEventSearchError && err.code === 'INVALID_ARGUMENT',
  )
  assert.throws(
    () => svc.readEvent('s1', 'A', { fragmentId: '' }, { cwd: '/tmp/ws' }),
    (err: unknown) => err instanceof PiEventSearchError && err.code === 'INVALID_ARGUMENT',
  )
})
