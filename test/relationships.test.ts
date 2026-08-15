import test from 'node:test'
import assert from 'node:assert/strict'
import { SearchProvider } from '../src/index/provider.ts'
import { parseSessionText } from '../src/parser.ts'
import { makeSourceInfo } from './helpers.ts'

const SESSION = `{"sessionId":"s1","createdAt":"2026-01-01T00:00:00.000Z","cwd":"/tmp/ws"}
{"id":"A","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","type":"user","text":"root"}
{"id":"B","parentId":"A","timestamp":"2026-01-01T00:00:02.000Z","type":"assistant","text":"reading","toolCalls":[{"toolCallId":"tc1","name":"read_file","arguments":{"filePath":"/tmp/ws/foo.txt"}}]}
{"id":"C","parentId":"B","timestamp":"2026-01-01T00:00:03.000Z","type":"branch_summary","summary":"summary of A","fromId":"A"}
{"id":"D","parentId":"C","timestamp":"2026-01-01T00:00:04.000Z","type":"label","targetId":"A","name":"important"}
{"id":"E","parentId":"D","timestamp":"2026-01-01T00:00:05.000Z","type":"compaction","summary":"compacted","compactedUpToId":"A"}
{"id":"F","parentId":"E","timestamp":"2026-01-01T00:00:06.000Z","type":"user","text":"after"}
`

function provider(): SearchProvider {
  const parsed = parseSessionText(SESSION)
  const p = new SearchProvider()
  p.indexSession(parsed, makeSourceInfo(parsed))
  return p
}

test('file evidence edges are derived and marked inferred', () => {
  const p = provider()
  const traceB = p.traceEvent('s1', 'B', '/tmp/ws')
  const fileEdge = traceB.related.find((edge) => edge.type === 'file-read')
  assert.ok(fileEdge)
  assert.equal(fileEdge.recorded, false)
  assert.equal(fileEdge.derived, true)
  assert.ok('fileRef' in fileEdge.to)
  assert.equal((fileEdge.to as { fileRef: string }).fileRef, 'file:/tmp/ws/foo.txt')
  p.close()
})

test('branch-summary-from, labels and compacts edges are recorded', () => {
  const p = provider()
  const traceC = p.traceEvent('s1', 'C', '/tmp/ws')
  assert.equal(traceC.related.find((edge) => edge.type === 'branch-summary-from')?.recorded, true)

  const traceD = p.traceEvent('s1', 'D', '/tmp/ws')
  assert.equal(traceD.related.find((edge) => edge.type === 'labels')?.recorded, true)

  const traceE = p.traceEvent('s1', 'E', '/tmp/ws')
  assert.equal(traceE.related.find((edge) => edge.type === 'compacts')?.recorded, true)
  p.close()
})

test('traceSession returns authorized lineage without transcripts', () => {
  const parent = `{"sessionId":"p1","createdAt":"2026-01-01T00:00:00.000Z","cwd":"/tmp/ws"}
{"id":"A","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","type":"user","text":"parent session"}
`
  const child = `{"sessionId":"c1","createdAt":"2026-01-01T00:00:00.000Z","cwd":"/tmp/ws","parentSession":"p1"}
{"id":"A","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","type":"user","text":"child session"}
`
  const p = new SearchProvider()
  p.indexSession(parseSessionText(parent), makeSourceInfo(parseSessionText(parent)))
  p.indexSession(parseSessionText(child), makeSourceInfo(parseSessionText(child)))
  const lineage = p.traceSession('c1', '/tmp/ws')
  assert.equal(lineage.parentSessionId, 'p1')
  assert.deepEqual(p.traceSession('p1', '/tmp/ws').childSessionIds, ['c1'])
  p.close()
})
