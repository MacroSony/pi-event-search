import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SearchProvider } from '../src/index/provider.ts'
import { IndexMaintainer } from '../src/index/maintainer.ts'

function writeSession(filePath: string, sessionId: string, entries: Array<{ id: string; text: string }>, cwd = '/tmp/ws'): string {
  const lines = [`{"sessionId":"${sessionId}","createdAt":"2026-01-01T00:00:00.000Z","cwd":"${cwd}"}`]
  let parent: string | null = null
  let seconds = 0
  for (const entry of entries) {
    seconds += 1
    lines.push(JSON.stringify({
      id: entry.id,
      parentId: parent,
      timestamp: `2026-01-01T00:00:${String(seconds).padStart(2, '0')}.000Z`,
      type: 'user',
      text: entry.text,
    }))
    parent = entry.id
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n')
  return lines.join('\n') + '\n'
}

test('maintainer indexes, appends, rebuilds and removes sessions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pes-maint-'))
  const file = path.join(dir, 's1.jsonl')
  const provider = new SearchProvider()
  const maintainer = new IndexMaintainer({ provider, discovery: { sessionDirs: [dir] } })

  writeSession(file, 's1', [{ id: 'A', text: 'first entry' }])
  const report1 = maintainer.refresh()
  assert.equal(report1.items.find((item) => item.filePath === file)?.action, 'indexed')
  assert.equal(provider.searchEvents({ query: 'first' }, { authRoot: '/tmp/ws' }).length, 1)

  // Append-only growth should use the append path.
  writeSession(file, 's1', [
    { id: 'A', text: 'first entry' },
    { id: 'B', text: 'second entry' },
  ])
  const report2 = maintainer.refresh()
  assert.equal(report2.items.find((item) => item.filePath === file)?.action, 'appended')
  assert.equal(provider.searchEvents({ query: 'second' }, { authRoot: '/tmp/ws' }).length, 1)

  // Mid-file rewrite should trigger a rebuild.
  writeSession(file, 's1', [
    { id: 'A', text: 'rewritten entry' },
    { id: 'B', text: 'second entry' },
  ])
  const report3 = maintainer.refresh()
  assert.equal(report3.items.find((item) => item.filePath === file)?.action, 'indexed')
  assert.equal(provider.searchEvents({ query: 'rewritten' }, { authRoot: '/tmp/ws' }).length, 1)
  assert.equal(provider.searchEvents({ query: 'first' }, { authRoot: '/tmp/ws' }).length, 0)

  // Removal is observed through the directory listing.
  fs.rmSync(file)
  const report4 = maintainer.refresh()
  assert.deepEqual(report4.removedSessionIds, ['s1'])
  assert.equal(provider.hasSession('s1'), false)

  provider.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('maintainer preserves last known-good index on parse failure', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pes-maint-bad-'))
  const file = path.join(dir, 's1.jsonl')
  const provider = new SearchProvider()
  const maintainer = new IndexMaintainer({ provider, discovery: { sessionDirs: [dir] } })

  writeSession(file, 's1', [{ id: 'A', text: 'good entry' }])
  maintainer.refresh()
  assert.equal(provider.searchEvents({ query: 'good' }, { authRoot: '/tmp/ws' }).length, 1)

  // Corrupt the source with invalid JSONL.
  fs.writeFileSync(file, `{"sessionId":"s1","createdAt":"2026-01-01T00:00:00.000Z","cwd":"/tmp/ws"}\n{broken\n`)
  const report = maintainer.refresh()
  const item = report.items.find((entry) => entry.filePath === file)
  assert.equal(item?.action, 'error')
  // The last known-good index survives.
  assert.equal(provider.hasSession('s1'), true)
  assert.equal(provider.searchEvents({ query: 'good' }, { authRoot: '/tmp/ws' }).length, 1)

  provider.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('maintainer rebuilds when header metadata changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pes-maint-header-'))
  const file = path.join(dir, 's1.jsonl')
  const provider = new SearchProvider()
  const maintainer = new IndexMaintainer({ provider, discovery: { sessionDirs: [dir] } })

  writeSession(file, 's1', [{ id: 'A', text: 'header entry' }])
  maintainer.refresh()
  assert.equal(provider.getSession('s1')?.header.cwd, '/tmp/ws')

  // Same entries, different recorded cwd: this must be a rebuild so
  // authorization metadata is refreshed.
  const lines = [`{"sessionId":"s1","createdAt":"2026-01-01T00:00:00.000Z","cwd":"/tmp/other-ws"}`]
  lines.push(JSON.stringify({ id: 'A', parentId: null, timestamp: '2026-01-01T00:00:01.000Z', type: 'user', text: 'header entry' }))
  fs.writeFileSync(file, lines.join('\n') + '\n')
  const report = maintainer.refresh()
  const item = report.items.find((entry) => entry.filePath === file)
  assert.equal(item?.action, 'indexed')
  assert.equal(provider.getSession('s1')?.header.cwd, '/tmp/other-ws')
  provider.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('maintainer removes the old session when the session id changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pes-maint-id-'))
  const file = path.join(dir, 's1.jsonl')
  const provider = new SearchProvider()
  const maintainer = new IndexMaintainer({ provider, discovery: { sessionDirs: [dir] } })

  writeSession(file, 'old-id', [{ id: 'A', text: 'same entry' }])
  maintainer.refresh()
  assert.equal(provider.hasSession('old-id'), true)

  const lines = [`{"sessionId":"new-id","createdAt":"2026-01-01T00:00:00.000Z","cwd":"/tmp/ws"}`]
  lines.push(JSON.stringify({ id: 'A', parentId: null, timestamp: '2026-01-01T00:00:01.000Z', type: 'user', text: 'same entry' }))
  fs.writeFileSync(file, lines.join('\n') + '\n')
  maintainer.refresh()
  assert.equal(provider.hasSession('old-id'), false)
  assert.equal(provider.hasSession('new-id'), true)
  provider.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('scopedRefresh indexes only sessions authorized for the workspace root', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pes-scoped-'))
  const wsFile = path.join(dir, 'ws.jsonl')
  const otherFile = path.join(dir, 'other.jsonl')
  writeSession(wsFile, 'ws-session', [{ id: 'A', text: 'workspace entry' }], '/tmp/ws')
  writeSession(otherFile, 'other-session', [{ id: 'A', text: 'other entry' }], '/tmp/other')

  const provider = new SearchProvider()
  const maintainer = new IndexMaintainer({ provider, discovery: { sessionDirs: [dir] } })
  maintainer.scopedRefresh('/tmp/ws')
  assert.equal(provider.hasSession('ws-session'), true)
  assert.equal(provider.hasSession('other-session'), false)
  assert.equal(provider.searchEvents({ query: 'workspace' }, { authRoot: '/tmp/ws' }).length, 1)

  // Workspace change drops old indexed sessions and picks up the new root.
  maintainer.scopedRefresh('/tmp/other')
  assert.equal(provider.hasSession('ws-session'), false)
  assert.equal(provider.hasSession('other-session'), true)
  assert.equal(provider.searchEvents({ query: 'other' }, { authRoot: '/tmp/other' }).length, 1)

  provider.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('syncFile stat fast path skips re-parsing unchanged current sessions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pes-fastpath-'))
  const file = path.join(dir, 's1.jsonl')
  writeSession(file, 's1', [{ id: 'A', text: 'good entry' }])
  const provider = new SearchProvider()
  const maintainer = new IndexMaintainer({ provider, discovery: { sessionDirs: [dir] } })

  // Use a whole-second mtime so the fast-path comparison is exact.
  const fixedTime = new Date(1700000000000)
  fs.utimesSync(file, fixedTime, fixedTime)
  maintainer.scopedRefresh('/tmp/ws')
  const before = fs.statSync(file)

  // Corrupt the source but keep size and mtime identical. The fast path must
  // return unchanged without parsing the corrupted body.
  const originalText = fs.readFileSync(file, 'utf8')
  fs.writeFileSync(file, `${originalText.slice(0, -1)}!`)
  fs.utimesSync(file, fixedTime, fixedTime)

  const item = maintainer.syncFile(file)
  assert.equal(item.action, 'unchanged')
  assert.equal(provider.searchEvents({ query: 'good' }, { authRoot: '/tmp/ws' }).length, 1)

  provider.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('maintainer skips a new file that cannot be parsed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pes-maint-newbad-'))
  const file = path.join(dir, 'bad.jsonl')
  fs.writeFileSync(file, '{broken\n')
  const provider = new SearchProvider()
  const maintainer = new IndexMaintainer({ provider, discovery: { sessionDirs: [dir] } })
  const report = maintainer.refresh()
  assert.equal(report.items[0]?.action, 'error')
  assert.equal(provider.sessionsList.length, 0)
  provider.close()
  fs.rmSync(dir, { recursive: true, force: true })
})
