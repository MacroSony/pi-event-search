/**
 * Public failure classes. A missing session and an unauthorized session must
 * produce the same public failure so callers cannot probe other workspaces.
 */

export type PiEventSearchErrorCode =
  | 'INVALID_QUERY'
  | 'NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'INVALID_ARGUMENT'
  | 'SOURCE_PARSE_FAILED'
  | 'INTERNAL'

export class PiEventSearchError extends Error {
  readonly code: PiEventSearchErrorCode
  readonly publicMessage: string

  constructor(code: PiEventSearchErrorCode, publicMessage: string, detail?: string) {
    super(detail ?? publicMessage)
    this.name = 'PiEventSearchError'
    this.code = code
    this.publicMessage = publicMessage
  }
}

export class InvalidQueryError extends PiEventSearchError {
  constructor(detail: string) {
    super('INVALID_QUERY', 'Invalid search query.', detail)
  }
}

export class SourceParseError extends PiEventSearchError {
  readonly line?: number
  constructor(detail: string, line?: number) {
    super('SOURCE_PARSE_FAILED', 'Session source could not be parsed safely.', detail)
    this.line = line
  }
}

/** Missing and unauthorized collapse to the same public failure. */
export function notFoundError(detail?: string): PiEventSearchError {
  return new PiEventSearchError('NOT_FOUND', 'Session or entry not found.', detail)
}
