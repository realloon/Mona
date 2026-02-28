import path from 'node:path'
import type {
  DangerousCommandRequest,
  FunctionToolCallHooks,
  OpenAIFunctionTool,
} from './types/tools.js'

type FunctionToolOptions = {
  projectRoot: string
  defaultTimeoutMs: number
  maxOutputChars: number
}


const RUN_TERMINAL_COMMAND = 'builtin__run'
const READ_FILE_TOOL = 'builtin__read'
const EDIT_FILE_TOOL = 'builtin__edit'
const PATCH_FILE_TOOL = 'builtin__patch'
const MIN_TIMEOUT_MS = 100
const MAX_TIMEOUT_MS = 120000
const MAX_PATCH_HUNKS = 200

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function normalizePositiveInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }
  const rounded = Math.floor(value)
  return clamp(rounded, min, max)
}

function truncateText(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input
  }
  return `${input.slice(0, Math.max(0, maxChars - 21))}\n...(truncated output)`
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asLineArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null
  }
  if (!value.every(v => typeof v === 'string')) {
    return null
  }
  return value as string[]
}

type ParsedPatchHunk = {
  startLine: number
  deleteCount: number
  insertLines: string[]
}

function detectDangerousCommand(command: string): string | null {
  const normalized = command.toLowerCase()
  const rules: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /\brm\b/, reason: 'contains rm' },
    { pattern: /\bmkfs(\.[a-z0-9]+)?\b/, reason: 'contains mkfs' },
    { pattern: /\bdd\b/, reason: 'contains dd' },
    { pattern: /\b(?:shutdown|reboot|poweroff|halt)\b/, reason: 'system power command' },
    { pattern: /\bkill(all)?\b/, reason: 'process termination command' },
    { pattern: /\bchown\b[^|&;]*\s-r\b|\bchown\b[^|&;]*\s--recursive\b/, reason: 'recursive ownership change' },
    { pattern: /\bchmod\b[^|&;]*\s-r\b|\bchmod\b[^|&;]*\s--recursive\b/, reason: 'recursive mode change' },
    { pattern: /\bsudo\b/, reason: 'contains sudo' },
  ]

  for (const rule of rules) {
    if (rule.pattern.test(normalized)) {
      return rule.reason
    }
  }
  return null
}

export class FunctionToolManager {
  private readonly projectRoot: string
  private readonly defaultTimeoutMs: number
  private readonly maxOutputChars: number

  constructor(options: FunctionToolOptions) {
    this.projectRoot = path.resolve(options.projectRoot)
    this.defaultTimeoutMs = normalizePositiveInt(
      options.defaultTimeoutMs,
      15000,
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    )
    this.maxOutputChars = normalizePositiveInt(
      options.maxOutputChars,
      12000,
      1000,
      100000,
    )
  }

  getStatusSummary(): string {
    return `Builtin tools: enabled (run/read/edit/patch, timeout=${this.defaultTimeoutMs}ms, maxOutput=${this.maxOutputChars})`
  }

  hasOpenAITool(name: string): boolean {
    return (
      name === RUN_TERMINAL_COMMAND ||
      name === READ_FILE_TOOL ||
      name === EDIT_FILE_TOOL ||
      name === PATCH_FILE_TOOL
    )
  }

