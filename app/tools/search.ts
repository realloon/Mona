import { spawn } from 'bun'
import type { OpenAIFunctionTool } from '../types/tools.js'
import type { FunctionToolRuntime } from '../types/tools.js'
import { asObject, asStringArray } from '../utils/guards.js'
import { resolvePath, truncateText } from '../utils/shared.js'

export const SEARCH_TOOL = 'builtin__search'
const DEFAULT_SEARCH_RESULTS = 50
const MAX_SEARCH_RESULTS = 500

export const SEARCH_TOOL_SCHEMA: OpenAIFunctionTool = {
  type: 'function',
  function: {
    name: SEARCH_TOOL,
    description: 'Search text with ripgrep.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query.',
        },
        path: {
          type: 'string',
          default: '.',
          description: 'Search target path.',
        },
        glob: {
          type: 'array',
          items: { type: 'string' },
          description: 'Glob filters.',
        },
        max_results: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_SEARCH_RESULTS,
          default: DEFAULT_SEARCH_RESULTS,
          description: 'Maximum result lines.',
        },
        case_sensitive: {
          type: 'boolean',
          default: false,
          description: 'Case-sensitive search.',
        },
        regex: {
          type: 'boolean',
          default: false,
          description: 'Use regex pattern.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function normalizeMaxResults(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_SEARCH_RESULTS
  }
  const rounded = Math.floor(value)
  return clamp(rounded, 1, MAX_SEARCH_RESULTS)
}

export async function callSearchTool(
  runtime: FunctionToolRuntime,
  rawArgs: unknown,
): Promise<string> {
  const args = asObject(rawArgs)
  const query = typeof args.query === 'string' ? args.query.trim() : ''
  if (!query) {
    return 'Invalid arguments: "query" must be a non-empty string.'
  }

  const targetPathRaw = typeof args.path === 'string' ? args.path.trim() : ''
  const targetPath = resolvePath(runtime, targetPathRaw || '.')
  const maxResults = normalizeMaxResults(args.max_results)
  const caseSensitive = args.case_sensitive === true
  const regex = args.regex === true

  const glob = asStringArray(args.glob)
  if (args.glob !== undefined && glob === null) {
    return 'Invalid arguments: "glob" must be a string array.'
  }

  const cmd = [
    'rg',
    '--line-number',
    '--no-heading',
    '--color',
    'never',
    '--max-count',
    String(maxResults),
    ...(caseSensitive ? [] : ['-i']),
    ...(regex ? [] : ['-F']),
  ]

  if (glob) {
    for (const pattern of glob) {
      const trimmed = pattern.trim()
      if (!trimmed) {
        continue
      }
      cmd.push('--glob', trimmed)
    }
  }

  cmd.push(query, targetPath)

  try {
    const proc = spawn({
      cmd,
      cwd: runtime.projectRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])

    if (exitCode === 0) {
      const output = truncateText(stdout.trim(), runtime.maxOutputChars)
      return output || '(No matches)'
    }
    if (exitCode === 1) {
      return '(No matches)'
    }

    const errText = stderr.trim() || stdout.trim() || `exit code ${exitCode}`
    if (
      errText.includes('No such file or directory') &&
      errText.includes('rg')
    ) {
      return 'Search tool unavailable: "rg" is not installed.'
    }
    return `Search failed: ${truncateText(errText, runtime.maxOutputChars)}`
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('No such file or directory')) {
      return 'Search tool unavailable: "rg" is not installed.'
    }
    return `Search failed: ${message}`
  }
}
