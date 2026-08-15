import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface DiscoveryConfig {
  /** Explicit session directories. Defaults to Pi's effective session dir. */
  sessionDirs?: string[]
  /** File extensions recognized as session JSONL files. */
  extensions?: string[]
}

export const DEFAULT_EXTENSIONS = ['.jsonl']

export function defaultSessionDir(): string {
  return process.env['PI_SESSION_DIR'] ?? path.join(os.homedir(), '.pi', 'sessions')
}

/**
 * Discover session files across Pi's effective session directory plus
 * explicitly configured additional or archive directories.
 *
 * Discovery never grants access: every discovered session must still pass the
 * workspace-root authorization rule at query time.
 */
export function discoverSessionFiles(config: DiscoveryConfig = {}): string[] {
  const dirs = config.sessionDirs ?? [defaultSessionDir()]
  const extensions = new Set(config.extensions ?? DEFAULT_EXTENSIONS)
  const found: string[] = []

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue
    const stat = fs.statSync(dir)
    if (!stat.isDirectory()) continue
    collectJsonlFiles(dir, extensions, found)
  }

  found.sort()
  return [...new Set(found)]
}

function collectJsonlFiles(dir: string, extensions: Set<string>, output: string[]): void {
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      collectJsonlFiles(fullPath, extensions, output)
      continue
    }
    if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
      output.push(fullPath)
    }
  }
}
