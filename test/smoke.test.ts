import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSessionText, hashHeader } from '../src/parser.ts'
import { Projector } from '../src/projector.ts'
import { buildSessionTree, branchSuccessor } from '../src/tree.ts'
import { SearchProvider } from '../src/index/provider.ts'

const SESSION = `{"sessionId":"s1","createdAt":"2026-01-01T00:00:00.000Z","cwd":"/tmp/ws"}
{"id":"A","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","type":"user","text":"hello searchable world"}
{"id":"B","parentId":"A","timestamp":"2026-01-01T00:00:02.000Z","type":"assistant","text":"assistant reply","thinking":"secret thought"}
{"id":"C","parentId":"B","timestamp":"2026-01-01T00:00:03.000Z","type":"user","text":"old branch"}
{"id":"D","parentId":"C","timestamp":"2026-01-01T00:00:04.000Z","type":"assistant","text":"old branch answer"}
{"id":"E","parentId":"B","timestamp":"2026-01-01T00:00:05.000Z","type":"user","text":"new branch"}
{"id":"F","parentId":"E","timestamp":"2026-01-01T00:00:06.000Z","type":"assistant","text":"new branch answer"}
`

test('parser/projector/tree/search smoke', () => {
  const parsed = parseSessionText(SESSION)
  assert.equal(parsed.entries.length, 6)
  const projector = new Projector()
  const entryRecords = parsed.entries.map((entry, index) => {
    const projection = projector.project(parsed.header.sessionId, entry)
    return { ...entry, ...projection, id: entry.id, type: entry.type, appendSeq: index, branchState: 'unknown', selectionState: 'unknown', fragments: projection.fragments } as import('../src/types.ts').EntryRecord
  })
  const tree = buildSessionTree('s1', entryRecords)
  assert.deepEqual(tree.selectedPath, ['A', 'B', 'E', 'F'])
  assert.equal(branchSuccessor('B', tree).entryId, 'E')
  assert.equal(branchSuccessor('C', tree).entryId, 'D')

  const provider = new SearchProvider()
  provider.indexSession(parsed, { filePath: '<mem>', size: SESSION.length, mtimeMs: 0, header: parsed.header, entryCount: 6, firstEntryId: 'A', lastEntryId: 'F', entryHashes: [], headerHash: hashHeader(parsed.header) })
  const hits = provider.searchEvents({ query: 'searchable' }, { authRoot: '/tmp/ws' })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].entryId, 'A')
  assert.equal(provider.searchEvents({ query: 'secret' }, { authRoot: '/tmp/ws' }).length, 0)
  provider.close()
})
