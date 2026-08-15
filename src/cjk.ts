// CJK-aware index tokenization.
//
// The FTS5 unicode61 tokenizer treats every maximal run of "alphanumeric"
// characters as a single token. CJK ideographs and kana are letters, so a
// Chinese/Japanese sentence without spaces becomes one long token and
// substring queries (e.g. 喜欢, 角色, 凯尔希) can never match.
//
// segmentForIndex inserts a space around every CJK code point so each
// character becomes its own token. The same transform is applied to query
// terms, so a multi-character query becomes an ordered phrase of adjacent
// tokens ("喜欢" -> "喜 欢") and recovers substring semantics.

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u

/**
 * Insert a space around every CJK code point, leaving non-CJK runs (Latin
 * words, identifiers, numbers, punctuation) intact. Collapses the resulting
 * whitespace so the output is a clean token sequence for the FTS index.
 */
export function segmentForIndex(text: string): string {
  let out = ''
  for (const ch of text) {
    if (CJK_RE.test(ch)) {
      out += ` ${ch} `
    } else {
      out += ch
    }
  }
  return out.replace(/\s+/g, ' ').trim()
}

export function isCjkChar(ch: string): boolean {
  return CJK_RE.test(ch)
}
