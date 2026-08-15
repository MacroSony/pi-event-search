import test from 'node:test'
import assert from 'node:assert/strict'
import { parsedSessionFromSessionManager, sourceInfoForParsedSession } from '../src/pi-adapter.ts'
import { SearchProvider } from '../src/index/provider.ts'
import type { RawEntry } from '../src/types.ts'

test('adapter builds a ParsedSession from SessionManager entries', () => {
  const entries: RawEntry[] = [
    { type: 'message', id: 'a1', parentId: null, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: 'hello from session manager' } },
    { type: 'message', id: 'a2', parentId: 'a1', timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'assistant answer' }] } },
  ]
  const adapted = parsedSessionFromSessionManager({
    getHeader: () => ({ id: 's1', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp/ws' }),
    getEntries: () => entries,
  })
  assert.ok(adapted)
  assert.equal(adapted.parsed.header.sessionId, 's1')
  assert.equal(adapted.parsed.entries.length, 2)

  const provider = new SearchProvider()
  provider.indexSession(adapted.parsed, sourceInfoForParsedSession(adapted.parsed, '<sm>'))
  const hits = provider.searchEvents({ query: 'session manager' }, { authRoot: '/tmp/ws' })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].entryId, 'a1')
  provider.close()
})

test('adapter returns null when session id or cwd is unavailable', () => {
  assert.equal(parsedSessionFromSessionManager({ getEntries: () => [] }), null)
})
