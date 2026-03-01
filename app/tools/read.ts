import { file } from 'bun'
import type { OpenAIFunctionTool } from '../types/tools'
import { asObject } from '../utils/guards'
import { resolvePath, truncateText } from '../utils/shared'
import type { FunctionToolRuntime } from '../types/tools'

export const READ_FILE_TOOL = 'builtin__read'

export const READ_TOOL_SCHEMA: OpenAIFunctionTool = {
  type: 'function',
  function: {
    name: READ_FILE_TOOL,
    description: 'Read a text file.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
}

export async function callReadTool(
  runtime: FunctionToolRuntime,
  rawArgs: unknown,
): Promise<string> {
  const args = asObject(rawArgs)
  const rawPath = typeof args.path === 'string' ? args.path.trim() : ''
  if (!rawPath) {
    return 'Invalid arguments: "path" must be a non-empty string.'
  }

  const resolved = resolvePath(runtime, rawPath)

  const fileRef = file(resolved)
  if (!(await fileRef.exists())) {
    return `File not found: ${rawPath}`
  }

  try {
    const content = await fileRef.text()
    const text = truncateText(content, runtime.maxOutputChars)
    return [`path: ${rawPath}`, '', text || '(empty file)'].join('\n')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `Read file failed (${rawPath}): ${message}`
  }
}
