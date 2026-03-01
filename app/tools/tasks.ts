import { file, write } from 'bun'
import { rename, rm } from 'node:fs/promises'
import type { OpenAIFunctionTool } from '../types/tools'
import { asObject } from '../utils/guards'
import type {
  FunctionToolCallHooks,
  FunctionToolRuntime,
} from '../types/tools'

export const TASK_CREATE_TOOL = 'builtin__task_create'
export const TASK_LIST_TOOL = 'builtin__task_list'
export const TASK_PAUSE_TOOL = 'builtin__task_pause'
export const TASK_RESUME_TOOL = 'builtin__task_resume'

const MAX_DELAY_MINUTES = 60 * 24 * 365
export const LOCAL_TIMEZONE =
  Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

export type OnceDelaySchedule = {
  kind: 'once_delay'
  minutes: number
}

export type DailyAtSchedule = {
  kind: 'daily_at'
  hour: number
  minute: number
  timezone: string
}

export type TaskSchedule = OnceDelaySchedule | DailyAtSchedule

export type TaskLastStatus = 'idle' | 'running' | 'success' | 'failed'

export type TaskRecord = {
  id: string
  name: string
  enabled: boolean
  channel_id: string
  creator_user_id: string
  schedule: TaskSchedule
  prompt: string
  model?: string
  next_run_at: string
  last_run_started_at: string | null
  last_run_at: string | null
  last_status: TaskLastStatus
  last_error: string | null
  created_at: string
  updated_at: string
}

export type TaskStore = {
  tasks: TaskRecord[]
}

export const TASK_CREATE_TOOL_SCHEMA: OpenAIFunctionTool = {
  type: 'function',
  function: {
    name: TASK_CREATE_TOOL,
    description:
      'Create a scheduled LLM task persisted in .agents/tasks.json. Requires prompt. Supports "五分钟后" and "每天早上6点".',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Task name.',
        },
        channel_id: {
          type: 'string',
          description:
            'Discord channel id to deliver task result. If omitted, tool runtime may inject from message context.',
        },
        creator_user_id: {
          type: 'string',
          description:
            'Creator user id. If omitted, tool runtime may inject from message context.',
        },
        schedule_text: {
          type: 'string',
          description:
            'Natural schedule text, e.g. "五分钟后", "10分钟后", "每天早上6点", "每天 06:30".',
        },
        schedule: {
          type: 'object',
          description:
            'Structured schedule. kind=once_delay requires minutes. kind=daily_at requires hour/minute/timezone(optional).',
          properties: {
            kind: {
              type: 'string',
              enum: ['once_delay', 'daily_at'],
            },
            minutes: {
              type: 'integer',
              minimum: 1,
              maximum: MAX_DELAY_MINUTES,
            },
            hour: {
              type: 'integer',
              minimum: 0,
              maximum: 23,
            },
            minute: {
              type: 'integer',
              minimum: 0,
              maximum: 59,
            },
            timezone: {
              type: 'string',
            },
          },
          additionalProperties: false,
        },
        prompt: {
          type: 'string',
          description: 'LLM prompt to execute at runtime.',
        },
        model: {
          type: 'string',
          description: 'Optional override model for this task.',
        },
        enabled: {
          type: 'boolean',
          default: true,
        },
        timezone: {
          type: 'string',
          description:
            `Timezone for daily schedules. Current runtime supports local timezone only (${LOCAL_TIMEZONE}).`,
        },
      },
      required: ['name', 'prompt'],
      additionalProperties: false,
    },
  },
}

export const TASK_LIST_TOOL_SCHEMA: OpenAIFunctionTool = {
  type: 'function',
  function: {
    name: TASK_LIST_TOOL,
    description: 'List scheduled tasks.',
    parameters: {
      type: 'object',
      properties: {
        enabled_only: {
          type: 'boolean',
          default: false,
        },
      },
      additionalProperties: false,
    },
  },
}

