import fs from 'node:fs'
import { discoverSessionFiles, type DiscoveryConfig } from '../auth/discovery.ts'
import { isPathWithin, normalizePath } from '../auth/paths.ts'
import { decideIncremental, parseLines, readSessionHeader, sourceInfoFromLines } from '../parser.ts'
import type { ParsedSession, SessionHeader, SessionSourceInfo } from '../types.ts'
import type { SearchProvider } from './provider.ts'

export interface MaintainerConfig {
  provider: SearchProvider
  discovery?: DiscoveryConfig
  /** Maximum source bytes parsed by one scoped refresh. Unlimited by default. */
  maxScopedSourceBytes?: number
  /** Maximum session files parsed by one scoped refresh. Unlimited by default. */
  maxScopedFiles?: number
}

export interface SyncItem {
  filePath: string
  action: 'indexed' | 'appended' | 'unchanged' | 'removed' | 'error'
  sessionId?: string
  error?: string
}

export interface SyncReport {
  items: SyncItem[]
  removedSessionIds: string[]
  coverage?: ScopedRefreshCoverage
}

export interface ScopedRefreshCoverage {
  authorizedFiles: number
  authorizedBytes: number
  selectedFiles: number
  selectedBytes: number
  skippedFiles: number
  skippedBytes: number
  limited: boolean
}

export class IndexMaintainer {
  readonly provider: SearchProvider
  private readonly discoveryConfig: DiscoveryConfig
  private readonly maxScopedSourceBytes: number
  private readonly maxScopedFiles: number
  private readonly fileToSession = new Map<string, string>()

  constructor(config: MaintainerConfig) {
    this.provider = config.provider
    this.discoveryConfig = config.discovery ?? {}
    this.maxScopedSourceBytes = normalizeLimit(config.maxScopedSourceBytes)
    this.maxScopedFiles = normalizeLimit(config.maxScopedFiles)
    this.rebuildFileMap()
  }

  private rebuildFileMap(): void {
    this.fileToSession.clear()
    for (const session of this.provider.sessionsList) {
      this.fileToSession.set(session.sourceInfo.filePath, session.header.sessionId)
    }
  }

  refresh(): SyncReport {
    const files = discoverSessionFiles(this.discoveryConfig)
    const report: SyncReport = { items: [], removedSessionIds: [] }

    for (const filePath of files) {
      report.items.push(this.syncFile(filePath))
    }

    // Remove indexed sessions only after a source observation (the directory
    // listing) established that they are gone.
    const observed = new Set(files.map(canonicalIfExists))
    const toRemove: string[] = []
    for (const session of this.provider.sessionsList) {
      const comparable = canonicalIfExists(session.sourceInfo.filePath)
      if (!observed.has(comparable)) toRemove.push(session.header.sessionId)
    }
    for (const sessionId of toRemove) {
      this.provider.removeSession(sessionId)
      this.rebuildFileMap()
      report.removedSessionIds.push(sessionId)
      report.items.push({ filePath: sessionId, action: 'removed', sessionId })
    }

    this.rebuildFileMap()
    return report
  }

  /**
   * Full scoped discovery for a resolved workspace root.
   *
   * Session files are first filtered by header-only inspection: only headers
   * whose recorded cwd is inside `root` are parsed and indexed. Sessions that
   * are already indexed but are not part of the authorized set are removed.
   *
   * This is intended to run at startup or after a workspace change, not on
   * every turn or tool call.
   */
  scopedRefresh(root: string): SyncReport {
    const normalizedRoot = normalizePath(root)
    const files = discoverSessionFiles(this.discoveryConfig)
    const report: SyncReport = { items: [], removedSessionIds: [] }
    const authorizedFiles: Array<{ filePath: string; size: number; mtimeMs: number }> = []
    const uncertainFiles = new Set<string>()

    for (const filePath of files) {
      let header: SessionHeader
      let stat: fs.Stats
      try {
        stat = fs.statSync(filePath)
        header = readSessionHeader(filePath)
      } catch (err) {
        // An unreadable or malformed header is not evidence that a previously
        // indexed source disappeared. Preserve its last-known-good record.
        uncertainFiles.add(canonicalIfExists(filePath))
        report.items.push({ filePath, action: 'error', error: (err as Error).message })
        continue
      }
      if (isPathWithin(header.cwd, normalizedRoot)) {
        authorizedFiles.push({ filePath, size: stat.size, mtimeMs: stat.mtimeMs })
      }
    }

    // Prefer recent sessions when the extension supplies a startup budget.
    // The core maintainer remains unlimited unless configured otherwise.
    authorizedFiles.sort((a, b) => b.mtimeMs - a.mtimeMs || a.filePath.localeCompare(b.filePath))
    const selectedFiles: typeof authorizedFiles = []
    let selectedBytes = 0
    for (const candidate of authorizedFiles) {
      if (selectedFiles.length >= this.maxScopedFiles) continue
      if (candidate.size > this.maxScopedSourceBytes - selectedBytes) continue
      selectedFiles.push(candidate)
      selectedBytes += candidate.size
    }

    const authorizedBytes = authorizedFiles.reduce((total, candidate) => total + candidate.size, 0)
    report.coverage = {
      authorizedFiles: authorizedFiles.length,
      authorizedBytes,
      selectedFiles: selectedFiles.length,
      selectedBytes,
      skippedFiles: authorizedFiles.length - selectedFiles.length,
      skippedBytes: authorizedBytes - selectedBytes,
      limited: selectedFiles.length !== authorizedFiles.length,
    }

    for (const { filePath } of selectedFiles) {
      report.items.push(this.syncFile(filePath))
    }

    const observed = new Set(selectedFiles.map(({ filePath }) => canonicalIfExists(filePath)))
    const toRemove: string[] = []
    for (const session of this.provider.sessionsList) {
      const comparable = canonicalIfExists(session.sourceInfo.filePath)
      if (!observed.has(comparable) && !uncertainFiles.has(comparable)) {
        toRemove.push(session.header.sessionId)
      }
    }
    for (const sessionId of toRemove) {
      this.provider.removeSession(sessionId)
      this.rebuildFileMap()
      report.removedSessionIds.push(sessionId)
      report.items.push({ filePath: sessionId, action: 'removed', sessionId })
    }

    this.rebuildFileMap()
    return report
  }

