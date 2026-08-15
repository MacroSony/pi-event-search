import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SearchProvider } from '../src/index/provider.ts'
import { IndexMaintainer } from '../src/index/maintainer.ts'

function writeSession(filePath: string, sessionId: string, entries: Array<{ id: string; text: string }>): string {
  const lines = [`{"sessionId":"${sessionId}","createdAt":"2026-01-01T00:00:00.000Z","cwd":"/tmp/ws"}`]
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