export const TASK_PAUSE_TOOL_SCHEMA: OpenAIFunctionTool = {
  type: 'function',
  function: {
    name: TASK_PAUSE_TOOL,
    description: 'Pause one task by id.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Task id.',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
}

export const TASK_RESUME_TOOL_SCHEMA: OpenAIFunctionTool = {
  type: 'function',
  function: {
    name: TASK_RESUME_TOOL,
    description: 'Resume one task by id and refresh next_run_at if needed.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Task id.',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
}

const CN_DIGITS: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
}

function getTaskStorePath(runtime: FunctionToolRuntime): string {
  return `${runtime.projectRoot}/.agents/tasks.json`
}

export function getTaskStorePathFromProjectRoot(projectRoot: string): string {
  return `${projectRoot}/.agents/tasks.json`
}

function isoNow(): string {
  return new Date().toISOString()
}

function asInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }
  if (!Number.isInteger(value)) {
    return null
  }
  return value
}

function parseNumberToken(input: string): number | null {
  const token = input.trim()
  if (!token) {
    return null
  }

  if (/^\d+$/.test(token)) {
    const parsed = Number.parseInt(token, 10)
    return Number.isFinite(parsed) ? parsed : null
  }

  if (token === '十') {
    return 10
  }

  if (token.includes('十')) {
    const parts = token.split('十')
    if (parts.length !== 2) {
      return null
    }
    const left = parts[0]
    const right = parts[1]
    const tens = left ? CN_DIGITS[left] : 1
    if (tens === undefined) {
      return null
    }
    if (!right) {
      return tens * 10
    }
    const ones = CN_DIGITS[right]
    if (ones === undefined) {
      return null
    }
    return tens * 10 + ones
  }

  if (token.length === 1) {
    const single = CN_DIGITS[token]
    return single === undefined ? null : single
  }

  return null
}

function ensureLocalTimezone(timezone: string): string | null {
  const trimmed = timezone.trim()
  if (!trimmed) {
    return LOCAL_TIMEZONE
  }
  if (trimmed !== LOCAL_TIMEZONE) {
    return null
  }
  return trimmed
}

export function computeNextRunAt(schedule: TaskSchedule, now: Date): Date {
  if (schedule.kind === 'once_delay') {
    return new Date(now.getTime() + schedule.minutes * 60_000)
  }

  const candidate = new Date(now.getTime())
  candidate.setHours(schedule.hour, schedule.minute, 0, 0)
  if (candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 1)
  }
  return candidate
}

function formatSchedule(schedule: TaskSchedule): string {
  if (schedule.kind === 'once_delay') {
    return `once_delay(${schedule.minutes}m)`
  }
  return `daily_at(${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')} ${schedule.timezone})`
}