  getOpenAITools(): OpenAIFunctionTool[] {
    return [
      {
        type: 'function',
        function: {
          name: RUN_TERMINAL_COMMAND,
          description: 'Run a command.',
          parameters: {
            type: 'object',
            properties: {
              command: {
                type: 'string',
                description: 'Command text.',
              },
              cwd: {
                type: 'string',
                description: 'Working directory path.',
              },
              timeout_ms: {
                type: 'integer',
                minimum: MIN_TIMEOUT_MS,
                maximum: MAX_TIMEOUT_MS,
                default: 15000,
                description: 'Timeout in milliseconds.',
              },
            },
            required: ['command'],
            additionalProperties: false,
          },
        },
      },
      {
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
      },
      {
        type: 'function',
        function: {
          name: EDIT_FILE_TOOL,
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
      },
      {
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
      },
    ]
  }

  async callOpenAITool(
    name: string,
    rawArgs: unknown,
    hooks?: FunctionToolCallHooks,
  ): Promise<string> {
    if (name === RUN_TERMINAL_COMMAND) {
      return await this.callRunTool(rawArgs, hooks)
    }

    if (name === READ_FILE_TOOL) {
      return await this.callReadTool(rawArgs)
    }

    if (name === EDIT_FILE_TOOL) {
      return await this.callEditTool(rawArgs)
    }

    if (name === PATCH_FILE_TOOL) {
      return await this.callPatchTool(rawArgs)
    }

    return `Unknown local tool: ${name}`
  }

  private async callRunTool(
    rawArgs: unknown,
    hooks?: FunctionToolCallHooks,
  ): Promise<string> {
    const args = asObject(rawArgs)
    const command = typeof args.command === 'string' ? args.command.trim() : ''
    if (!command) {
      return 'Invalid arguments: "command" must be a non-empty string.'
    }

    const requestedCwd = typeof args.cwd === 'string' ? args.cwd.trim() : ''
    const cwd = this.resolvePath(requestedCwd)

    const timeoutMs = normalizePositiveInt(
      args.timeout_ms,
      this.defaultTimeoutMs,
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    )

    const dangerousReason = detectDangerousCommand(command)
    if (dangerousReason) {
      const approved = await hooks?.confirmDangerousCommand?.({
        command,
        cwd,
        reason: dangerousReason,
      })
      if (!approved) {
        return `Execution denied: command requires confirmation (${dangerousReason}).`
      }
    }

    const proc = Bun.spawn({
      cmd: ['/bin/sh', '-lc', command],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    })

    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      proc.kill()
    }, timeoutMs)

    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])

      const stdoutSafe = truncateText(stdout, this.maxOutputChars)
      const stderrSafe = truncateText(stderr, this.maxOutputChars)

      return [
        `command: ${command}`,
        `cwd: ${cwd}`,
        `timed_out: ${timedOut}`,
        `exit_code: ${exitCode}`,
        '',
        'stdout:',
        stdoutSafe || '(empty)',
        '',
        'stderr:',
        stderrSafe || '(empty)',
      ].join('\n')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return `Terminal command failed: ${message}`
    } finally {
      clearTimeout(timeout)
    }
  }

  private async callReadTool(rawArgs: unknown): Promise<string> {
    const args = asObject(rawArgs)
    const rawPath = typeof args.path === 'string' ? args.path.trim() : ''
    if (!rawPath) {
      return 'Invalid arguments: "path" must be a non-empty string.'
    }

    const resolved = this.resolvePath(rawPath)

    const file = Bun.file(resolved)
    if (!(await file.exists())) {
      return `File not found: ${rawPath}`
    }

    try {
      const content = await file.text()
      const text = truncateText(content, this.maxOutputChars)
      return [`path: ${rawPath}`, '', text || '(empty file)'].join('\n')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return `Read file failed (${rawPath}): ${message}`
    }
  }

  private parsePatchHunks(raw: unknown): ParsedPatchHunk[] | string {
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

      const insertLines = asLineArray(insertLinesRaw)
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

  private async callPatchTool(rawArgs: unknown): Promise<string> {
    const args = asObject(rawArgs)
    const rawPath = typeof args.path === 'string' ? args.path.trim() : ''
    if (!rawPath) {
      return 'Invalid arguments: "path" must be a non-empty string.'
    }

    const parsedHunks = this.parsePatchHunks(args.hunks)
    if (typeof parsedHunks === 'string') {
      return parsedHunks
    }
    const strict = args.strict !== false

    const resolved = this.resolvePath(rawPath)

    const file = Bun.file(resolved)
    if (!(await file.exists())) {
      return `File not found: ${rawPath}`
    }

    try {
      const original = await file.text()
      const normalized = original.replace(/\r\n/g, '\n')
      const hasTrailingNewline = normalized.endsWith('\n')
      const body = hasTrailingNewline ? normalized.slice(0, -1) : normalized
      const lines = body.length === 0 ? [] : body.split('\n')

      // Apply from bottom to top so line numbers stay stable.
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
      await Bun.write(resolved, nextContent, { createPath: false })

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

  private async callEditTool(rawArgs: unknown): Promise<string> {
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

    const resolved = this.resolvePath(rawPath)

    const file = Bun.file(resolved)
    const exists = await file.exists()

    if (mode === 'replace' && exists && !overwrite) {
      return `Refused to overwrite existing file: ${rawPath}`
    }

    try {
      const writeOptions = { createPath: createDirs }
      if (mode === 'append') {
        if (exists) {
          const stat = await file.stat()
          const tail = Bun.file(resolved).slice(stat.size)
          await Bun.write(tail, content)
        } else {
          await Bun.write(resolved, content, writeOptions)
        }
      } else {
        await Bun.write(resolved, content, writeOptions)
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

  private resolvePath(input: string): string {
    const base = this.projectRoot
    if (!input) {
      return base
    }

    if (path.isAbsolute(input)) {
      return path.normalize(input)
    }
    return path.resolve(base, input)
  }
}
