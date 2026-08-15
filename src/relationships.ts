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

const READ_TOOLS = new Set(['read_file', 'open_file', 'list_files', 'read_lints', 'grep'])
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'create_file', 'delete_file', 'apply_patch'])

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

  // file evidence derived from recognized tool calls.
  for (const entry of tree.entries) {
    if (entry.entryType !== 'assistant') continue
    const toolCalls = entry['toolCalls']
    if (!Array.isArray(toolCalls)) continue
    for (const rawCall of toolCalls) {
      if (!isRecord(rawCall)) continue
      const name = typeof rawCall['name'] === 'string' ? rawCall['name'] : ''
      const args = rawCall['arguments']
      const paths = extractFilePaths(args)
      for (const filePath of paths) {
        const type = READ_TOOLS.has(name)
          ? RELATIONSHIP_TYPES.FILE_READ
          : WRITE_TOOLS.has(name)
            ? RELATIONSHIP_TYPES.FILE_CHANGED
            : null
        if (type === null) continue
        records.push({
          sourceSessionId: sessionId,
          sourceEntryId: entry.id,
          targetSessionId: null,
          targetEntryId: null,
          targetRef: `file:${filePath}`,
          type,
          recorded: false,
          derived: true,
          detail: name,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(entry: EntryRecord, key: string): string | null {
  const value = entry[key]
  return typeof value === 'string' ? value : null
}

function extractFilePaths(args: unknown): string[] {
  const result: string[] = []
  if (typeof args === 'string') {
    // A string argument is only treated as a path for single-file operations.
    result.push(args)
    return result
  }
  if (!isRecord(args)) return result
  for (const key of ['filePath', 'file', 'path', 'to', 'from', 'target']) {
    const value = args[key]
    if (typeof value === 'string' && value.length > 0) result.push(value)
  }
  const files = args['files']
  if (Array.isArray(files)) {
    for (const file of files) {
      if (typeof file === 'string') result.push(file)
    }
  }
  return [...new Set(result)]
}
