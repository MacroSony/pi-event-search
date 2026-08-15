import test from 'node:test'
import assert from 'node:assert/strict'
import { parseQuery } from '../src/query.ts'
import { InvalidQueryError } from '../src/errors.ts'

test('parses plain terms and quoted phrases', () => {
  const parsed = parseQuery('install "react package"')
  assert.deepEqual(parsed.terms, ['install'])
  assert.deepEqual(parsed.phrases, ['react package'])
  assert.equal(parsed.ftsQuery, '"install" "react package"')
})

test('empty and whitespace-only queries are rejected', () => {
  assert.throws(() => parseQuery('   '), InvalidQueryError)
  assert.throws(() => parseQuery(''), InvalidQueryError)
})

test('unterminated phrase is rejected', () => {
  assert.throws(() => parseQuery('"unterminated'), InvalidQueryError)
})

test('empty quoted phrase is rejected', () => {
  assert.throws(() => parseQuery('""'), InvalidQueryError)
})

test('raw FTS operators are treated as plain quoted terms', () => {
  const parsed = parseQuery('foo AND bar')
  assert.deepEqual(parsed.terms, ['foo', 'AND', 'bar'])
  assert.equal(parsed.ftsQuery, '"foo" "AND" "bar"')
})
