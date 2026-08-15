import fs from 'node:fs'
import { SourceParseError } from './errors.ts'
import type { ParsedSession, RawEntry, SessionHeader, SessionSourceInfo } from './types.ts'

export interface ParsedLines {
  header: SessionHeader
  entries: RawEntry[]
  entryLineNumbers: number[]
  entryHashes: string[]
}

export function fnv1a(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

export function parseSessionText(text: string, filePath = '<memory>'): ParsedSession {
  const parsed = parseLines(text, filePath)
  return { header: parsed.header, entries: parsed.entries }
}

const HEADER_READ_BLOCK_SIZE = 64 * 1024

/**
 * Read only the first JSONL record of a session file and parse it as the
 * session header. This keeps scoped discovery from reading full session
 * bodies (which can be hundreds of MB across a workspace history).
 *
 * The first non-empty line is treated as the header. If no parseable header
 * fits in the initial read block the file is reported as a source error.
 */
export function readSessionHeader(filePath: string): SessionHeader {
  let fd: number
  try {
    fd = fs.openSync(filePath, 'r')
  } catch (err) {
    throw new SourceParseError(`${filePath}: cannot open file: ${(err as Error).message}`)
  }
  try {
    const buffer = Buffer.alloc(HEADER_READ_BLOCK_SIZE)
    const bytesRead = fs.readSync(fd, buffer, 0, HEADER_READ_BLOCK_SIZE, 0)
    const text = buffer.toString('utf8', 0, bytesRead)
    const rawLines = text.split(/\r?\n/)
    let lineNumber = 0
    for (const raw of rawLines) {
      lineNumber += 1
      if (raw.trim() === '') continue
      let value: unknown
      try {
        value = JSON.parse(raw)
      } catch (err) {
        throw new SourceParseError(
          `${filePath}:${lineNumber}: invalid JSONL header record: ${(err as Error).message}`,
          lineNumber,
        )
      }
      if (!isRecord(value)) {
        throw new SourceParseError(`${filePath}:${lineNumber}: header record is not a JSON object`, lineNumber)
      }
      return parseHeader(value, filePath, lineNumber)
    }
    throw new SourceParseError(`${filePath}: session header not found in the first ${HEADER_READ_BLOCK_SIZE} bytes`)
  } finally {
    fs.closeSync(fd)
  }
}

export function parseLines(text: string, filePath = '<memory>'): ParsedLines {
  const rawLines = text.split(/\r?\n/)
  const entries: RawEntry[] = []
  const entryLineNumbers: number[] = []
  const entryHashes: string[] = []
  let header: SessionHeader | null = null
  let sawHeader = false

  for (let i = 0; i < rawLines.length; i += 1) {
    const raw = rawLines[i]
    if (raw.trim() === '') continue
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch (err) {
      throw new SourceParseError(
        `${filePath}:${i + 1}: invalid JSONL record: ${(err as Error).message}`,
        i + 1,
      )
    }
    if (!isRecord(value)) {
      throw new SourceParseError(`${filePath}:${i + 1}: record is not a JSON object`, i + 1)
    }
    if (!sawHeader) {
      header = parseHeader(value, filePath, i + 1)
      sawHeader = true
      continue
    }
    const entry = parseEntry(value, filePath, i + 1)
    entries.push(entry)
    entryLineNumbers.push(i + 1)
    entryHashes.push(fnv1a(raw))
  }

  if (!sawHeader || header === null) {
    throw new SourceParseError(`${filePath}: session header is missing`)
  }

  const seenIds = new Set<string>()
  for (let i = 0; i < entries.length; i += 1) {
    const entryId = entries[i].id
    if (seenIds.has(entryId)) {
      throw new SourceParseError(`${filePath}:${entryLineNumbers[i]}: duplicate entry id '${entryId}'`, entryLineNumbers[i])
    }
    seenIds.add(entryId)
  }

  return { header, entries, entryLineNumbers, entryHashes }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseHeader(value: Record<string, unknown>, filePath: string, line: number): SessionHeader {
  // Accept both the project fixture vocabulary (sessionId/createdAt) and
  // Pi's persisted session header vocabulary (id/timestamp).
  const sessionId = stringValue(value['sessionId']) ?? stringValue(value['id'])
  const createdAt = stringValue(value['createdAt']) ?? stringValue(value['timestamp'])
  const cwd = stringValue(value['cwd'])
  const parentSession = stringValue(value['parentSession'])
  if (sessionId === null) {
    throw new SourceParseError(`${filePath}:${line}: header.sessionId must be a non-empty string`, line)
  }
  if (createdAt === null) {
    throw new SourceParseError(`${filePath}:${line}: header.createdAt must be a string`, line)
  }
  if (cwd === null) {
    throw new SourceParseError(`${filePath}:${line}: header.cwd must be a non-empty string`, line)
  }
  return {
    sessionId,
    createdAt,
    cwd,
    parentSession: parentSession ?? undefined,
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function parseEntry(value: Record<string, unknown>, filePath: string, line: number): RawEntry {
  const id = value['id']
  const timestamp = value['timestamp']
  const type = value['type']
  if (typeof id !== 'string' || id.length === 0) {
    throw new SourceParseError(`${filePath}:${line}: entry.id must be a non-empty string`, line)
  }
  if (typeof timestamp !== 'string') {
    throw new SourceParseError(`${filePath}:${line}: entry.timestamp must be a string`, line)
  }
  if (typeof type !== 'string' || type.length === 0) {
    throw new SourceParseError(`${filePath}:${line}: entry.type must be a non-empty string`, line)
  }
  const rawParent = value['parentId']
  if (rawParent !== undefined && rawParent !== null && typeof rawParent !== 'string') {
    throw new SourceParseError(`${filePath}:${line}: entry.parentId must be a string or null`, line)
  }
  const entry: RawEntry = { ...value, id, timestamp, type, parentId: (rawParent as string | null) ?? null }
  return entry
}

export function sourceInfoFromLines(
  filePath: string,
  size: number,
  mtimeMs: number,
  parsed: ParsedLines,
): SessionSourceInfo {
  return {
    filePath,
    size,
    mtimeMs,
    header: parsed.header,
    entryCount: parsed.entries.length,
    firstEntryId: parsed.entries[0]?.id ?? null,
    lastEntryId: parsed.entries[parsed.entries.length - 1]?.id ?? null,
    entryHashes: parsed.entryHashes,
    headerHash: hashHeader(parsed.header),
  }
}

export function hashHeader(header: SessionHeader): string {
  const canonical = {
    sessionId: header.sessionId,
    createdAt: header.createdAt,
    cwd: header.cwd,
    parentSession: header.parentSession ?? null,
  }
  return fnv1a(JSON.stringify(canonical))
}

export type IncrementalDecision = 'same' | 'append' | 'rebuild'

/**
 * Compare a new source observation to the previous indexed observation.
 *
 * - truncation (fewer entries) forces rebuild
 * - first N entries changed (hash mismatch) forces rebuild
 * - first N entries unchanged and more entries exist -> append
 * - equal -> same
 */
export function decideIncremental(
  previous: SessionSourceInfo,
  current: SessionSourceInfo,
): IncrementalDecision {
  if (previous.headerHash !== current.headerHash) return 'rebuild'
  if (current.entryCount < previous.entryCount) return 'rebuild'
  if (previous.entryCount === 0) {
    return current.entryCount === 0 ? 'same' : 'rebuild'
  }
  const prevHashes = previous.entryHashes
  const currHashes = current.entryHashes
  for (let i = 0; i < previous.entryCount; i += 1) {
    if (currHashes[i] !== prevHashes[i]) return 'rebuild'
  }
  if (current.entryCount > previous.entryCount) return 'append'
  return 'same'
}
