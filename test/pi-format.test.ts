import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSessionText } from '../src/parser.ts'
import { targetEntryId } from './helpers.ts'
import { Projector } from '../src/projector.ts'
import { SearchProvider } from '../src/index/provider.ts'
import { makeSourceInfo } from './helpers.ts'

const PI_SESSION = `{"type":"session","version":3,"id":"pi-session-1","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp/ws"}
{"type":"message","id":"a1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"hello searchable world"}}
{"type":"message","id":"a2","parentId":"a1","timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"private secret"},{"type":"text","text":"visible answer"},{"type":"toolCall","id":"call_1","name":"bash","arguments":{"command":"npm test"}}]}}
{"type":"message","id":"a3","parentId":"a2","timestamp":"2026-01-01T00:00:03.000Z","message":{"role":"toolResult","toolCallId":"call_1","toolName":"bash","content":[{"type":"text","text":"tests passed"}],"isError":false}}
{"type":"bashExecution","id":"a4","parentId":"a3","timestamp":"2026-01-01T00:00:04.000Z","command":"ls -la","output":"file list","exitCode":0}
{"type":"custom","id":"a5","parentId":"a4","timestamp":"2026-01-01T00:00:05.000Z","customType":"state-ext","data":{"count":42}}
{"type":"custom_message","id":"a6","parentId":"a5","timestamp":"2026-01-01T00:00:06.000Z","customType":"injected","content":"injected context note","display":true}
{"type":"session_info","id":"a7","parentId":"a6","timestamp":"2026-01-01T00:00:07.000Z","name":"My Pi Session"}
{"type":"branch_summary","id":"a8","parentId":"a7","timestamp":"2026-01-01T00:00:08.000Z","fromId":"a2","summary":"branch summary content"}
{"type":"label","id":"a9","parentId":"a8","timestamp":"2026-01-01T00:00:09.000Z","targetId":"a2","label":"checkpoint"}
{"type":"compaction","id":"a10","parentId":"a9","timestamp":"2026-01-01T00:00:10.000Z","summary":"compacted context","firstKeptEntryId":"a3"}
{"type":"thinking_level_change","id":"a11","parentId":"a10","timestamp":"2026-01-01T00:00:11.000Z","thinkingLevel":"high"}
`

test('parses Pi persisted session header vocabulary', () => {
  const parsed = parseSessionText(PI_SESSION)
  assert.equal(parsed.header.sessionId, 'pi-session-1')
  assert.equal(parsed.header.createdAt, '2026-01-01T00:00:00.000Z')
  assert.equal(parsed.entries.length, 11)
})

test('projects Pi message entries into typed fragments', () => {
  const parsed = parseSessionText(PI_SESSION)
  const projector = new Projector()
  const a2 = projector.project(parsed.header.sessionId, parsed.entries[1])
  assert.deepEqual(a2.fragments.map((fragment) => fragment.semanticKind), ['assistant.text', 'tool.call'])
  assert.equal(a2.fragments[0].text, 'visible answer')
  assert.equal(a2.fragments[1].toolCallId, 'call_1')

  const a3 = projector.project(parsed.header.sessionId, parsed.entries[2])
  assert.equal(a3.fragments[0].semanticKind, 'tool.result')
  assert.equal(a3.fragments[0].toolCallId, 'call_1')
})

test('search over Pi sessions excludes thinking and custom state, includes custom_message', () => {
  const parsed = parseSessionText(PI_SESSION)
  const provider = new SearchProvider()
  provider.indexSession(parsed, makeSourceInfo(parsed))
  const root = { authRoot: '/tmp/ws' }
  assert.equal(provider.searchEvents({ query: 'private' }, root).length, 0)
  assert.equal(provider.searchEvents({ query: 'state-ext' }, root).length, 0)
  assert.equal(provider.searchEvents({ query: 'injected' }, root).length, 1)
  assert.equal(provider.searchEvents({ query: 'searchable' }, root).length, 1)
  provider.close()
})

test('file evidence derives from actual Pi message.content tool calls', () => {
  const text = `{"type":"session","version":3,"id":"pi-file","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp/ws"}
{"type":"message","id":"a1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"read the file"}}
{"type":"message","id":"a2","parentId":"a1","timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"reading"},{"type":"toolCall","id":"call_read","name":"read","arguments":{"path":"/tmp/ws/foo.txt"}}]}}
`
  const parsed = parseSessionText(text)
  const provider = new SearchProvider()
  provider.indexSession(parsed, makeSourceInfo(parsed))
  const traceA2 = provider.traceEvent('pi-file', 'a2', '/tmp/ws')
  const fileEdge = traceA2.related.find((edge) => edge.type === 'file-read')
  assert.ok(fileEdge)
  assert.equal(fileEdge.recorded, false)
  assert.equal(fileEdge.derived, true)
  assert.equal('fileRef' in fileEdge.to, true)
  provider.close()
})

test('traceEvent picks up Pi relationship vocabulary', () => {
  const parsed = parseSessionText(PI_SESSION)
  const provider = new SearchProvider()
  provider.indexSession(parsed, makeSourceInfo(parsed))
  const traceA3 = provider.traceEvent(parsed.header.sessionId, 'a3', '/tmp/ws')
  assert.ok(traceA3.related.find((edge) => edge.type === 'tool-result-for'))

  const traceA8 = provider.traceEvent(parsed.header.sessionId, 'a8', '/tmp/ws')
  assert.equal(targetEntryId(traceA8.related.find((edge) => edge.type === 'branch-summary-from')?.to), 'a2')

  const traceA9 = provider.traceEvent(parsed.header.sessionId, 'a9', '/tmp/ws')
  assert.equal(targetEntryId(traceA9.related.find((edge) => edge.type === 'labels')?.to), 'a2')

  const traceA10 = provider.traceEvent(parsed.header.sessionId, 'a10', '/tmp/ws')
  assert.equal(targetEntryId(traceA10.related.find((edge) => edge.type === 'compacts')?.to), 'a3')
  provider.close()
})
