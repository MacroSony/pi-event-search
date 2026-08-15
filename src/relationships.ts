import type { EntryRecord, SessionHeader } from './types.ts'
import type { SessionTree } from './tree.ts'

export interface RelationshipRecord {
  sourceSessionId: string
  sourceEntryId: string | null
  targetSessionId: string | null
  targetEntryId: string | null
  /** Non-entry target, currently `file:<path>`. */
  targetRef: string | null
  type: string
  recorded: boolean
  derived?: boolean
  detail?: string
}

export const RELATIONSHIP_TYPES = {
  PARENT: 'parent',
  CHILD: 'child',
  TOOL_RESULT_FOR: 'tool-result-for',
  COMPACTS: 'compacts',
  BRANCH_SUMMARY_FROM: 'branch-summary-from',
  LABELS: 'labels',
  SESSION_PARENT: 'session-parent',
  FILE_READ: 'file-read',
  FILE_CHANGED: 'file-changed',
} as const

export function extractRelationships(
  sessionId: string,
  tree: SessionTree,
): RelationshipRecord[] {
  const records: RelationshipRecord[] = []

  // tool-result-for: match toolCallId from tool.call fragments to tool_result entries.
  const toolCallOwner = new Map<string, string>()
  for (const entry of tree.entries) {
    for (const fragment of entry.fragments) {
      if (fragment.semanticKind === 'tool.call' && fragment.toolCallId !== undefined) {
        toolCallOwner.set(fragment.toolCallId, entry.id)
      }
    }
  }
  for (const entry of tree.entries) {
    for (const fragment of entry.fragments) {
      if (fragment.semanticKind === 'tool.result' && fragment.toolCallId !== undefined) {
        const sourceEntryId = toolCallOwner.get(fragment.toolCallId)
        if (sourceEntryId !== undefined && sourceEntryId !== entry.id) {
          records.push({
            sourceSessionId: sessionId,
            sourceEntryId: entry.id,
            targetSessionId: sessionId,
            targetEntryId: sourceEntryId,
            targetRef: null,
            type: RELATIONSHIP_TYPES.TOOL_RESULT_FOR,
            recorded: true,
            detail: fragment.toolCallId,
          })
        }
      }
    }
  }

  // compacts / branch-summary-from / labels from explicit recorded payload fields.
  for (const entry of tree.entries) {
    if (entry.entryType === 'compaction') {
      const upTo = stringField(entry, 'compactedUpToId') ?? stringField(entry, 'firstKeptEntryId') ?? stringField(entry, 'fromId')
      if (upTo !== null) {
        records.push({
          sourceSessionId: sessionId,
          sourceEntryId: entry.id,
          targetSessionId: sessionId,
          targetEntryId: upTo,
          targetRef: null,
          type: RELATIONSHIP_TYPES.COMPACTS,
          recorded: true,
        })
      }
      const retained = entry['retainedIds']
      if (Array.isArray(retained)) {
        for (const id of retained) {
          if (typeof id !== 'string') continue
          records.push({
            sourceSessionId: sessionId,
            sourceEntryId: entry.id,
            targetSessionId: sessionId,
            targetEntryId: id,
            targetRef: null,
            type: RELATIONSHIP_TYPES.COMPACTS,
            recorded: true,
          })
        }
      }
    }
    if (entry.entryType === 'branch_summary') {
      const fromId = stringField(entry, 'fromId')
      if (fromId !== null) {
        records.push({
          sourceSessionId: sessionId,
          sourceEntryId: entry.id,
          targetSessionId: sessionId,
          targetEntryId: fromId,
          targetRef: null,
          type: RELATIONSHIP_TYPES.BRANCH_SUMMARY_FROM,
          recorded: true,
        })
      }
    }
    if (entry.entryType === 'label') {
      const targetId = stringField(entry, 'targetId')
      if (targetId !== null) {
        records.push({
          sourceSessionId: sessionId,
          sourceEntryId: entry.id,
          targetSessionId: sessionId,
          targetEntryId: targetId,
          targetRef: null,
          type: RELATIONSHIP_TYPES.LABELS,
          recorded: true,
        })
      }
    }
  }

  // File evidence is derived once by the projector and attached to tool.call
  // fragments. Relationship extraction only materializes those inferred edges.
  for (const entry of tree.entries) {
    for (const fragment of entry.fragments) {
      if (fragment.semanticKind !== 'tool.call') continue
      if (fragment.fileEvidenceType === undefined || fragment.filePaths === undefined) continue
      const type = fragment.fileEvidenceType === 'file-read'
        ? RELATIONSHIP_TYPES.FILE_READ
        : RELATIONSHIP_TYPES.FILE_CHANGED
      for (const filePath of fragment.filePaths) {
        records.push({
          sourceSessionId: sessionId,
          sourceEntryId: entry.id,
          targetSessionId: null,
          targetEntryId: null,
          targetRef: `file:${filePath}`,
          type,
          recorded: false,
          derived: true,
          detail: fragment.toolName,
        })
      }
    }
  }

  return records
}

export function extractSessionParentEdge(
  sessionId: string,
  header: SessionHeader,
): RelationshipRecord | null {
  const parent = header.parentSession
  if (typeof parent !== 'string' || parent.length === 0) return null
  return {
    sourceSessionId: sessionId,
    sourceEntryId: null,
    targetSessionId: parent,
    targetEntryId: null,
    targetRef: null,
    type: RELATIONSHIP_TYPES.SESSION_PARENT,
    recorded: true,
  }
}

function stringField(entry: EntryRecord, key: string): string | null {
  const value = entry[key]
  return typeof value === 'string' ? value : null
}
