import fs from 'node:fs'
import { discoverSessionFiles, type DiscoveryConfig } from '../auth/discovery.ts'
import { decideIncremental, parseLines, sourceInfoFromLines } from '../parser.ts'
import type { ParsedSession, SessionSourceInfo } from '../types.ts'
import type { SearchProvider } from './provider.ts'

export interface MaintainerConfig {
  provider: SearchProvider
  discovery?: DiscoveryConfig
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
}

export class IndexMaintainer {
  readonly provider: SearchProvider
  private readonly discoveryConfig: DiscoveryConfig
  private readonly fileToSession = new Map<string, string>()

  constructor(config: MaintainerConfig) {
    this.provider = config.provider
    this.discoveryConfig = config.discovery ?? {}
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

  syncFile(filePath: string): SyncItem {
    let text: string
    let stat: fs.Stats
    try {
      stat = fs.statSync(filePath)
      text = fs.readFileSync(filePath, 'utf8')
    } catch (err) {
      return { filePath, action: 'error', error: (err as Error).message }
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

    const previous = this.previousSourceInfo(filePath)
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
