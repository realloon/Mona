import path from 'node:path'
import type {
  FunctionToolCallHooks,
  FunctionToolOptions,
  FunctionToolRuntime,
  OpenAIFunctionTool,
} from '../types/tools.js'
import { callPatchTool, PATCH_FILE_TOOL, PATCH_TOOL_SCHEMA } from './patch.js'
import { callReadTool, READ_FILE_TOOL, READ_TOOL_SCHEMA } from './read.js'
import { callRunTool, RUN_TERMINAL_COMMAND, RUN_TOOL_SCHEMA } from './run.js'
import { callSearchTool, SEARCH_TOOL, SEARCH_TOOL_SCHEMA } from './search.js'
import {
  callTaskCreateTool,
  callTaskListTool,
  callTaskPauseTool,
  callTaskResumeTool,
  TASK_CREATE_TOOL,
  TASK_CREATE_TOOL_SCHEMA,
  TASK_LIST_TOOL,
  TASK_LIST_TOOL_SCHEMA,
  TASK_PAUSE_TOOL,
  TASK_PAUSE_TOOL_SCHEMA,
  TASK_RESUME_TOOL,
  TASK_RESUME_TOOL_SCHEMA,
} from './tasks.js'
import { callWriteTool, WRITE_FILE_TOOL, WRITE_TOOL_SCHEMA } from './write.js'

const MIN_TIMEOUT_MS = 100
const MAX_TIMEOUT_MS = 120000
const DEFAULT_TIMEOUT_MS = 15000
const MIN_OUTPUT_CHARS = 1000
const MAX_OUTPUT_CHARS = 100000
const DEFAULT_OUTPUT_CHARS = 12000

const OPENAI_TOOL_NAMES = new Set<string>([
  RUN_TERMINAL_COMMAND,
  READ_FILE_TOOL,
  WRITE_FILE_TOOL,
  PATCH_FILE_TOOL,
  SEARCH_TOOL,
  TASK_CREATE_TOOL,
  TASK_LIST_TOOL,
  TASK_PAUSE_TOOL,
  TASK_RESUME_TOOL,
])

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function normalizeTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_TIMEOUT_MS
  }
  return clamp(Math.floor(value), MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
}

function normalizeMaxOutput(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_OUTPUT_CHARS
  }
  return clamp(Math.floor(value), MIN_OUTPUT_CHARS, MAX_OUTPUT_CHARS)
}

const OPENAI_TOOLS: OpenAIFunctionTool[] = [
  RUN_TOOL_SCHEMA,
  READ_TOOL_SCHEMA,
  WRITE_TOOL_SCHEMA,
  PATCH_TOOL_SCHEMA,
  SEARCH_TOOL_SCHEMA,
  TASK_CREATE_TOOL_SCHEMA,
  TASK_LIST_TOOL_SCHEMA,
  TASK_PAUSE_TOOL_SCHEMA,
  TASK_RESUME_TOOL_SCHEMA,
]

export class FunctionToolManager {
  private readonly runtime: FunctionToolRuntime

  constructor(options: FunctionToolOptions) {
    this.runtime = {
      projectRoot: path.resolve(options.projectRoot),
      defaultTimeoutMs: normalizeTimeout(options.defaultTimeoutMs),
      maxOutputChars: normalizeMaxOutput(options.maxOutputChars),
    }
  }

  getStatusSummary(): string {
    return `Builtin tools: enabled (run/read/write/patch/search/task_create/task_list/task_pause/task_resume, timeout=${this.runtime.defaultTimeoutMs}ms, maxOutput=${this.runtime.maxOutputChars})`
  }

  hasOpenAITool(name: string): boolean {
    return OPENAI_TOOL_NAMES.has(name)
  }

  getOpenAITools(): OpenAIFunctionTool[] {
    return OPENAI_TOOLS
  }

  async callOpenAITool(
    name: string,
    rawArgs: unknown,
    hooks?: FunctionToolCallHooks,
  ): Promise<string> {
    if (name === RUN_TERMINAL_COMMAND) {
      return await callRunTool(this.runtime, rawArgs, hooks)
    }

    if (name === READ_FILE_TOOL) {
      return await callReadTool(this.runtime, rawArgs)
    }

    if (name === WRITE_FILE_TOOL) {
      return await callWriteTool(this.runtime, rawArgs)
    }

    if (name === PATCH_FILE_TOOL) {
      return await callPatchTool(this.runtime, rawArgs)
    }

    if (name === SEARCH_TOOL) {
      return await callSearchTool(this.runtime, rawArgs)
    }

    if (name === TASK_CREATE_TOOL) {
      return await callTaskCreateTool(this.runtime, rawArgs, hooks)
    }

    if (name === TASK_LIST_TOOL) {
      return await callTaskListTool(this.runtime, rawArgs)
    }

    if (name === TASK_PAUSE_TOOL) {
      return await callTaskPauseTool(this.runtime, rawArgs)
    }

    if (name === TASK_RESUME_TOOL) {
      return await callTaskResumeTool(this.runtime, rawArgs)
    }

    return `Unknown local tool: ${name}`
  }
}
