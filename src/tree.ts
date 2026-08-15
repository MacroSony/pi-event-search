import type {
  BranchState,
  EntryRecord,
  SelectionState,
} from './types.ts'

export interface SessionTree {
  sessionId: string
  entries: EntryRecord[]
  byId: Map<string, EntryRecord>
  childrenByParent: Map<string, string[]>
  /** Root-to-materialized-leaf path, in conversational order. */
  selectedPath: string[]
  selectedSet: Set<string>
  materializedLeafId: string | null
}

export interface BranchSuccessor {
  entryId: string | null
  /** Present when the successor is ambiguous; the caller must report the fork. */
  fork?: { atEntryId: string; candidateChildIds: string[] }
}

/** Build the tree and enrich entries with branch and selection state. */
export function buildSessionTree(sessionId: string, entries: EntryRecord[]): SessionTree {
  const byId = new Map<string, EntryRecord>()
  const childrenByParent = new Map<string, string[]>()
  for (const entry of entries) {
    byId.set(entry.id, entry)
  }
  for (const entry of entries) {
    const key = entry.parentId ?? '__ROOT__'
    const list = childrenByParent.get(key) ?? []
    list.push(entry.id)
    childrenByParent.set(key, list)
  }
  for (const list of childrenByParent.values()) {
    list.sort((a, b) => {
      const ea = byId.get(a)
      const eb = byId.get(b)
      if (ea && eb) return ea.appendSeq - eb.appendSeq
      return a.localeCompare(b)
    })
  }

  const materializedLeafId = entries.length > 0 ? entries[entries.length - 1].id : null
  const selectedSet = new Set<string>()
  const selectedPath: string[] = []
  if (materializedLeafId !== null) {
    const reversePath: string[] = []
    let cursor: string | null = materializedLeafId
    const guard = new Set<string>()
    while (cursor !== null && !guard.has(cursor)) {
      guard.add(cursor)
      const entry = byId.get(cursor)
      if (!entry) break
      reversePath.push(cursor)
      selectedSet.add(cursor)
      cursor = entry.parentId
    }
    selectedPath.push(...reversePath.reverse())
  }

  for (const entry of entries) {
    entry.branchState = classifyBranchState(entry, selectedSet, materializedLeafId)
    entry.selectionState = classifySelectionState(entry, selectedSet, entries)
  }

  return { sessionId, entries, byId, childrenByParent, selectedPath, selectedSet, materializedLeafId }
}

function classifyBranchState(
  entry: EntryRecord,
  selectedSet: Set<string>,
  materializedLeafId: string | null,
): BranchState {
  if (materializedLeafId === null) return 'unknown'
  if (selectedSet.has(entry.id)) return 'selected'
  if (entry.parentId === null && !selectedSet.has(entry.id)) return 'alternate'
  // Entries with a missing/unknown parent chain cannot be classified reliably.
  return 'alternate'
}

function classifySelectionState(
  entry: EntryRecord,
  selectedSet: Set<string>,
  entries: EntryRecord[],
): SelectionState {
  if (!selectedSet.has(entry.id)) return 'not-selected'
  if (entry.contextRole === 'metadata' || entry.contextRole === 'control') return 'not-applicable'
  if (entry.contextRole === 'summary') return 'direct'
  // Conversation entry on the selected path. Summarized if a later compaction
  // on the selected path exists before the materialized leaf.
  for (const other of entries) {
    if (other.appendSeq <= entry.appendSeq) continue
    if (!selectedSet.has(other.id)) continue
    if (other.entryType === 'compaction') return 'summarized'
  }
  return 'direct'
}

export function branchPredecessor(entryId: string, tree: SessionTree): string | null {
  const entry = tree.byId.get(entryId)
  return entry?.parentId ?? null
}

export function branchSuccessor(entryId: string, tree: SessionTree): BranchSuccessor {
  const entry = tree.byId.get(entryId)
  if (!entry) return { entryId: null }

  if (tree.selectedSet.has(entryId)) {
    const index = tree.selectedPath.indexOf(entryId)
    if (index >= 0 && index + 1 < tree.selectedPath.length) {
      return { entryId: tree.selectedPath[index + 1] }
    }
    return { entryId: null }
  }

  const children = tree.childrenByParent.get(entryId) ?? []
  if (children.length === 1) return { entryId: children[0] }
  if (children.length > 1) {
    return {
      entryId: null,
      fork: { atEntryId: entryId, candidateChildIds: children },
    }
  }
  return { entryId: null }
}

export function appendNeighbors(
  entryId: string,
  tree: SessionTree,
  before: number,
  after: number,
): { before: EntryRecord[]; after: EntryRecord[] } {
  const entry = tree.byId.get(entryId)
  if (!entry) return { before: [], after: [] }
  const seq = entry.appendSeq
  const beforeList = tree.entries
    .filter((e) => e.appendSeq < seq)
    .slice(-Math.max(0, before))
  const afterList = tree.entries
    .filter((e) => e.appendSeq > seq)
    .slice(0, Math.max(0, after))
  return { before: beforeList, after: afterList }
}

export function branchAncestors(entryId: string, tree: SessionTree, limit: number): EntryRecord[] {
  const result: EntryRecord[] = []
  let cursor = branchPredecessor(entryId, tree)
  const guard = new Set<string>()
  while (cursor !== null && result.length < limit && !guard.has(cursor)) {
    guard.add(cursor)
    const entry = tree.byId.get(cursor)
    if (!entry) break
    result.push(entry)
    cursor = entry.parentId
  }
  // Conversational order: oldest first, ending with the immediate parent.
  return result.reverse()
}

export function branchDescendants(
  entryId: string,
  tree: SessionTree,
  limit: number,
): { entries: EntryRecord[]; fork?: { atEntryId: string; candidateChildIds: string[] } } {
  const result: EntryRecord[] = []
  let cursor = entryId
  const guard = new Set<string>()
  while (result.length < limit && cursor !== null && !guard.has(cursor)) {
    guard.add(cursor)
    const next = branchSuccessor(cursor, tree)
    if (next.entryId === null) {
      if (next.fork) return { entries: result, fork: next.fork }
      return { entries: result }
    }
    const entry = tree.byId.get(next.entryId)
    if (!entry) return { entries: result }
    result.push(entry)
    cursor = next.entryId
  }
  return { entries: result }
}
