import { spawn } from 'bun'
import type {
  FunctionToolCallHooks,
  OpenAIFunctionTool,
} from '../types/tools'
import { asObject } from '../utils/guards'
import {
  resolvePath,
  truncateText,
} from '../utils/shared'
import type { FunctionToolRuntime } from '../types/tools'

export const RUN_TERMINAL_COMMAND = 'builtin__run'
const MIN_TIMEOUT_MS = 100
const MAX_TIMEOUT_MS = 120000
const DEFAULT_TIMEOUT_MS = 15000

export const RUN_TOOL_SCHEMA: OpenAIFunctionTool = {
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
          default: DEFAULT_TIMEOUT_MS,
          description: 'Timeout in milliseconds.',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function normalizeTimeout(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return clamp(fallback, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
  }
  return clamp(Math.floor(value), MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
}

function detectDangerousCommand(command: string): string | null {
  const normalized = command.toLowerCase()
  const rules: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /\brm\b/, reason: 'contains rm' },
    { pattern: /\bmkfs(\.[a-z0-9]+)?\b/, reason: 'contains mkfs' },
    { pattern: /\bdd\b/, reason: 'contains dd' },
    {
      pattern: /\b(?:shutdown|reboot|poweroff|halt)\b/,
      reason: 'system power command',
    },
    { pattern: /\bkill(all)?\b/, reason: 'process termination command' },
    {
      pattern: /\bchown\b[^|&;]*\s-r\b|\bchown\b[^|&;]*\s--recursive\b/,
      reason: 'recursive ownership change',
    },
    {
      pattern: /\bchmod\b[^|&;]*\s-r\b|\bchmod\b[^|&;]*\s--recursive\b/,
      reason: 'recursive mode change',
    },
    { pattern: /\bsudo\b/, reason: 'contains sudo' },
  ]

  for (const rule of rules) {
    if (rule.pattern.test(normalized)) {
      return rule.reason
    }
  }
  return null
}

export async function callRunTool(
  runtime: FunctionToolRuntime,
  rawArgs: unknown,
  hooks?: FunctionToolCallHooks,
): Promise<string> {
  const args = asObject(rawArgs)
  const command = typeof args.command === 'string' ? args.command.trim() : ''
  if (!command) {
    return 'Invalid arguments: "command" must be a non-empty string.'
  }

  const requestedCwd = typeof args.cwd === 'string' ? args.cwd.trim() : ''
  const cwd = resolvePath(runtime, requestedCwd)
  const timeoutMs = normalizeTimeout(args.timeout_ms, runtime.defaultTimeoutMs)

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

  const proc = spawn({
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

    const stdoutSafe = truncateText(stdout, runtime.maxOutputChars)
    const stderrSafe = truncateText(stderr, runtime.maxOutputChars)

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
