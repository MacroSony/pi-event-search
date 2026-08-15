import type {
  ContextRole,
  Fragment,
  RawEntry,
  Role,
  SemanticKind,
} from './types.ts'

export interface ProjectorOptions {
  /** Hard bound for any single indexed fragment text, in Unicode code points. */
  maxIndexedTextChars?: number
  /**
   * Custom message types allowed into the search corpus. Unknown custom
   * entries must never become searchable merely because their payload
   * contains strings. Empty by default.
   */
  customSearchableTypes?: string[]
}

export interface ProjectionResult {
  sessionId: string
  entryId: string
  entryType: string
  timestamp: string
  parentId: string | null
  role: Role
  contextRole: ContextRole
  fragments: Fragment[]
}

const DEFAULT_MAX_INDEXED_TEXT_CHARS = 10_000

const ENTRY_USER = 'user'
const ENTRY_ASSISTANT = 'assistant'
const ENTRY_TOOL_RESULT = 'tool_result'
const ENTRY_BASH = 'bash'
const ENTRY_COMPACTION = 'compaction'
const ENTRY_BRANCH_SUMMARY = 'branch_summary'
const ENTRY_CUSTOM = 'custom'
const ENTRY_SESSION_INFO = 'session_info'
const ENTRY_MODEL_CHANGE = 'model_change'
const ENTRY_THINKING_CHANGE = 'thinking_change'
const ENTRY_LABEL = 'label'
const ENTRY_EXTENSION_STATE = 'extension_state'

export const SEMANTIC_KINDS = {
  USER_TEXT: 'user.text',
  ASSISTANT_TEXT: 'assistant.text',
  ASSISTANT_THINKING: 'assistant.thinking',
  TOOL_CALL: 'tool.call',
  TOOL_RESULT: 'tool.result',
  BASH_COMMAND: 'bash.command',
  BASH_OUTPUT: 'bash.output',
  SUMMARY_COMPACTION: 'summary.compaction',
  SUMMARY_BRANCH: 'summary.branch',
  CUSTOM_MESSAGE: 'custom.message',
  SESSION_NAME: 'session.name',
} as const

export const ENTRY_TYPES = {
  USER: ENTRY_USER,
  ASSISTANT: ENTRY_ASSISTANT,
  TOOL_RESULT: ENTRY_TOOL_RESULT,
  BASH: ENTRY_BASH,
  COMPACTION: ENTRY_COMPACTION,
  BRANCH_SUMMARY: ENTRY_BRANCH_SUMMARY,
  CUSTOM: ENTRY_CUSTOM,
  SESSION_INFO: ENTRY_SESSION_INFO,
  MODEL_CHANGE: ENTRY_MODEL_CHANGE,
  THINKING_CHANGE: ENTRY_THINKING_CHANGE,
  LABEL: ENTRY_LABEL,
  EXTENSION_STATE: ENTRY_EXTENSION_STATE,
} as const

export class Projector {
  private readonly maxIndexedTextChars: number
  private readonly customSearchableTypes: Set<string>

  constructor(options: ProjectorOptions = {}) {
    this.maxIndexedTextChars = options.maxIndexedTextChars ?? DEFAULT_MAX_INDEXED_TEXT_CHARS
    this.customSearchableTypes = new Set(options.customSearchableTypes ?? [])
  }

  project(sessionId: string, entry: RawEntry): ProjectionResult {
    const base = {
      sessionId,
      entryId: entry.id,
      entryType: entry.type,
      timestamp: entry.timestamp,
      parentId: entry.parentId,
    }

    let result: ProjectionResult
    switch (entry.type) {
      case ENTRY_USER:
        result = { ...base, role: 'user', contextRole: 'conversation', fragments: this.projectUser(entry) }
        break
      case ENTRY_ASSISTANT:
        result = { ...base, role: 'assistant', contextRole: 'conversation', fragments: this.projectAssistant(entry) }
        break
      case ENTRY_TOOL_RESULT:
        result = { ...base, role: 'tool', contextRole: 'conversation', fragments: this.projectToolResult(entry) }
        break
      case ENTRY_BASH:
        result = { ...base, role: 'tool', contextRole: 'conversation', fragments: this.projectBash(entry) }
        break
      case ENTRY_COMPACTION:
        result = { ...base, role: 'summary', contextRole: 'summary', fragments: this.projectSummary(entry, SEMANTIC_KINDS.SUMMARY_COMPACTION) }
        break
      case ENTRY_BRANCH_SUMMARY:
        result = { ...base, role: 'summary', contextRole: 'summary', fragments: this.projectSummary(entry, SEMANTIC_KINDS.SUMMARY_BRANCH) }
        break
      case ENTRY_CUSTOM:
        result = { ...base, role: 'custom', contextRole: 'conversation', fragments: this.projectCustom(entry) }
        break
      case ENTRY_SESSION_INFO:
        result = { ...base, role: 'metadata', contextRole: 'metadata', fragments: this.projectSessionName(entry) }
        break
      case ENTRY_MODEL_CHANGE:
      case ENTRY_THINKING_CHANGE:
      case ENTRY_EXTENSION_STATE:
        result = { ...base, role: 'metadata', contextRole: 'control', fragments: [] }
        break
      case ENTRY_LABEL:
        result = { ...base, role: 'metadata', contextRole: 'metadata', fragments: [] }
        break
      default:
        // Unknown custom/extension entries are typed but not searchable.
        result = { ...base, role: 'metadata', contextRole: 'control', fragments: [] }
        break
    }
    result.fragments = result.fragments.map((fragment) => ({ ...fragment, sessionId }))
    return result
  }

