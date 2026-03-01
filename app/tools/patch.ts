import { file, write } from 'bun'
import type { OpenAIFunctionTool } from '../types/tools.js'
import { asObject, asStringArray } from '../utils/guards.js'
import { resolvePath } from '../utils/shared.js'
import type { FunctionToolRuntime } from '../types/tools.js'

export const PATCH_FILE_TOOL = 'builtin__patch'
const MAX_PATCH_HUNKS = 200

export const PATCH_TOOL_SCHEMA: OpenAIFunctionTool = {
  type: 'function',
  function: {
    name: PATCH_FILE_TOOL,
    description: 'Apply line-based patch hunks to a text file.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path.',
        },
        hunks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              start_line: {
                type: 'integer',
                minimum: 1,
              },
              delete_count: {
                type: 'integer',
                minimum: 0,
              },
              insert_lines: {
                type: 'array',
                items: { type: 'string' },
              },
            },
            required: ['start_line', 'delete_count', 'insert_lines'],
            additionalProperties: false,
          },
        },
        strict: {
          type: 'boolean',
          default: true,
          description: 'Strict bounds checking.',
        },
      },
      required: ['path', 'hunks'],
      additionalProperties: false,
    },
  },
}

type ParsedPatchHunk = {
  startLine: number
  deleteCount: number
  insertLines: string[]
}

function parsePatchHunks(raw: unknown): ParsedPatchHunk[] | string {
  if (!Array.isArray(raw)) {
    return 'Invalid arguments: "hunks" must be an array.'
  }
  if (raw.length === 0) {
    return 'Invalid arguments: "hunks" must not be empty.'
  }
  if (raw.length > MAX_PATCH_HUNKS) {
    return `Invalid arguments: too many hunks (${raw.length}), max is ${MAX_PATCH_HUNKS}.`
  }

  const parsed: ParsedPatchHunk[] = []
  for (let idx = 0; idx < raw.length; idx += 1) {
    const item = raw[idx]
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return `Invalid hunk at index ${idx}: expected object.`
    }
    const obj = item as Record<string, unknown>
    const startLineRaw = obj.start_line
    const deleteCountRaw = obj.delete_count
    const insertLinesRaw = obj.insert_lines

    if (
      typeof startLineRaw !== 'number' ||
      !Number.isInteger(startLineRaw) ||
      startLineRaw < 1
    ) {
      return `Invalid hunk at index ${idx}: "start_line" must be an integer >= 1.`
    }
    if (
      typeof deleteCountRaw !== 'number' ||
      !Number.isInteger(deleteCountRaw) ||
      deleteCountRaw < 0
    ) {
      return `Invalid hunk at index ${idx}: "delete_count" must be an integer >= 0.`
    }

    const insertLines = asStringArray(insertLinesRaw)
    if (!insertLines) {
      return `Invalid hunk at index ${idx}: "insert_lines" must be a string array.`
    }
    if (insertLines.some(line => line.includes('\n') || line.includes('\r'))) {
      return `Invalid hunk at index ${idx}: "insert_lines" entries must not contain newline characters.`
    }

    parsed.push({
      startLine: startLineRaw,
      deleteCount: deleteCountRaw,
      insertLines,
    })
  }

  return parsed
}

export async function callPatchTool(
  runtime: FunctionToolRuntime,
  rawArgs: unknown,
): Promise<string> {
  const args = asObject(rawArgs)
  const rawPath = typeof args.path === 'string' ? args.path.trim() : ''
  if (!rawPath) {
    return 'Invalid arguments: "path" must be a non-empty string.'
  }

  const parsedHunks = parsePatchHunks(args.hunks)
  if (typeof parsedHunks === 'string') {
    return parsedHunks
  }
  const strict = args.strict !== false

  const resolved = resolvePath(runtime, rawPath)

  const fileRef = file(resolved)
  if (!(await fileRef.exists())) {
    return `File not found: ${rawPath}`
  }

  try {
    const original = await fileRef.text()
    const normalized = original.replace(/\r\n/g, '\n')
    const hasTrailingNewline = normalized.endsWith('\n')
    const body = hasTrailingNewline ? normalized.slice(0, -1) : normalized
    const lines = body.length === 0 ? [] : body.split('\n')

    const hunks = [...parsedHunks].sort(
      (a, b) => b.startLine - a.startLine || b.deleteCount - a.deleteCount,
    )

    for (let idx = 0; idx < hunks.length; idx += 1) {
      const hunk = hunks[idx]
      const startIndex = hunk.startLine - 1
      if (startIndex > lines.length) {
        return `Patch failed at hunk ${idx}: start_line ${hunk.startLine} is out of range (line count ${lines.length}).`
      }

      const maxDeletable = Math.max(0, lines.length - startIndex)
      if (strict && hunk.deleteCount > maxDeletable) {
        return `Patch failed at hunk ${idx}: delete_count ${hunk.deleteCount} exceeds available lines ${maxDeletable}.`
      }

      const actualDeleteCount = strict
        ? hunk.deleteCount
        : Math.min(hunk.deleteCount, maxDeletable)

      lines.splice(startIndex, actualDeleteCount, ...hunk.insertLines)
    }

    const nextBody = lines.join('\n')
    const nextContent =
      hasTrailingNewline && lines.length > 0 ? `${nextBody}\n` : nextBody
    await write(resolved, nextContent, { createPath: false })

    return [
      `path: ${rawPath}`,
      `hunks_applied: ${hunks.length}`,
      `strict: ${strict}`,
      `line_count: ${lines.length}`,
    ].join('\n')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `Patch failed (${rawPath}): ${message}`
  }
}
