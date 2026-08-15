/**
 * Best-effort file evidence derived from recognized tool calls.
 *
 * These edges are inferred observations, never recorded source facts. The
 * recognition lives in the projector so `tool.call` fragments carry the
 * evidence; relationship extraction does not need a second tool-call parser.
 */

export type FileEvidenceType = 'file-read' | 'file-changed'

const READ_TOOLS = new Set(['read_file', 'open_file', 'list_files', 'read_lints', 'grep', 'search_file', 'search_content', 'read'])
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'create_file', 'delete_file', 'apply_patch', 'write', 'edit'])

export interface FileEvidence {
  type: FileEvidenceType
  paths: string[]
}

export function recognizeFileEvidence(toolName: string, args: unknown): FileEvidence | null {
  let type: FileEvidenceType | null = null
  if (READ_TOOLS.has(toolName)) type = 'file-read'
  else if (WRITE_TOOLS.has(toolName)) type = 'file-changed'
  else return null

  const paths = extractFilePaths(args)
  if (paths.length === 0) return null
  return { type, paths }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function extractFilePaths(args: unknown): string[] {
  const result: string[] = []
  if (typeof args === 'string') {
    if (args.length > 0) result.push(args)
    return result
  }
  if (!isRecord(args)) return result
  for (const key of ['filePath', 'file', 'path', 'to', 'from', 'target', 'target_file']) {
    const value = args[key]
    if (typeof value === 'string' && value.length > 0) result.push(value)
  }
  const files = args['files']
  if (Array.isArray(files)) {
    for (const file of files) {
      if (typeof file === 'string' && file.length > 0) result.push(file)
    }
  }
  return [...new Set(result)]
}
