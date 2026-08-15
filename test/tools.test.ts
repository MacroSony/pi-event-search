import test from 'node:test'
import assert from 'node:assert/strict'
import { SearchProvider } from '../src/index/provider.ts'
import { PiEventSearchService } from '../src/api/service.ts'
import { handleEventSearch, handleEventRead, handleEventTrace } from '../src/tools.ts'
import { parseSessionText } from '../src/parser.ts'
import { TREE_SESSION, makeSourceInfo } from './helpers.ts'

function service() {
  const parsed = parseSessionText(TREE_SESSION)
  const provider = new SearchProvider()
  provider.indexSession(parsed, makeSourceInfo(parsed))
  return { provider, service: new PiEventSearchService({ provider, searchLimit: 10 }) }
}

test('event_search returns bounded hits', () => {
  const { service: svc } = service()
  const response = handleEventSearch(svc, { query: 'branch' }, { cwd: '/tmp/ws' })
  assert.equal(response.ok, true)
  if (response.ok) {
    assert.equal(response.result.length, 4)
    for (const hit of response.result) {
      assert.equal(typeof hit.sessionId, 'string')
      assert.equal(typeof hit.entryId, 'string')
    }
  }
})

test('event_read caps neighbor counts and returns truncation receipts', () => {
  const { service: svc } = service()
  const response = handleEventRead(svc, { sessionId: 's1', entryId: 'B', before: 100, after: 100 }, { cwd: '/tmp/ws' })
  assert.equal(response.ok, true)
  if (response.ok) {
    assert.equal(response.result.neighbors.before.length, 1)
    assert.equal(response.result.neighbors.after.length, 2)
  }
})

test('event_trace returns recorded and derived edges', () => {
  const { service: svc } = service()
  const response = handleEventTrace(svc, { sessionId: 's1', entryId: 'E' }, { cwd: '/tmp/ws' })
  assert.equal(response.ok, true)
  if (response.ok) {
    assert.equal(response.result.parent?.to.entryId, 'B')
    assert.equal(response.result.branchSiblings[0].derived, true)
  }
})

test('tool failures sanitize public errors', () => {
  const { service: svc } = service()
  const response = handleEventSearch(svc, { query: 'x', sessionId: 'missing' }, { cwd: '/tmp/ws' })
  assert.equal(response.ok, false)
  if (!response.ok) {
    assert.equal(response.code, 'NOT_FOUND')
    assert.equal(response.message, 'Session or entry not found.')
  }
})

test('tool layer respects search limit owned by the service', () => {
  const parsed = parseSessionText(TREE_SESSION)
  const provider = new SearchProvider()
  provider.indexSession(parsed, makeSourceInfo(parsed))
  const svc = new PiEventSearchService({ provider, searchLimit: 2 })
  const response = handleEventSearch(svc, { query: 'branch' }, { cwd: '/tmp/ws' })
  assert.equal(response.ok, true)
  if (response.ok) assert.equal(response.result.length, 2)
})
