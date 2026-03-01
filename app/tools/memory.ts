import { file, write } from 'bun'
import { rename, rm } from 'node:fs/promises'
import type { OpenAIFunctionTool } from '../types/tools'
import type { FunctionToolRuntime } from '../types/tools'
import { asObject } from '../utils/guards'

export const MEMORY_SET_TOOL = 'builtin__memory_set'
export const MEMORY_LIST_TOOL = 'builtin__memory_list'
export const MEMORY_DELETE_TOOL = 'builtin__memory_delete'

type MemoryRecord = {
  key: string
  value: string
  created_at: string
  updated_at: string
}

type MemoryStore = {
  memories: MemoryRecord[]
}

const MAX_LIST_LIMIT = 200
const DEFAULT_LIST_LIMIT = 50

export const MEMORY_SET_TOOL_SCHEMA: OpenAIFunctionTool = {
  type: 'function',
  function: {
    name: MEMORY_SET_TOOL,
    description:
      'Create or update one persistent memory item in .agents/memory.json.',
    parameters: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description:
            'Stable memory key, e.g. "user-name", "timezone", "project-preference".',
        },
        value: {
          type: 'string',
          description: 'Memory value to persist.',
        },
        overwrite: {
          type: 'boolean',
          default: true,
          description:
            'Whether to overwrite existing key. If false and key exists, tool returns conflict.',
        },
      },
      required: ['key', 'value'],
      additionalProperties: false,
    },
  },
}

export const MEMORY_LIST_TOOL_SCHEMA: OpenAIFunctionTool = {
  type: 'function',
  function: {
    name: MEMORY_LIST_TOOL,
    description: 'List persistent memory items from .agents/memory.json.',
    parameters: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Exact key filter.',
        },
        query: {
          type: 'string',
          description: 'Case-insensitive substring search in key and value.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_LIST_LIMIT,
          default: DEFAULT_LIST_LIMIT,
        },
      },
      additionalProperties: false,
    },
  },
}

export const MEMORY_DELETE_TOOL_SCHEMA: OpenAIFunctionTool = {
  type: 'function',
  function: {
    name: MEMORY_DELETE_TOOL,
    description: 'Delete one persistent memory item by key.',
    parameters: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Exact memory key to delete.',
        },
      },
      required: ['key'],
      additionalProperties: false,
    },
  },
}

function getMemoryStorePath(runtime: FunctionToolRuntime): string {
  return `${runtime.projectRoot}/.agents/memory.json`
}

function isoNow(): string {
  return new Date().toISOString()
}

function parseDateOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null
  }
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) {
    return null
  }
  return date.toISOString()
}

function normalizeMemoryRecord(raw: unknown): MemoryRecord | null {
  const obj = asObject(raw)
  const key = typeof obj.key === 'string' ? obj.key.trim() : ''
  const value = typeof obj.value === 'string' ? obj.value.trim() : ''
  if (!key || !value) {
    return null
  }

  const createdAt = parseDateOrNull(obj.created_at) ?? isoNow()
  const updatedAt = parseDateOrNull(obj.updated_at) ?? createdAt
  return {
    key,
    value,
    created_at: createdAt,
    updated_at: updatedAt,
  }
}

function normalizeMemoryStore(raw: unknown): MemoryStore {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { memories: [] }
  }

  const obj = raw as { memories?: unknown }
  const items = Array.isArray(obj.memories) ? obj.memories : []
  const deduped = new Map<string, MemoryRecord>()
  for (const item of items) {
    const normalized = normalizeMemoryRecord(item)
    if (!normalized) {
      continue
    }
    deduped.set(normalized.key, normalized)
  }

  return {
    memories: Array.from(deduped.values()),
  }
}

async function readMemoryStore(runtime: FunctionToolRuntime): Promise<MemoryStore> {
  const path = getMemoryStorePath(runtime)
  const ref = file(path)
  if (!(await ref.exists())) {
    return { memories: [] }
  }

  const raw = (await ref.text()).trim()
  if (!raw) {
    return { memories: [] }
  }

  const parsed = JSON.parse(raw)
  return normalizeMemoryStore(parsed)
}

