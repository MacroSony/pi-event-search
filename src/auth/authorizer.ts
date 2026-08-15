import { PiEventSearchError } from '../errors.ts'
import type { AuthConfig } from '../types.ts'
import { isPathWithin, normalizePath, resolveWorkspaceRoot } from './paths.ts'

export class Authorizer {
  readonly root: string

  constructor(config: AuthConfig) {
    this.root = resolveWorkspaceRoot(config)
  }

  /** True when a recorded session cwd is equal to or inside the resolved root. */
  isAuthorized(sessionCwd: string): boolean {
    return isPathWithin(sessionCwd, this.root)
  }

  /**
   * Missing and unauthorized sessions share one public failure. Callers use
   * this after a provider lookup to avoid revealing workspace existence.
   */
  assertAuthorized(sessionCwd: string): void {
    if (!this.isAuthorized(sessionCwd)) {
      throw new PiEventSearchError('NOT_FOUND', 'Session or entry not found.')
    }
  }

  normalize(input: string): string {
    return normalizePath(input)
  }
}
