import type OpenAI from 'openai'
import type { Client as DiscordClient } from 'discord.js'
import { toErrorMessage } from './utils/errors'
import {
  computeFollowingRunAt,
  isTaskDue,
  readTaskStoreFromProjectRoot,
  type TaskRecord,
  writeTaskStoreFromProjectRoot,
} from './tools/tasks'

type SendableChannel = {
  isTextBased: () => boolean
  send: (content: string) => Promise<unknown>
}

type TaskSchedulerOptions = {
  projectRoot: string
  intervalMs: number
  maxTasksPerTick?: number
  openaiClient: OpenAI
  defaultModel: string
  discordClient: DiscordClient
}

function splitDiscordMessage(text: string, limit = 1900): string[] {
  if (text.length <= limit) {
    return [text]
  }

  const chunks: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut < 0) {
      cut = rest.lastIndexOf(' ', limit)
    }
    if (cut < 0) {
      cut = limit
    }
    chunks.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trimStart()
  }
  if (rest.length > 0) {
    chunks.push(rest)
  }
  return chunks
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }

  if (Array.isArray(content)) {
    const textParts = content
      .map(part => {
        if (
          part &&
          typeof part === 'object' &&
          'type' in part &&
          (part as { type?: string }).type === 'text' &&
          'text' in part &&
          typeof (part as { text?: unknown }).text === 'string'
        ) {
          return (part as { text: string }).text
        }
        return ''
      })
      .filter(Boolean)
    return textParts.join('\n').trim()
  }

  return ''
}

function isSendableTextChannel(channel: unknown): channel is SendableChannel {
  return (
    !!channel &&
    typeof channel === 'object' &&
    'isTextBased' in channel &&
    typeof (channel as { isTextBased: unknown }).isTextBased === 'function' &&
    'send' in channel &&
    typeof (channel as { send: unknown }).send === 'function'
  )
}

function clampPositiveInt(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback
  }
  return Math.floor(value)
}

function buildSuccessMessage(task: TaskRecord, output: string): string {
  return [
    `Task executed: ${task.name} (${task.id})`,
    `schedule: ${task.schedule.kind}`,
    '',
    output || '(empty output)',
  ].join('\n')
}

function buildFailureMessage(task: TaskRecord, error: string): string {
  return [
    `Task failed: ${task.name} (${task.id})`,
    `schedule: ${task.schedule.kind}`,
    `error: ${error}`,
  ].join('\n')
}

export class TaskScheduler {
  private readonly projectRoot: string
  private readonly intervalMs: number
  private readonly maxTasksPerTick: number
  private readonly openaiClient: OpenAI
  private readonly defaultModel: string
  private readonly discordClient: DiscordClient
  private readonly runningTaskIds = new Set<string>()
  private timer: ReturnType<typeof setInterval> | null = null
  private tickInFlight = false

  constructor(options: TaskSchedulerOptions) {
    this.projectRoot = options.projectRoot
    this.intervalMs = clampPositiveInt(options.intervalMs, 10000)
    this.maxTasksPerTick = clampPositiveInt(options.maxTasksPerTick ?? 3, 3)
    this.openaiClient = options.openaiClient
    this.defaultModel = options.defaultModel
    this.discordClient = options.discordClient
  }

  start(): void {
    if (this.timer) {
      return
    }
    this.timer = setInterval(() => {
      void this.tick()
    }, this.intervalMs)
    void this.tick()
  }

  stop(): void {
    if (!this.timer) {
      return
    }
    clearInterval(this.timer)
    this.timer = null
  }

  private async tick(): Promise<void> {
    if (this.tickInFlight) {
      return
    }
    this.tickInFlight = true
    try {
      const store = await readTaskStoreFromProjectRoot(this.projectRoot)
      const now = new Date()
      const dueTasks = store.tasks
        .filter(task => isTaskDue(task, now))
        .filter(task => !this.runningTaskIds.has(task.id))
        .slice(0, this.maxTasksPerTick)

      for (const task of dueTasks) {
        await this.runOne(task.id)
      }
    } catch (error) {
      const message = toErrorMessage(error)
      console.error(`Task scheduler tick failed: ${message}`)
    } finally {
      this.tickInFlight = false
    }
  }