  syncFile(filePath: string): SyncItem {
    let stat: fs.Stats
    try {
      stat = fs.statSync(filePath)
    } catch (err) {
      return { filePath, action: 'error', error: (err as Error).message }
    }

    const previous = this.previousSourceInfo(filePath)
    if (
      previous !== undefined &&
      previous.size === stat.size &&
      previous.mtimeMs === stat.mtimeMs
    ) {
      // Cheap source observation: unchanged size and mtime means the file is
      // unchanged for local dogfood purposes. This avoids re-reading the full
      // current-session file on every turn and tool call.
      return { filePath, action: 'unchanged', sessionId: previous.header.sessionId }
    }

    let text: string
    try {
      text = fs.readFileSync(filePath, 'utf8')
    } catch (err) {
      return { filePath, action: 'error', sessionId: previous?.header.sessionId, error: (err as Error).message }
    }

    let parsed: ParsedSession
    let current: SessionSourceInfo
    try {
      const lines = parseLines(text, filePath)
      parsed = { header: lines.header, entries: lines.entries }
      current = sourceInfoFromLines(filePath, stat.size, stat.mtimeMs, lines)
    } catch (err) {
      // Preserve the last known-good index for this session, if any.
      const sessionId = this.fileToSession.get(filePath)
      return { filePath, action: 'error', sessionId, error: (err as Error).message }
    }

    try {
      if (previous === undefined) {
        this.provider.indexSession(parsed, current)
        this.fileToSession.set(filePath, parsed.header.sessionId)
        return { filePath, action: 'indexed', sessionId: parsed.header.sessionId }
      }

      const decision = decideIncremental(previous, current)
      if (decision === 'same') {
        return { filePath, action: 'unchanged', sessionId: previous.header.sessionId }
      }
      if (decision === 'append') {
        this.provider.appendSession(parsed, current, previous.entryCount)
        this.fileToSession.set(filePath, parsed.header.sessionId)
        return { filePath, action: 'appended', sessionId: parsed.header.sessionId }
      }
      // Header/identity changes are file replacement: drop the old session
      // before indexing the new identity so stale sessions do not linger.
      if (previous.header.sessionId !== parsed.header.sessionId) {
        this.provider.removeSession(previous.header.sessionId)
      }
      this.provider.indexSession(parsed, current)
      this.fileToSession.set(filePath, parsed.header.sessionId)
      return { filePath, action: 'indexed', sessionId: parsed.header.sessionId }
    } catch (err) {
      return { filePath, action: 'error', sessionId: previous?.header.sessionId, error: (err as Error).message }
    }
  }

  private previousSourceInfo(filePath: string): SessionSourceInfo | undefined {
    const sessionId = this.fileToSession.get(filePath)
    if (sessionId === undefined) return undefined
    return this.provider.getSession(sessionId)?.sourceInfo
  }
}

function canonicalIfExists(filePath: string): string {
  try {
    return fs.realpathSync(filePath)
  } catch {
    return filePath
  }
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return Number.POSITIVE_INFINITY
  if (!Number.isFinite(value) || value < 0) return Number.POSITIVE_INFINITY
  return Math.floor(value)
}
