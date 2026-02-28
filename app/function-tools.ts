import path from 'node:path'

type OpenAIFunctionTool = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

type FunctionToolOptions = {
  projectRoot: string
  defaultTimeoutMs: number
  maxOutputChars: number
}

export type DangerousCommandRequest = {
  command: string
  cwd: string
  reason: string
}

export type FunctionToolCallHooks = {
  confirmDangerousCommand?: (
    request: DangerousCommandRequest,
  ) => Promise<boolean>
}

const RUN_TERMINAL_COMMAND = 'builtin__run'
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
    return `Terminal tool: enabled (timeout=${this.defaultTimeoutMs}ms, maxOutput=${this.maxOutputChars})`
  }

  hasOpenAITool(name: string): boolean {
    return name === RUN_TERMINAL_COMMAND
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
    ]
  }

  async callOpenAITool(
    name: string,
    rawArgs: unknown,
    hooks?: FunctionToolCallHooks,
  ): Promise<string> {
    if (name !== RUN_TERMINAL_COMMAND) {
      return `Unknown local tool: ${name}`
    }

    const args = asObject(rawArgs)
    const command = typeof args.command === 'string' ? args.command.trim() : ''
    if (!command) {
      return 'Invalid arguments: "command" must be a non-empty string.'
    }

    const requestedCwd = typeof args.cwd === 'string' ? args.cwd.trim() : ''
    const cwd = this.resolveAndValidateCwd(requestedCwd)
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

  private resolveAndValidateCwd(input: string): { ok: true; path: string } | { ok: false; error: string } {
    const base = this.projectRoot
    if (!input) {
      return { ok: true, path: base }
    }

    const resolved = path.resolve(base, input)
    const allowedPrefix = `${base}${path.sep}`
    if (resolved !== base && !resolved.startsWith(allowedPrefix)) {
      return {
        ok: false,
        error: `Invalid cwd: "${input}" resolves outside project root.`,
      }
    }

    return { ok: true, path: resolved }
  }
}
