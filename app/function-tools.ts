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
const MIN_TIMEOUT_MS = 100
const MAX_TIMEOUT_MS = 120000

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
    return `Builtin tools: enabled (run/read/edit, timeout=${this.defaultTimeoutMs}ms, maxOutput=${this.maxOutputChars})`
  }

  hasOpenAITool(name: string): boolean {
    return (
      name === RUN_TERMINAL_COMMAND ||
      name === READ_FILE_TOOL ||
      name === EDIT_FILE_TOOL
    )
  }

  getOpenAITools(): OpenAIFunctionTool[] {
    return [
      {
        type: 'function',
        function: {
          name: RUN_TERMINAL_COMMAND,
          description:
            'Execute a shell command in the local project workspace and return stdout/stderr.',
          parameters: {
            type: 'object',
            properties: {
              command: {
                type: 'string',
                description: 'Command string executed with /bin/sh -lc "<command>".',
              },
              cwd: {
                type: 'string',
                description:
                  'Optional working directory; relative paths are resolved from project root.',
              },
              timeout_ms: {
                type: 'integer',
                minimum: MIN_TIMEOUT_MS,
                maximum: MAX_TIMEOUT_MS,
                description: `Optional timeout in ms (${MIN_TIMEOUT_MS}-${MAX_TIMEOUT_MS}).`,
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
          description:
            'Read a UTF-8 text file under the project root and return its content.',
          parameters: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'File path relative to project root.',
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
          description:
            'Create or edit a UTF-8 text file under the project root. Supports replace or append.',
          parameters: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'File path relative to project root.',
              },
              content: {
                type: 'string',
                description: 'Text content to write or append.',
              },
              mode: {
                type: 'string',
                enum: ['replace', 'append'],
                description: 'Write mode. Defaults to replace.',
              },
              create_dirs: {
                type: 'boolean',
                description: 'Whether to create parent directories if missing. Defaults to true.',
              },
              overwrite: {
                type: 'boolean',
                description:
                  'When mode=replace, whether to overwrite existing file. Defaults to true.',
              },
            },
            required: ['path', 'content'],
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
    const cwd = this.resolveAndValidatePath(requestedCwd)
    if (cwd.ok === false) {
      return cwd.error
    }

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
        cwd: cwd.path,
        reason: dangerousReason,
      })
      if (!approved) {
        return `Execution denied: command requires confirmation (${dangerousReason}).`
      }
    }

    const proc = Bun.spawn({
      cmd: ['/bin/sh', '-lc', command],
      cwd: cwd.path,
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
        `cwd: ${cwd.path}`,
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

    const resolved = this.resolveAndValidatePath(rawPath)
    if (resolved.ok === false) {
      return resolved.error
    }

    const file = Bun.file(resolved.path)
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

    const resolved = this.resolveAndValidatePath(rawPath)
    if (resolved.ok === false) {
      return resolved.error
    }

    const file = Bun.file(resolved.path)
    const exists = await file.exists()

    if (mode === 'replace' && exists && !overwrite) {
      return `Refused to overwrite existing file: ${rawPath}`
    }

    try {
      const writeOptions = { createPath: createDirs }
      if (mode === 'append') {
        const previous = exists ? await file.text() : ''
        await Bun.write(resolved.path, `${previous}${content}`, writeOptions)
      } else {
        await Bun.write(resolved.path, content, writeOptions)
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

  private resolveAndValidatePath(
    input: string,
  ): { ok: true; path: string } | { ok: false; error: string } {
    const base = this.projectRoot
    if (!input) {
      return { ok: true, path: base }
    }

    const resolved = path.resolve(base, input)
    const allowedPrefix = `${base}${path.sep}`
    if (resolved !== base && !resolved.startsWith(allowedPrefix)) {
      return {
        ok: false,
        error: `Invalid path: "${input}" resolves outside project root.`,
      }
    }

    return { ok: true, path: resolved }
  }
}
