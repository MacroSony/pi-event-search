import { InvalidQueryError } from './errors.ts'
import { segmentForIndex } from './cjk.ts'

export interface ParsedQuery {
  terms: string[]
  phrases: string[]
  /** Escaped FTS5 query string. Each public term/phrase is quoted. */
  ftsQuery: string
}

/**
 * Parse the public query language: plain terms and quoted phrases.
 *
 * Separate terms have implicit AND semantics. Boolean operators, column
 * syntax, and other raw FTS expressions are not part of the public language
 * and are never passed through unquoted.
 */
export function parseQuery(input: string): ParsedQuery {
  const text = input.trim()
  if (text.length === 0) {
    throw new InvalidQueryError('Query must contain at least one term or quoted phrase.')
  }

  const terms: string[] = []
  const phrases: string[] = []
  let i = 0
  while (i < text.length) {
    const char = text[i]
    if (/\s/.test(char)) {
      i += 1
      continue
    }
    if (char === '"') {
      i += 1
      let phrase = ''
      let closed = false
      while (i < text.length) {
        const current = text[i]
        if (current === '"') {
          closed = true
          i += 1
          break
        }
        phrase += current
        i += 1
      }
      if (!closed) {
        throw new InvalidQueryError('Unterminated quoted phrase.')
      }
      if (phrase.trim().length === 0) {
        throw new InvalidQueryError('Quoted phrases must contain at least one character.')
      }
      phrases.push(phrase.trim())
      continue
    }
    // Plain term: run until whitespace or an opening quote.
    let term = ''
    while (i < text.length && !/\s/.test(text[i]) && text[i] !== '"') {
      term += text[i]
      i += 1
    }
    if (term.length > 0) terms.push(term)
  }

  if (terms.length === 0 && phrases.length === 0) {
    throw new InvalidQueryError('Query must contain at least one term or quoted phrase.')
  }

  // CJK terms are segmented into per-character tokens so that substring
  // queries match inside longer CJK runs. `terms`/`phrases` stay whole for
  // snippet highlighting against the original fragment text.
  //
  // Unquoted terms become an AND of their segmented tokens, so a CJK term
  // like 修改文件 matches a document containing those characters even with
  // intervening particles (我修改了文件). Quoted phrases keep adjacency.
  const ftsParts: string[] = []
  for (const term of terms) ftsParts.push(quoteEachSegment(term))
  for (const phrase of phrases) ftsParts.push(quoteFtsString(segmentForIndex(phrase)))
  return { terms, phrases, ftsQuery: ftsParts.join(' ') }
}

function quoteEachSegment(value: string): string {
  const segmented = segmentForIndex(value)
  if (segmented.length === 0) return quoteFtsString(value)
  return segmented.split(/\s+/).map((token) => quoteFtsString(token)).join(' ')
}

function quoteFtsString(value: string): string {
  // FTS5 strings are wrapped in double quotes; a double quote cannot appear
  // inside because the public parser never produces one.
  return `"${value.replace(/"/g, '""')}"`
}
