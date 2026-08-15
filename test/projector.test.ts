import test from 'node:test'
import assert from 'node:assert/strict'
import { Projector, normalizeArguments } from '../src/projector.ts'
import type { RawEntry } from '../src/types.ts'

function entry(id: string, type: string, fields: Record<string, unknown>): RawEntry {
  return { id, parentId: null, timestamp: '2026-01-01T00:00:00.000Z', type, ...fields }
}

test('projects user text', () => {
  const projector = new Projector()
  const result = projector.project('s1', entry('A', 'user', { text: 'hello world' }))
  assert.equal(result.fragments.length, 1)
  assert.equal(result.fragments[0].semanticKind, 'user.text')
  assert.equal(result.role, 'user')
  assert.equal(result.contextRole, 'conversation')
})

test('assistant thinking is never indexed or returned', () => {
  const projector = new Projector()
  const result = projector.project('s1', entry('A', 'assistant', { text: 'visible', thinking: 'private secret' }))
  assert.equal(result.fragments.length, 1)
  assert.equal(result.fragments[0].semanticKind, 'assistant.text')
  assert.equal(result.fragments[0].text, 'visible')
})

test('assistant tool calls become one tool.call fragment each', () => {
  const projector = new Projector()
  const result = projector.project('s1', entry('A', 'assistant', {
    text: 'installing',
    toolCalls: [
      { toolCallId: 'tc1', name: 'bash', arguments: { command: 'npm install' } },
      { toolCallId: 'tc2', name: 'read_file', arguments: { filePath: '/tmp/a.txt' } },
    ],
  }))
  const toolFragments = result.fragments.filter((fragment) => fragment.semanticKind === 'tool.call')
  assert.equal(toolFragments.length, 2)
  assert.equal(toolFragments[0].toolName, 'bash')
  assert.ok(toolFragments[0].text.includes('npm install'))
})

test('tool result captures name, result and error state', () => {
  const projector = new Projector()
  const result = projector.project('s1', entry('A', 'tool_result', {
    toolCallId: 'tc1', name: 'bash', result: 'done', isError: true,
  }))
  assert.equal(result.fragments.length, 1)
  const fragment = result.fragments[0]
  assert.equal(fragment.semanticKind, 'tool.result')
  assert.equal(fragment.isError, true)
  assert.equal(fragment.toolName, 'bash')
  assert.equal(fragment.toolCallId, 'tc1')
})

test('bash entries produce command and bounded output fragments', () => {
  const projector = new Projector()
  const result = projector.project('s1', entry('A', 'bash', { command: 'ls', output: 'file list' }))
  assert.deepEqual(result.fragments.map((fragment) => fragment.semanticKind), ['bash.command', 'bash.output'])
})

test('compaction and branch summary are searchable summaries', () => {
  const projector = new Projector()
  const compaction = projector.project('s1', entry('A', 'compaction', { summary: 'compacted context' }))
  assert.equal(compaction.fragments[0].semanticKind, 'summary.compaction')
  const branch = projector.project('s1', entry('B', 'branch_summary', { summary: 'branch context', fromId: 'X' }))
  assert.equal(branch.fragments[0].semanticKind, 'summary.branch')
})

test('session info name is normalized', () => {
  const projector = new Projector()
  const result = projector.project('s1', entry('A', 'session_info', { name: '  My   Session  ' }))
  assert.equal(result.fragments[0].semanticKind, 'session.name')
  assert.equal(result.fragments[0].text, 'My Session')
})

test('unknown custom entries are not searchable by default', () => {
  const projector = new Projector()
  const result = projector.project('s1', entry('A', 'custom', { customType: 'unknown_type', text: 'secret string' }))
  assert.equal(result.fragments.length, 0)
})

test('allow-listed custom types become searchable', () => {
  const projector = new Projector({ customSearchableTypes: ['model_visible'] })
  const result = projector.project('s1', entry('A', 'custom', { customType: 'model_visible', text: 'visible custom' }))
  assert.equal(result.fragments.length, 1)
  assert.equal(result.fragments[0].semanticKind, 'custom.message')
})

test('metadata and control entries produce typed events without fragments', () => {
  const projector = new Projector()
  for (const type of ['model_change', 'thinking_change', 'label', 'extension_state']) {
    const result = projector.project('s1', entry('A', type, { detail: 'x' }))
    assert.equal(result.fragments.length, 0)
    assert.equal(result.entryType, type)
  }
})

test('normalizeArguments is deterministic and sorted', () => {
  assert.equal(normalizeArguments({ b: 1, a: { d: 2, c: 3 } }), normalizeArguments({ a: { c: 3, d: 2 }, b: 1 }))
})