  private async runOne(taskId: string): Promise<void> {
    if (this.runningTaskIds.has(taskId)) {
      return
    }
    this.runningTaskIds.add(taskId)

    try {
      const store = await readTaskStoreFromProjectRoot(this.projectRoot)
      const task = store.tasks.find(item => item.id === taskId)
      if (!task || !isTaskDue(task, new Date())) {
        return
      }

      const startedAt = new Date().toISOString()
      task.last_status = 'running'
      task.last_run_started_at = startedAt
      task.updated_at = startedAt
      await writeTaskStoreFromProjectRoot(this.projectRoot, store)

      try {
        const output = await this.executeTask(task)
        await this.publishTaskResult(task, buildSuccessMessage(task, output))

        const nextStore = await readTaskStoreFromProjectRoot(this.projectRoot)
        const target = nextStore.tasks.find(item => item.id === taskId)
        if (!target) {
          return
        }
        const finishedAt = new Date()
        target.last_run_at = finishedAt.toISOString()
        target.last_status = 'success'
        target.last_error = null
        target.updated_at = finishedAt.toISOString()
        if (target.schedule.kind === 'once_delay') {
          target.enabled = false
        } else {
          target.next_run_at = computeFollowingRunAt(target, finishedAt) ?? target.next_run_at
        }
        await writeTaskStoreFromProjectRoot(this.projectRoot, nextStore)
      } catch (error) {
        const errorMessage = toErrorMessage(error)
        await this.publishTaskResult(task, buildFailureMessage(task, errorMessage))

        const nextStore = await readTaskStoreFromProjectRoot(this.projectRoot)
        const target = nextStore.tasks.find(item => item.id === taskId)
        if (!target) {
          return
        }
        const finishedAt = new Date()
        target.last_run_at = finishedAt.toISOString()
        target.last_status = 'failed'
        target.last_error = errorMessage
        target.updated_at = finishedAt.toISOString()
        if (target.schedule.kind === 'once_delay') {
          target.enabled = false
        } else {
          target.next_run_at = computeFollowingRunAt(target, finishedAt) ?? target.next_run_at
        }
        await writeTaskStoreFromProjectRoot(this.projectRoot, nextStore)
      }
    } catch (error) {
      const message = toErrorMessage(error)
      console.error(`Task run failed (${taskId}): ${message}`)
    } finally {
      this.runningTaskIds.delete(taskId)
    }
  }

  private async executeTask(task: TaskRecord): Promise<string> {
    const completion = await this.openaiClient.chat.completions.create({
      model: task.model || this.defaultModel,
      messages: [
        {
          role: 'system',
          content: [
            'You are executing a scheduled task.',
            'Return only the final response content.',
            `task_id=${task.id}`,
            `task_name=${task.name}`,
            `channel_id=${task.channel_id || '(missing)'}`,
          ].join('\n'),
        },
        {
          role: 'user',
          content: task.prompt,
        },
      ] as never,
    })

    const text = contentToText(completion.choices[0]?.message?.content)
    return text || '(No text content returned)'
  }

  private async publishTaskResult(task: TaskRecord, message: string): Promise<void> {
    if (!task.channel_id) {
      console.error(`Task has no channel_id: ${task.id}`)
      return
    }

    const channel = await this.discordClient.channels.fetch(task.channel_id)
    if (!isSendableTextChannel(channel) || !channel.isTextBased()) {
      console.error(`Task channel is not sendable: ${task.channel_id}`)
      return
    }

    const chunks = splitDiscordMessage(message)
    for (const chunk of chunks) {
      await channel.send(chunk)
    }
  }
}