function parseScheduleFromText(
  scheduleText: string,
  timezone: string,
): { schedule?: TaskSchedule; error?: string } {
  const normalized = scheduleText.replace(/\s+/g, '').trim()
  if (!normalized) {
    return {
      error: 'Invalid schedule_text: must be non-empty.',
    }
  }

  const minuteMatch = normalized.match(
    /^([零〇一二两三四五六七八九十\d]+)分钟后$/,
  )
  if (minuteMatch?.[1]) {
    const minutes = parseNumberToken(minuteMatch[1])
    if (!minutes || minutes < 1 || minutes > MAX_DELAY_MINUTES) {
      return {
        error: `Invalid minutes in schedule_text: ${minuteMatch[1]}`,
      }
    }
    return {
      schedule: { kind: 'once_delay', minutes },
    }
  }

  const hourDelayMatch = normalized.match(
    /^([零〇一二两三四五六七八九十\d]+)小时后$/,
  )
  if (hourDelayMatch?.[1]) {
    const hours = parseNumberToken(hourDelayMatch[1])
    if (!hours) {
      return {
        error: `Invalid hours in schedule_text: ${hourDelayMatch[1]}`,
      }
    }
    const minutes = hours * 60
    if (minutes < 1 || minutes > MAX_DELAY_MINUTES) {
      return {
        error: `Invalid delay in schedule_text: ${hourDelayMatch[1]}小时后`,
      }
    }
    return {
      schedule: { kind: 'once_delay', minutes },
    }
  }

  const dailyCnMatch = normalized.match(
    /^每天(?:早上|上午)?([零〇一二两三四五六七八九十\d]+)点(?:([零〇一二两三四五六七八九十\d]+)分?)?$/,
  )
  if (dailyCnMatch?.[1]) {
    const hour = parseNumberToken(dailyCnMatch[1])
    const minute = dailyCnMatch[2] ? parseNumberToken(dailyCnMatch[2]) : 0
    const validTimezone = ensureLocalTimezone(timezone)
    if (validTimezone === null) {
      return {
        error: `Unsupported timezone: ${timezone}. Only local timezone is supported now: ${LOCAL_TIMEZONE}.`,
      }
    }
    if (
      hour === null ||
      minute === null ||
      hour < 0 ||
      hour > 23 ||
      minute < 0 ||
      minute > 59
    ) {
      return {
        error: `Invalid daily time in schedule_text: ${scheduleText}`,
      }
    }
    return {
      schedule: {
        kind: 'daily_at',
        hour,
        minute,
        timezone: validTimezone,
      },
    }
  }

  const dailyHmMatch = normalized.match(/^每天([0-2]?\d):([0-5]?\d)$/)
  if (dailyHmMatch?.[1] && dailyHmMatch?.[2]) {
    const hour = Number.parseInt(dailyHmMatch[1], 10)
    const minute = Number.parseInt(dailyHmMatch[2], 10)
    const validTimezone = ensureLocalTimezone(timezone)
    if (validTimezone === null) {
      return {
        error: `Unsupported timezone: ${timezone}. Only local timezone is supported now: ${LOCAL_TIMEZONE}.`,
      }
    }
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      return {
        error: `Invalid daily time in schedule_text: ${scheduleText}`,
      }
    }
    return {
      schedule: {
        kind: 'daily_at',
        hour,
        minute,
        timezone: validTimezone,
      },
    }
  }

  return {
    error:
      'Unsupported schedule_text. Supported examples: "五分钟后", "10分钟后", "2小时后", "每天早上6点", "每天 06:30".',
  }
}

function parseScheduleFromStructured(
  raw: unknown,
  timezoneFallback: string,
): { schedule?: TaskSchedule; error?: string } {
  const schedule = asObject(raw)
  const kind = typeof schedule.kind === 'string' ? schedule.kind.trim() : ''
  if (!kind) {
    return {
      error:
        'Invalid schedule: "kind" is required when using structured schedule.',
    }
  }

  if (kind === 'once_delay') {
    const minutes = asInteger(schedule.minutes)
    if (!minutes || minutes < 1 || minutes > MAX_DELAY_MINUTES) {
      return {
        error: `"schedule.minutes" must be an integer between 1 and ${MAX_DELAY_MINUTES}.`,
      }
    }
    return {
      schedule: { kind: 'once_delay', minutes },
    }
  }

  if (kind === 'daily_at') {
    const hour = asInteger(schedule.hour)
    const minute = asInteger(schedule.minute)
    const timezoneRaw =
      typeof schedule.timezone === 'string' ? schedule.timezone : timezoneFallback
    const validTimezone = ensureLocalTimezone(timezoneRaw)
    if (validTimezone === null) {
      return {
        error: `Unsupported timezone: ${timezoneRaw}. Only local timezone is supported now: ${LOCAL_TIMEZONE}.`,
      }
    }
    if (
      hour === null ||
      minute === null ||
      hour < 0 ||
      hour > 23 ||
      minute < 0 ||
      minute > 59
    ) {
      return {
        error:
          '"schedule.hour" must be 0-23 and "schedule.minute" must be 0-59 for daily_at.',
      }
    }
    return {
      schedule: {
        kind: 'daily_at',
        hour,
        minute,
        timezone: validTimezone,
      },
    }
  }

  return {
    error: `Unsupported schedule kind: ${kind}`,
  }
}

