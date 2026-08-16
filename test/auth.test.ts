import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { discoverSessionFiles, defaultSessionDir } from '../src/auth/discovery.ts'
import { Authorizer } from '../src/auth/authorizer.ts'
import { isPathWithin, normalizePath, resolveWorkspaceRoot } from '../src/auth/paths.ts'
import { SearchProvider } from '../src/index/provider.ts'
import { parseSessionText } from '../src/parser.ts'
import { makeSourceInfo } from './helpers.ts'

test('path boundary authorization', () => {
  assert.equal(isPathWithin('/tmp/ws', '/tmp/ws'), true)
  assert.equal(isPathWithin('/tmp/ws/sub', '/tmp/ws'), true)
  assert.equal(isPathWithin('/tmp/ws/sub/deep', '/tmp/ws'), true)
  assert.equal(isPathWithin('/tmp/ws2', '/tmp/ws'), false)
  assert.equal(isPathWithin('/tmp/w', '/tmp/ws'), false)
})

test('workspace root resolves git root or falls back to cwd', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pes-auth-'))
  const gitDir = path.join(dir, 'repo')
  fs.mkdirSync(gitDir)
  fs.writeFileSync(path.join(gitDir, 'file.txt'), '')
  // Not a git repo, so fallback to cwd.
  const fallback = resolveWorkspaceRoot({ cwd: gitDir })
  assert.equal(fallback, normalizePath(gitDir))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('discoverSessionFiles finds jsonl files recursively and sorted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pes-disc-'))
  fs.writeFileSync(path.join(dir, 'a.jsonl'), '')
  fs.mkdirSync(path.join(dir, 'nested'))
  fs.writeFileSync(path.join(dir, 'nested', 'b.jsonl'), '')
  fs.writeFileSync(path.join(dir, 'ignore.txt'), '')
  const files = discoverSessionFiles({ sessionDirs: [dir] })
  assert.deepEqual(files, [path.join(dir, 'a.jsonl'), path.join(dir, 'nested', 'b.jsonl')])
  fs.rmSync(dir, { recursive: true, force: true })
})

test('default session dir uses Pi agent sessions root', () => {
  const previousPi = process.env['PI_CODING_AGENT_SESSION_DIR']
  const previousLegacy = process.env['PI_SESSION_DIR']
  delete process.env['PI_CODING_AGENT_SESSION_DIR']
  delete process.env['PI_SESSION_DIR']
  assert.equal(defaultSessionDir(), path.join(os.homedir(), '.pi', 'agent', 'sessions'))
  if (previousPi === undefined) delete process.env['PI_CODING_AGENT_SESSION_DIR']
  else process.env['PI_CODING_AGENT_SESSION_DIR'] = previousPi
  if (previousLegacy === undefined) delete process.env['PI_SESSION_DIR']
  else process.env['PI_SESSION_DIR'] = previousLegacy
})

test('default session dir honors Pi\'s official environment variable', () => {
  const previous = process.env['PI_CODING_AGENT_SESSION_DIR']
  process.env['PI_CODING_AGENT_SESSION_DIR'] = '/tmp/pes-sessions'
  assert.equal(defaultSessionDir(), '/tmp/pes-sessions')
  if (previous === undefined) delete process.env['PI_CODING_AGENT_SESSION_DIR']
  else process.env['PI_CODING_AGENT_SESSION_DIR'] = previous
})

test('authorizer uses explicit root over git and cwd', () => {
  const explicit = fs.mkdtempSync(path.join(os.tmpdir(), 'pes-explicit-'))
  const authorizer = new Authorizer({ cwd: process.cwd(), explicitWorkspaceRoot: explicit })
  assert.equal(authorizer.isAuthorized(path.join(explicit, 'sub')), true)
  assert.equal(authorizer.isAuthorized('/tmp/elsewhere'), false)
  fs.rmSync(explicit, { recursive: true, force: true })
})

test('missing and unauthorized sessions fail identically through provider', () => {
  const parsed = parseSessionText(`{"sessionId":"s1","createdAt":"2026-01-01T00:00:00.000Z","cwd":"/tmp/ws"}
{"id":"A","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","type":"user","text":"hi"}
`)
  const provider = new SearchProvider()
  provider.indexSession(parsed, makeSourceInfo(parsed))
  const missingError = (() => {
    try { provider.searchEvents({ query: 'hi', sessionId: 'missing' }, { authRoot: '/tmp/ws' }); return null }
    catch (err) { return err as { code: string; publicMessage: string } }
  })()
  const unauthorizedError = (() => {
    try { provider.searchEvents({ query: 'hi', sessionId: 's1' }, { authRoot: '/tmp/other' }); return null }
    catch (err) { return err as { code: string; publicMessage: string } }
  })()
  assert.equal(missingError?.code, 'NOT_FOUND')
  assert.equal(missingError?.code, unauthorizedError?.code)
  assert.equal(missingError?.publicMessage, unauthorizedError?.publicMessage)
  provider.close()
})
