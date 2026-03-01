import { file, write } from 'bun'
import type { OpenAIFunctionTool } from '../types/tools'
import { asObject } from '../utils/guards'
import { resolvePath } from '../utils/shared'
import type { FunctionToolRuntime } from '../types/tools'

export const WRITE_FILE_TOOL = 'builtin__write'

export const WRITE_TOOL_SCHEMA: OpenAIFunctionTool = {
  type: 'function',
  function: {
    name: WRITE_FILE_TOOL,
    description: 'Write or append text to a file.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path.',
        },
        content: {
          type: 'string',
          description: 'Text content.',
        },
        mode: {
          type: 'string',
          enum: ['replace', 'append'],
          default: 'replace',
          description: 'Write mode.',
        },
        create_dirs: {
          type: 'boolean',
          default: true,
          description: 'Create parent directories.',
        },
        overwrite: {
          type: 'boolean',
          default: true,
          description: 'Overwrite existing file.',
        },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
}

export async function callWriteTool(
  runtime: FunctionToolRuntime,
  rawArgs: unknown,
): Promise<string> {
  const args = asObject(rawArgs)
  const rawPath = typeof args.path === 'string' ? args.path.trim() : ''
  if (!rawPath) {
    return 'Invalid arguments: "path" must be a non-empty string.'
  }

  const content = typeof args.content === 'string' ? args.content : ''
  const modeRaw = typeof args.mode === 'string' ? args.mode.trim() : ''
  const mode = modeRaw === 'append' ? 'append' : 'replace'
  const createDirs = args.create_dirs !== false
  const overwrite = args.overwrite !== false

  const resolved = resolvePath(runtime, rawPath)

  const fileRef = file(resolved)
  const exists = await fileRef.exists()

  if (mode === 'replace' && exists && !overwrite) {
    return `Refused to overwrite existing file: ${rawPath}`
  }

  try {
    const writeOptions = { createPath: createDirs }
    if (mode === 'append') {
      if (exists) {
        const stat = await fileRef.stat()
        const tail = file(resolved).slice(stat.size)
        await write(tail, content)
      } else {
        await write(resolved, content, writeOptions)
      }
    } else {
      await write(resolved, content, writeOptions)
    }

    return [
      `path: ${rawPath}`,
      `mode: ${mode}`,
      `bytes_written: ${content.length}`,
    ].join('\n')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `Edit file failed (${rawPath}): ${message}`
  }
}