function parseScheduleFromArgs(
  rawArgs: unknown,
  timezoneFallback = LOCAL_TIMEZONE,
): {
  schedule?: TaskSchedule
  error?: string
} {
  const args = asObject(rawArgs)
  const timezone =
    typeof args.timezone === 'string' && args.timezone.trim()
      ? args.timezone.trim()
      : timezoneFallback

  if (typeof args.schedule_text === 'string' && args.schedule_text.trim()) {
    const parsed = parseScheduleFromText(args.schedule_text, timezone)
    if (parsed.error) {
      return { error: parsed.error }
    }
    return { schedule: parsed.schedule }
  }

  if (args.schedule !== undefined) {
    const parsed = parseScheduleFromStructured(args.schedule, timezone)
    if (parsed.error) {
      return { error: parsed.error }
    }
    return { schedule: parsed.schedule }
  }

  return {
    error:
      'Missing schedule: provide "schedule_text" (recommended) or structured "schedule".',
  }
}

function parsePromptFromArgs(rawArgs: unknown): {
  prompt?: string
  model?: string
  error?: string
} {
  const args = asObject(rawArgs)
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
  if (!prompt) {
    return { error: 'Missing prompt: provide non-empty "prompt".' }
  }

  const model =
    typeof args.model === 'string' && args.model.trim()
      ? args.model.trim()
      : undefined

  return {
    prompt,
    ...(model ? { model } : {}),
  }
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

function normalizeLastStatus(value: unknown): TaskLastStatus {
  if (
    value === 'idle' ||
    value === 'running' ||
    value === 'success' ||
    value === 'failed'
  ) {
    return value
  }
  return 'idle'
}

function normalizeTaskRecord(raw: unknown): TaskRecord | null {
  const obj = asObject(raw)
  const id = typeof obj.id === 'string' ? obj.id.trim() : ''
  const name = typeof obj.name === 'string' ? obj.name.trim() : ''
  if (!id || !name) {
    return null
  }

  const scheduleParsed = parseScheduleFromStructured(obj.schedule, LOCAL_TIMEZONE)
  if (!scheduleParsed.schedule) {
    return null
  }

  const prompt =
    typeof obj.prompt === 'string' ? obj.prompt.trim() : ''
  if (!prompt) {
    return null
  }
  const model =
    typeof obj.model === 'string' && obj.model.trim()
      ? obj.model.trim()
      : undefined

  const now = new Date()
  const nextRunAtRaw = parseDateOrNull(obj.next_run_at)
  const nextRunAt = nextRunAtRaw
    ? nextRunAtRaw
    : computeNextRunAt(scheduleParsed.schedule, now).toISOString()

  const createdAt = parseDateOrNull(obj.created_at) ?? isoNow()
  const updatedAt = parseDateOrNull(obj.updated_at) ?? createdAt

  return {
    id,
    name,
    enabled: obj.enabled !== false,
    channel_id:
      typeof obj.channel_id === 'string' ? obj.channel_id.trim() : '',
    creator_user_id:
      typeof obj.creator_user_id === 'string' ? obj.creator_user_id.trim() : '',
    schedule: scheduleParsed.schedule,
    prompt,
    ...(model ? { model } : {}),
    next_run_at: nextRunAt,
    last_run_started_at: parseDateOrNull(obj.last_run_started_at),
    last_run_at: parseDateOrNull(obj.last_run_at),
    last_status: normalizeLastStatus(obj.last_status),
    last_error:
      typeof obj.last_error === 'string' ? obj.last_error : null,
    created_at: createdAt,
    updated_at: updatedAt,
  }
}

function normalizeTaskStore(raw: unknown): TaskStore {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { tasks: [] }
  }
  const value = raw as { tasks?: unknown }
  const tasks = Array.isArray(value.tasks) ? value.tasks : []
  const normalizedTasks: TaskRecord[] = []
  for (const task of tasks) {
    const normalized = normalizeTaskRecord(task)
    if (normalized) {
      normalizedTasks.push(normalized)
    }
  }
  return {
    tasks: normalizedTasks,
  }
}

async function readTaskStoreFromPath(path: string): Promise<TaskStore> {
  const ref = file(path)
  if (!(await ref.exists())) {
    return { tasks: [] }
  }

  const raw = (await ref.text()).trim()
  if (!raw) {
    return { tasks: [] }
  }

  const parsed = JSON.parse(raw)
  return normalizeTaskStore(parsed)
}