async function writeMemoryStore(
  runtime: FunctionToolRuntime,
  store: MemoryStore,
): Promise<void> {
  const path = getMemoryStorePath(runtime)
  const tempPath = `${path}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  const content = `${JSON.stringify(store, null, 2)}\n`
  await write(tempPath, content, { createPath: true })

  try {
    await rename(tempPath, path)
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
}

function truncatePreview(input: string, max = 160): string {
  const clean = input.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) {
    return clean
  }
  return `${clean.slice(0, max - 14)}...(truncated)`
}

function normalizeLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_LIST_LIMIT
  }
  const normalized = Math.floor(value)
  if (normalized < 1) {
    return DEFAULT_LIST_LIMIT
  }
  return Math.min(normalized, MAX_LIST_LIMIT)
}

export async function callMemorySetTool(
  runtime: FunctionToolRuntime,
  rawArgs: unknown,
): Promise<string> {
  const args = asObject(rawArgs)
  const key = typeof args.key === 'string' ? args.key.trim() : ''
  const value = typeof args.value === 'string' ? args.value.trim() : ''
  if (!key) {
    return 'Invalid arguments: "key" must be a non-empty string.'
  }
  if (!value) {
    return 'Invalid arguments: "value" must be a non-empty string.'
  }

  const overwrite = args.overwrite !== false

  let store: MemoryStore
  try {
    store = await readMemoryStore(runtime)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `Read memory store failed: ${message}`
  }

  const existing = store.memories.find(item => item.key === key)
  const now = isoNow()
  if (existing) {
    if (!overwrite) {
      return `Memory key already exists: ${key}`
    }
    existing.value = value
    existing.updated_at = now
  } else {
    store.memories.push({
      key,
      value,
      created_at: now,
      updated_at: now,
    })
  }

  try {
    await writeMemoryStore(runtime, store)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `Write memory store failed: ${message}`
  }

  return [
    `key: ${key}`,
    `value: ${truncatePreview(value)}`,
    `status: ${existing ? 'updated' : 'created'}`,
    `path: .agents/memory.json`,
  ].join('\n')
}

export async function callMemoryListTool(
  runtime: FunctionToolRuntime,
  rawArgs: unknown,
): Promise<string> {
  const args = asObject(rawArgs)
  const key = typeof args.key === 'string' ? args.key.trim() : ''
  const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
  const limit = normalizeLimit(args.limit)

  let store: MemoryStore
  try {
    store = await readMemoryStore(runtime)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `Read memory store failed: ${message}`
  }

  let rows = [...store.memories]
  if (key) {
    rows = rows.filter(item => item.key === key)
  }
  if (query) {
    rows = rows.filter(item => {
      const keyHit = item.key.toLowerCase().includes(query)
      const valueHit = item.value.toLowerCase().includes(query)
      return keyHit || valueHit
    })
  }

  rows.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
  rows = rows.slice(0, limit)

  if (rows.length === 0) {
    return '(No memory)'
  }

  return [
    `count: ${rows.length}`,
    ...rows.map(item =>
      [
        `- ${item.key}`,
        `  value: ${truncatePreview(item.value)}`,
        `  updated_at: ${item.updated_at}`,
      ].join('\n'),
    ),
  ].join('\n')
}

export async function callMemoryDeleteTool(
  runtime: FunctionToolRuntime,
  rawArgs: unknown,
): Promise<string> {
  const args = asObject(rawArgs)
  const key = typeof args.key === 'string' ? args.key.trim() : ''
  if (!key) {
    return 'Invalid arguments: "key" must be a non-empty string.'
  }

  let store: MemoryStore
  try {
    store = await readMemoryStore(runtime)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `Read memory store failed: ${message}`
  }

  const index = store.memories.findIndex(item => item.key === key)
  if (index < 0) {
    return `Memory key not found: ${key}`
  }
  store.memories.splice(index, 1)

  try {
    await writeMemoryStore(runtime, store)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `Write memory store failed: ${message}`
  }

  return [`key: ${key}`, 'status: deleted', 'path: .agents/memory.json'].join('\n')
}