  private projectUser(entry: RawEntry): Fragment[] {
    const text = stringField(entry, 'text')
    if (text === null || text.length === 0) return []
    return [this.fragment(entry, SEMANTIC_KINDS.USER_TEXT, text, 0)]
  }

  private projectAssistant(entry: RawEntry): Fragment[] {
    const fragments: Fragment[] = []
    const text = stringField(entry, 'text')
    if (text !== null && text.length > 0) {
      fragments.push(this.fragment(entry, SEMANTIC_KINDS.ASSISTANT_TEXT, text, 0))
    }
    // assistant.thinking is deliberately never indexed or returned in the MVP.
    const toolCalls = entry['toolCalls']
    if (Array.isArray(toolCalls)) {
      let index = 0
      for (const rawCall of toolCalls) {
        if (!isRecord(rawCall)) continue
        const name = typeof rawCall['name'] === 'string' ? rawCall['name'] : ''
        const toolCallId = typeof rawCall['toolCallId'] === 'string' ? rawCall['toolCallId'] : undefined
        if (name.length === 0) continue
        const args = normalizeArguments(rawCall['arguments'])
        const text = `${name}\n${args}`
        const frag = this.fragment(entry, SEMANTIC_KINDS.TOOL_CALL, text, index)
        frag.toolName = name
        frag.toolCallId = toolCallId
        fragments.push(frag)
        index += 1
      }
    }
    return fragments
  }

  private projectToolResult(entry: RawEntry): Fragment[] {
    const name = stringField(entry, 'name') ?? stringField(entry, 'toolName') ?? ''
    const result = stringField(entry, 'result') ?? stringField(entry, 'text') ?? ''
    const toolCallId = stringField(entry, 'toolCallId') ?? undefined
    const isError = booleanField(entry, 'isError') ?? booleanField(entry, 'error') ?? false
    if (result.length === 0 && name.length === 0) return []
    const text = name.length > 0 ? `${name}\n${result}` : result
    const frag = this.fragment(entry, SEMANTIC_KINDS.TOOL_RESULT, text, 0)
    frag.toolName = name.length > 0 ? name : undefined
    frag.toolCallId = toolCallId
    frag.isError = isError
    return [frag]
  }

  private projectBash(entry: RawEntry): Fragment[] {
    const fragments: Fragment[] = []
    const command = stringField(entry, 'command') ?? ''
    if (command.length > 0) {
      const frag = this.fragment(entry, SEMANTIC_KINDS.BASH_COMMAND, command, 0)
      frag.toolName = 'bash'
      fragments.push(frag)
    }
    const output = stringField(entry, 'output') ?? ''
    if (output.length > 0) {
      const frag = this.fragment(entry, SEMANTIC_KINDS.BASH_OUTPUT, output, 1)
      frag.toolName = 'bash'
      frag.isError = booleanField(entry, 'isError') ?? false
      fragments.push(frag)
    }
    return fragments
  }

  private projectSummary(entry: RawEntry, kind: SemanticKind): Fragment[] {
    const summary = stringField(entry, 'summary') ?? stringField(entry, 'text') ?? ''
    if (summary.length === 0) return []
    return [this.fragment(entry, kind, summary, 0)]
  }

  private projectCustom(entry: RawEntry): Fragment[] {
    const customType = stringField(entry, 'customType') ?? ''
    if (!this.customSearchableTypes.has(customType)) return []
    const text = stringField(entry, 'text') ?? ''
    if (text.length === 0) return []
    const frag = this.fragment(entry, SEMANTIC_KINDS.CUSTOM_MESSAGE, `${customType}\n${text}`, 0)
    frag.customType = customType
    return [frag]
  }

  private projectSessionName(entry: RawEntry): Fragment[] {
    const rawName = stringField(entry, 'name') ?? stringField(entry, 'text') ?? ''
    const name = normalizeSessionName(rawName)
    if (name.length === 0) return []
    return [this.fragment(entry, SEMANTIC_KINDS.SESSION_NAME, name, 0)]
  }

  private fragment(entry: RawEntry, kind: SemanticKind, text: string, index: number): Fragment {
    const bounded = truncateCodePoints(text, this.maxIndexedTextChars)
    return {
      fragmentId: `${entry.id}::${kind}::${index}`,
      sessionId: '',
      entryId: entry.id,
      semanticKind: kind,
      text: bounded,
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(entry: RawEntry, key: string): string | null {
  const value = entry[key]
  return typeof value === 'string' ? value : null
}

function booleanField(entry: RawEntry, key: string): boolean | null {
  const value = entry[key]
  return typeof value === 'boolean' ? value : null
}

export function normalizeArguments(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => normalizeArguments(item)).join(', ')}]`
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    const parts = keys.map((key) => `${JSON.stringify(key)}: ${normalizeArguments(record[key])}`)
    return `{ ${parts.join(', ')} }`
  }
  return String(value)
}

export function normalizeSessionName(name: string): string {
  return name.replace(/\s+/g, ' ').trim()
}

export function codePointLength(text: string): number {
  let count = 0
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) i += 1
    }
    count += 1
  }
  return count
}

export function truncateCodePoints(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  const length = codePointLength(text)
  if (length <= maxChars) return text
  const sliced = codePointSlice(text, 0, maxChars)
  return `${sliced}\u2026`
}

export function codePointSlice(text: string, start: number, end: number): string {
  if (start < 0) start = 0
  if (end <= start) return ''
  const chars = Array.from(text)
  return chars.slice(start, end).join('')
}
