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

test('CJK terms are segmented for the FTS query but kept whole for snippets', () => {
  const parsed = parseQuery('喜欢')
  assert.deepEqual(parsed.terms, ['喜欢'])
  assert.equal(parsed.ftsQuery, '"喜" "欢"')

  const multi = parseQuery('我喜欢凯尔希')
  assert.equal(multi.ftsQuery, '"我" "喜" "欢" "凯" "尔" "希"')

  const latin = parseQuery('event_search')
  assert.equal(latin.ftsQuery, '"event_search"')
})

test('quoted CJK phrases keep adjacency semantics', () => {
  const quoted = parseQuery('"修改文件"')
  assert.deepEqual(quoted.phrases, ['修改文件'])
  assert.equal(quoted.ftsQuery, '"修 改 文 件"')

  const mixed = parseQuery('"event_search"')
  assert.equal(mixed.ftsQuery, '"event_search"')
})

test('mixed CJK and Latin terms are split into AND tokens', () => {
  const parsed = parseQuery('中文abc')
  assert.equal(parsed.ftsQuery, '"中" "文" "abc"')
})
