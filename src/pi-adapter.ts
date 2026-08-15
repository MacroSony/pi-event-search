import type { ParsedSession, RawEntry, SessionHeader } from './types.ts'

/**
 * A minimal view of Pi's ReadonlySessionManager sufficient for indexing the
 * current session from memory instead of re-reading its JSONL file.
 */
export interface SessionManagerLike {
  getHeader?: () => { id?: string; timestamp?: string; cwd?: string; parentSession?: string } | undefined
  getSessionId?: () => string | undefined
  getCwd?: () => string | undefined
  getSessionFile?: () => string | undefined
  getEntries?: () => RawEntry[]
}

export interface AdapterResult {
  parsed: ParsedSession
  sourceFilePath: string
}

/**
 * Build a ParsedSession from Pi's SessionManager entries. The JSONL file stays
 * canonical; this adapter only supports indexing the already-persisted current
 * session when reading the file is not desired.
 */
export function parsedSessionFromSessionManager(sm: SessionManagerLike): AdapterResult | null {
  const entries = sm.getEntries?.() ?? []
  const headerObj = sm.getHeader?.()
  const sessionId = headerObj?.id ?? sm.getSessionId?.() ?? sm.getSessionFile?.()
  const cwd = headerObj?.cwd ?? sm.getCwd?.()
  if (sessionId === undefined || cwd === undefined) return null

  const header: SessionHeader = {
    sessionId,
    createdAt: headerObj?.timestamp ?? new Date(0).toISOString(),
    cwd,
    parentSession: headerObj?.parentSession,
  }
  const normalizedEntries: RawEntry[] = entries.map((entry) => ({
    ...entry,
    id: entry.id,
    parentId: entry.parentId ?? null,
    timestamp: entry.timestamp,
    type: entry.type,
  }))
  return {
    parsed: { header, entries: normalizedEntries },
    sourceFilePath: sm.getSessionFile?.() ?? `<session-manager:${sessionId}>`,
  }
}

export function sourceInfoForParsedSession(
  parsed: ParsedSession,
  filePath: string,
): import('./types.ts').SessionSourceInfo {
  return {
    filePath,
    size: 0,
    mtimeMs: 0,
    header: parsed.header,
    entryCount: parsed.entries.length,
    firstEntryId: parsed.entries[0]?.id ?? null,
    lastEntryId: parsed.entries[parsed.entries.length - 1]?.id ?? null,
    entryHashes: parsed.entries.map((_entry, index) => `adapter-${index}`),
  }
}