async function readTaskStore(runtime: FunctionToolRuntime): Promise<TaskStore> {
  const path = getTaskStorePath(runtime)
  return await readTaskStoreFromPath(path)
}

export async function readTaskStoreFromProjectRoot(
  projectRoot: string,
): Promise<TaskStore> {
  const path = getTaskStorePathFromProjectRoot(projectRoot)
  return await readTaskStoreFromPath(path)
}

async function writeTaskStoreToPath(path: string, store: TaskStore): Promise<void> {
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

async function writeTaskStore(
  runtime: FunctionToolRuntime,
  store: TaskStore,
): Promise<void> {
  const path = getTaskStorePath(runtime)
  await writeTaskStoreToPath(path, store)
}

export async function writeTaskStoreFromProjectRoot(
  projectRoot: string,
  store: TaskStore,
): Promise<void> {
  const path = getTaskStorePathFromProjectRoot(projectRoot)
  await writeTaskStoreToPath(path, store)
}

function generateTaskId(): string {
  return `task_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`
}

function truncatePreview(input: string, max = 140): string {
  const clean = input.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) {
    return clean
  }
  return `${clean.slice(0, Math.max(0, max - 14))}...(truncated)`
}

function findTaskById(store: TaskStore, id: string): TaskRecord | null {
  const found = store.tasks.find(task => task.id === id)
  return found ?? null
}

export function isTaskDue(task: TaskRecord, now: Date): boolean {
  if (!task.enabled) {
    return false
  }
  const next = new Date(task.next_run_at)
  if (!Number.isFinite(next.getTime())) {
    return false
  }
  return next.getTime() <= now.getTime()
}

export function computeFollowingRunAt(
  task: TaskRecord,
  now: Date,
): string | null {
  if (task.schedule.kind === 'once_delay') {
    return null
  }
  return computeNextRunAt(task.schedule, now).toISOString()
}

export async function callTaskCreateTool(
  runtime: FunctionToolRuntime,
  rawArgs: unknown,
  hooks?: FunctionToolCallHooks,
): Promise<string> {
  const args = asObject(rawArgs)
  const name = typeof args.name === 'string' ? args.name.trim() : ''
  if (!name) {
    return 'Invalid arguments: "name" must be a non-empty string.'
  }

  const channelIdRaw =
    typeof args.channel_id === 'string' ? args.channel_id.trim() : ''
  const creatorUserIdRaw =
    typeof args.creator_user_id === 'string' ? args.creator_user_id.trim() : ''
  const channelId = channelIdRaw || hooks?.taskContext?.channelId || ''
  const creatorUserId =
    creatorUserIdRaw || hooks?.taskContext?.requesterUserId || ''

  const promptParsed = parsePromptFromArgs(args)
  if (!promptParsed.prompt) {
    return `Invalid prompt: ${promptParsed.error ?? 'unknown error'}`
  }

  const enabled = args.enabled !== false
  const parsedSchedule = parseScheduleFromArgs(
    args,
    hooks?.taskContext?.timezone || LOCAL_TIMEZONE,
  )
  if (!parsedSchedule.schedule) {
    return `Invalid schedule: ${parsedSchedule.error ?? 'unknown error'}`
  }

  const now = new Date()
  const nextRunAt = computeNextRunAt(parsedSchedule.schedule, now)
  if (hooks?.confirmTaskCreate) {
    const approved = await hooks.confirmTaskCreate({
      name,
      channelId: channelId || '(missing)',
      scheduleSummary: formatSchedule(parsedSchedule.schedule),
      promptSummary: `llm: ${truncatePreview(promptParsed.prompt)}`,
      nextRunAt: nextRunAt.toISOString(),
    })
    if (!approved) {
      return 'Task creation canceled: confirmation rejected.'
    }
  }

  let store: TaskStore
  try {
    store = await readTaskStore(runtime)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `Read task store failed: ${message}`
  }

  const nowIso = isoNow()
  const created: TaskRecord = {
    id: generateTaskId(),
    name,
    enabled,
    channel_id: channelId,
    creator_user_id: creatorUserId,
    schedule: parsedSchedule.schedule,
    prompt: promptParsed.prompt,
    ...(promptParsed.model ? { model: promptParsed.model } : {}),
    next_run_at: nextRunAt.toISOString(),
    last_run_started_at: null,
    last_run_at: null,
    last_status: 'idle',
    last_error: null,
    created_at: nowIso,
    updated_at: nowIso,
  }
  store.tasks.push(created)

  try {
    await writeTaskStore(runtime, store)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `Write task store failed: ${message}`
  }

  return [
    `id: ${created.id}`,
    `name: ${created.name}`,
    `enabled: ${created.enabled}`,
    `channel_id: ${created.channel_id || '(missing)'}`,
    `schedule: ${formatSchedule(created.schedule)}`,
    `prompt: ${truncatePreview(created.prompt)}`,
    `model: ${created.model ?? '(default)'}`,
    `next_run_at: ${created.next_run_at}`,
    `path: .agents/tasks.json`,
  ].join('\n')
}

