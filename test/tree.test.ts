import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSessionText } from '../src/parser.ts'
import { Projector } from '../src/projector.ts'
import { buildSessionTree, branchSuccessor, branchAncestors, branchDescendants, appendNeighbors } from '../src/tree.ts'
import type { EntryRecord } from '../src/types.ts'
import { TREE_SESSION } from './helpers.ts'

function buildTree(text: string) {
  const parsed = parseSessionText(text)
  const projector = new Projector()
  const entries = parsed.entries.map((entry, index) => {
    const projection = projector.project(parsed.header.sessionId, entry)
    return { ...entry, ...projection, id: entry.id, type: entry.type, appendSeq: index, branchState: 'unknown', selectionState: 'unknown', fragments: projection.fragments } as EntryRecord
  })
  return { parsed, tree: buildSessionTree(parsed.header.sessionId, entries) }
}

test('selected path and branch states follow the materialized leaf', () => {
  const { tree } = buildTree(TREE_SESSION)
  assert.deepEqual(tree.selectedPath, ['A', 'B', 'E', 'F'])
  assert.equal(tree.materializedLeafId, 'F')
  assert.equal(tree.byId.get('B')?.branchState, 'selected')
  assert.equal(tree.byId.get('C')?.branchState, 'alternate')
  assert.equal(tree.byId.get('F')?.branchState, 'selected')
})

test('branch successor follows selected path for selected entries', () => {
  const { tree } = buildTree(TREE_SESSION)
  assert.equal(branchSuccessor('B', tree).entryId, 'E')
  assert.equal(branchSuccessor('F', tree).entryId, null)
})

test('branch successor follows sole-child chain on alternate branches', () => {
  const { tree } = buildTree(TREE_SESSION)
  assert.equal(branchSuccessor('C', tree).entryId, 'D')
  assert.equal(branchSuccessor('D', tree).entryId, null)
})

test('branch successor stops at unresolved fork and reports candidates', () => {
  const text = `{"sessionId":"s1","createdAt":"2026-01-01T00:00:00.000Z","cwd":"/tmp/ws"}
{"id":"A","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","type":"user","text":"root"}
{"id":"B","parentId":"A","timestamp":"2026-01-01T00:00:02.000Z","type":"user","text":"left"}
{"id":"C","parentId":"B","timestamp":"2026-01-01T00:00:03.000Z","type":"user","text":"alternate fork parent"}
{"id":"D","parentId":"C","timestamp":"2026-01-01T00:00:04.000Z","type":"user","text":"left fork child"}
{"id":"E","parentId":"B","timestamp":"2026-01-01T00:00:05.000Z","type":"user","text":"selected branch"}
{"id":"G","parentId":"C","timestamp":"2026-01-01T00:00:06.000Z","type":"user","text":"right fork child"}
{"id":"F","parentId":"E","timestamp":"2026-01-01T00:00:07.000Z","type":"user","text":"materialized leaf"}
`
  const { tree } = buildTree(text)
  const selected = branchSuccessor('B', tree)
  assert.equal(selected.entryId, 'E') // selected path follows materialized leaf E
  const fork = branchSuccessor('C', tree)
  assert.equal(fork.entryId, null)
  assert.deepEqual(fork.fork, { atEntryId: 'C', candidateChildIds: ['D', 'G'] })
})

test('branch ancestors are returned in conversational order', () => {
  const { tree } = buildTree(TREE_SESSION)
  assert.deepEqual(branchAncestors('F', tree, 10).map((entry) => entry.id), ['A', 'B', 'E'])
  assert.deepEqual(branchAncestors('E', tree, 10).map((entry) => entry.id), ['A', 'B'])
})

test('branch descendants follow the selected path', () => {
  const { tree } = buildTree(TREE_SESSION)
  assert.deepEqual(branchDescendants('B', tree, 10).entries.map((entry) => entry.id), ['E', 'F'])
})

test('append neighbors use JSONL chronology regardless of branch', () => {
  const { tree } = buildTree(TREE_SESSION)
  const { before, after } = appendNeighbors('E', tree, 2, 2)
  assert.deepEqual(before.map((entry) => entry.id), ['C', 'D'])
  assert.deepEqual(after.map((entry) => entry.id), ['F'])
})

test('compaction makes earlier selected conversation entries summarized', () => {
  const text = `{"sessionId":"s1","createdAt":"2026-01-01T00:00:00.000Z","cwd":"/tmp/ws"}
{"id":"A","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","type":"user","text":"root"}
{"id":"B","parentId":"A","timestamp":"2026-01-01T00:00:02.000Z","type":"assistant","text":"reply"}
{"id":"C","parentId":"B","timestamp":"2026-01-01T00:00:03.000Z","type":"compaction","summary":"summary of A and B"}
{"id":"D","parentId":"C","timestamp":"2026-01-01T00:00:04.000Z","type":"user","text":"after compaction"}
`
  const { tree } = buildTree(text)
  assert.equal(tree.byId.get('A')?.selectionState, 'summarized')
  assert.equal(tree.byId.get('B')?.selectionState, 'summarized')
  assert.equal(tree.byId.get('C')?.selectionState, 'direct') // summary contributes directly
  assert.equal(tree.byId.get('D')?.selectionState, 'direct')
})
