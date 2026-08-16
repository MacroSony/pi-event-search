import test from 'node:test'
import assert from 'node:assert/strict'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import piEventSearchExtension from '../extension.ts'

test('Pi entrypoint registers the compact tools and closes cleanly', async () => {
  const tools: Array<{ name: string }> = []
  const handlers = new Map<string, (...args: any[]) => unknown>()
  const api = {
    registerTool(tool: { name: string }) {
      tools.push(tool)
    },
    on(event: string, handler: (...args: any[]) => unknown) {
      handlers.set(event, handler)
    },
  }

  piEventSearchExtension(api as unknown as ExtensionAPI)
  assert.deepEqual(tools.map((tool) => tool.name), ['event_search', 'event_read', 'event_trace'])
  assert.ok(handlers.has('session_start'))
  assert.ok(handlers.has('agent_settled'))
  assert.ok(handlers.has('session_shutdown'))

  const shutdown = handlers.get('session_shutdown')!
  await shutdown({ type: 'session_shutdown', reason: 'reload' }, {})
  await shutdown({ type: 'session_shutdown', reason: 'reload' }, {})
})
