import { codePointLength, codePointSlice } from './projector.ts'
import type { TextPreview, TextRange } from './types.ts'

export interface SnippetOptions {
  maxChars?: number
}

export interface TextPreviewOptions {
  maxChars?: number
  headChars?: number
  tailChars?: number
  offset?: number
  windowChars?: number
}

export const DEFAULT_SNIPPET_CHARS = 240
export const DEFAULT_PREVIEW_CHARS = 2000
export const DEFAULT_WINDOW_CHARS = 2000

/**
 * Build a bounded plain-text snippet centered on the first query term match.
 * Whitespace is normalized; no paraphrase or generated summary is produced.
 */
export function buildSnippet(text: string, terms: string[], options: SnippetOptions = {}): string {
  const maxChars = options.maxChars ?? DEFAULT_SNIPPET_CHARS
  const normalized = normalizeWhitespace(text)
  if (codePointLength(normalized) <= maxChars) return normalized

  const matchIndex = firstMatchIndex(normalized, terms)
  if (matchIndex < 0) {
    return codePointSlice(normalized, 0, maxChars)
  }
  const matchCodePointIndex = Array.from(normalized.slice(0, matchIndex)).length

  const contextBefore = Math.floor(maxChars / 3)
  const contextAfter = maxChars - contextBefore
  const start = Math.max(0, matchCodePointIndex - contextBefore)
  const end = Math.min(codePointLength(normalized), matchCodePointIndex + contextAfter)
  return codePointSlice(normalized, start, end)
}

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function firstMatchIndex(text: string, terms: string[]): number {
  const lower = text.toLowerCase()
  let best = -1
  for (const term of terms) {
    if (term.length === 0) continue
    const index = lower.indexOf(term.toLowerCase())
    if (index >= 0 && (best < 0 || index < best)) best = index
  }
  return best
}

/**
 * Produce a faithful preview with exact shown/omitted code-point ranges.
 *
 * - Without `offset`: shows head and tail for oversized text.
 * - With `offset`: shows a fixed-size contiguous window starting at the
 *   offset. The window never raises the output cap.
 */
export function makeTextPreview(text: string, options: TextPreviewOptions = {}): TextPreview {
  const totalChars = codePointLength(text)
  const maxChars = nonNegativeInteger(options.maxChars, DEFAULT_PREVIEW_CHARS)
  const windowChars = nonNegativeInteger(options.windowChars, DEFAULT_WINDOW_CHARS)

  if (options.offset !== undefined) {
    const requestedOffset = nonNegativeInteger(options.offset, 0)
    const start = clamp(requestedOffset, 0, totalChars)
    const end = Math.min(totalChars, start + windowChars)
    const shown = codePointSlice(text, start, end)
    const shownRanges = end > start ? [{ start, end }] : []
    return {
      text: shown,
      totalChars,
      shownRanges,
      omittedRanges: omitRanges(shownRanges, totalChars),
      truncated: end - start < totalChars,
    }
  }

  if (totalChars <= maxChars) {
    return {
      text,
      totalChars,
      shownRanges: [{ start: 0, end: totalChars }],
      omittedRanges: [],
      truncated: false,
    }
  }

  const headChars = options.headChars ?? Math.ceil(maxChars / 2)
  const tailChars = options.tailChars ?? Math.floor(maxChars / 2)
  if (headChars + tailChars >= totalChars) {
    return {
      text,
      totalChars,
      shownRanges: [{ start: 0, end: totalChars }],
      omittedRanges: [],
      truncated: false,
    }
  }

  const headEnd = headChars
  const tailStart = totalChars - tailChars
  const head = codePointSlice(text, 0, headEnd)
  const tail = codePointSlice(text, tailStart, totalChars)
  return {
    text: `${head}\u2026${tail}`,
    totalChars,
    shownRanges: [
      { start: 0, end: headEnd },
      { start: tailStart, end: totalChars },
    ],
    omittedRanges: [{ start: headEnd, end: tailStart }],
    truncated: true,
  }
}

function omitRanges(shown: TextRange[], totalChars: number): TextRange[] {
  const omitted: TextRange[] = []
  let cursor = 0
  const sorted = [...shown].sort((a, b) => a.start - b.start)
  for (const range of sorted) {
    if (range.start > cursor) omitted.push({ start: cursor, end: range.start })
    cursor = Math.max(cursor, range.end)
  }
  if (cursor < totalChars) omitted.push({ start: cursor, end: totalChars })
  return omitted
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min
  return Math.min(max, Math.max(min, value))
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(0, Math.floor(value))
}
