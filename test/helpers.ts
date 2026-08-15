import { parseSessionText, type ParsedSession } from '../src/parser.ts'
import type { SessionSourceInfo } from '../src/types.ts'

export const TREE_SESSION = `{"sessionId":"s1","createdAt":"2026-01-01T00:00:00.000Z","cwd":"/tmp/ws"}
{"id":"A","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","type":"user","text":"hello searchable world"}
{"id":"B","parentId":"A","timestamp":"2026-01-01T00:00:02.000Z","type":"assistant","text":"assistant reply","thinking":"secret thought"}
{"id":"C","parentId":"B","timestamp":"2026-01-01T00:00:03.000Z","type":"user","text":"old branch"}
{"id":"D","parentId":"C","timestamp":"2026-01-01T00:00:04.000Z","type":"assistant","text":"old branch answer"}
{"id":"E","parentId":"B","timestamp":"2026-01-01T00:00:05.000Z","type":"user","text":"new branch"}
{"id":"F","parentId":"E","timestamp":"2026-01-01T00:00:06.000Z","type":"assistant","text":"new branch answer"}
`

export const TOOL_SESSION = `{"sessionId":"s2","createdAt":"2026-01-01T00:00:00.000Z","cwd":"/tmp/ws"}
{"id":"A","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","type":"user","text":"install package please"}
{"id":"B","parentId":"A","timestamp":"2026-01-01T00:00:02.000Z","type":"assistant","text":"I will install package","toolCalls":[{"toolCallId":"tc1","name":"bash","arguments":{"command":"npm install package"}}]}
{"id":"C","parentId":"B","timestamp":"2026-01-01T00:00:03.000Z","type":"tool_result","toolCallId":"tc1","name":"bash","result":"installed package","isError":false}
{"id":"D","parentId":"C","timestamp":"2026-01-01T00:00:04.000Z","type":"bash","command":"npm test package","output":"tests passed"}
{"id":"E","parentId":"D","timestamp":"2026-01-01T00:00:05.000Z","type":"tool_result","toolCallId":"tc2","name":"read_file","result":"file contents","isError":true}
`

export function makeSourceInfo(parsed: ParsedSession, filePath = '<memory>', size = 0): SessionSourceInfo {
  return {
    filePath,
    size,
    mtimeMs: 0,
    header: parsed.header,
    entryCount: parsed.entries.length,
    firstEntryId: parsed.entries[0]?.id ?? null,
    lastEntryId: parsed.entries[parsed.entries.length - 1]?.id ?? null,
    entryHashes: parsed.entries.map((_, index) => `hash-${index}`),
  }
}

export function parse(text: string): ParsedSession {
  return parseSessionText(text)
}
