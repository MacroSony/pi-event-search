import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { AuthConfig } from '../types.ts'

/**
 * Normalize a path for authorization comparison. Existing paths are
 * canonicalized with realpath; missing paths are still resolved to an
 * absolute, normalized form so recorded session cwds remain comparable.
 */
export function normalizePath(input: string): string {
  let resolved = path.resolve(input)
  try {
    resolved = fs.realpathSync(resolved)
  } catch {
    // Keep the absolute normalized path for non-existing paths.
  }
  return resolved
}

/**
 * Return true when `child` equals `root` or is a descendant of `root` on a
 * path-component boundary. Fuzzy path matching is intentionally unsupported.
 */
export function isPathWithin(child: string, root: string): boolean {
  const normalizedChild = normalizePath(child)
  const normalizedRoot = normalizePath(root)
  if (normalizedChild === normalizedRoot) return true
  if (normalizedRoot === path.parse(normalizedRoot).root) {
    // Root directory contains every absolute path.
    return path.isAbsolute(normalizedChild)
  }
  const prefix = normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`
  return normalizedChild.startsWith(prefix)
}

export function resolveWorkspaceRoot(config: AuthConfig): string {
  if (config.explicitWorkspaceRoot !== undefined && config.explicitWorkspaceRoot.length > 0) {
    return normalizePath(config.explicitWorkspaceRoot)
  }
  const gitRoot = tryGitWorktreeRoot(config.cwd)
  if (gitRoot !== null) return gitRoot
  return normalizePath(config.cwd)
}

function tryGitWorktreeRoot(cwd: string): string | null {
  try {
    const output = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (output.length === 0) return null
    return normalizePath(output)
  } catch {
    return null
  }
}