export async function callTaskListTool(
  runtime: FunctionToolRuntime,
  rawArgs: unknown,
): Promise<string> {
  const args = asObject(rawArgs)
  const enabledOnly = args.enabled_only === true

  let store: TaskStore
  try {
    store = await readTaskStore(runtime)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `Read task store failed: ${message}`
  }

  const tasks = enabledOnly
    ? store.tasks.filter(task => task.enabled)
    : [...store.tasks]
  if (tasks.length === 0) {
    return enabledOnly ? '(No enabled tasks)' : '(No tasks)'
  }

  const lines = [
    `count: ${tasks.length}`,
    ...tasks.map(task =>
      [
        `- ${task.id}`,
        `  name: ${task.name}`,
        `  enabled: ${task.enabled}`,
        `  channel_id: ${task.channel_id || '(missing)'}`,
        `  schedule: ${formatSchedule(task.schedule)}`,
        `  prompt: ${truncatePreview(task.prompt)}`,
        `  model: ${task.model ?? '(default)'}`,
        `  last_status: ${task.last_status}`,
        `  next_run_at: ${task.next_run_at}`,
      ].join('\n'),
    ),
  ]
  return lines.join('\n')
}

export async function callTaskPauseTool(
  runtime: FunctionToolRuntime,
  rawArgs: unknown,
): Promise<string> {
  const args = asObject(rawArgs)
  const id = typeof args.id === 'string' ? args.id.trim() : ''
  if (!id) {
    return 'Invalid arguments: "id" must be a non-empty string.'
  }

  let store: TaskStore
  try {
    store = await readTaskStore(runtime)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `Read task store failed: ${message}`
  }

  const task = findTaskById(store, id)
  if (!task) {
    return `Task not found: ${id}`
  }

  task.enabled = false
  task.updated_at = isoNow()

  try {
    await writeTaskStore(runtime, store)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `Write task store failed: ${message}`
  }

  return [
    `id: ${task.id}`,
    `enabled: ${task.enabled}`,
    `next_run_at: ${task.next_run_at}`,
  ].join('\n')
}

export async function callTaskResumeTool(
  runtime: FunctionToolRuntime,
  rawArgs: unknown,
): Promise<string> {
  const args = asObject(rawArgs)
  const id = typeof args.id === 'string' ? args.id.trim() : ''
  if (!id) {
    return 'Invalid arguments: "id" must be a non-empty string.'
  }

  let store: TaskStore
  try {
    store = await readTaskStore(runtime)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `Read task store failed: ${message}`
  }

  const task = findTaskById(store, id)
  if (!task) {
    return `Task not found: ${id}`
  }

  task.enabled = true
  const now = new Date()
  const currentNextRun = new Date(task.next_run_at)
  if (
    !Number.isFinite(currentNextRun.getTime()) ||
    currentNextRun.getTime() <= now.getTime()
  ) {
    task.next_run_at = computeNextRunAt(task.schedule, now).toISOString()
  }
  task.updated_at = isoNow()

  try {
    await writeTaskStore(runtime, store)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `Write task store failed: ${message}`
  }

  return [
    `id: ${task.id}`,
    `enabled: ${task.enabled}`,
    `next_run_at: ${task.next_run_at}`,
  ].join('\n')
}
