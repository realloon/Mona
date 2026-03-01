import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FunctionToolManager } from '../app/tools'

describe('FunctionToolManager', () => {
  let sandboxDir = ''

  beforeEach(async () => {
    sandboxDir = await mkdtemp(path.join(tmpdir(), 'mona-tools-test-'))
  })

  afterEach(async () => {
    if (sandboxDir) {
      await rm(sandboxDir, { recursive: true, force: true })
    }
  })

  function createManager(): FunctionToolManager {
    return new FunctionToolManager({
      projectRoot: sandboxDir,
      defaultTimeoutMs: 2000,
      maxOutputChars: 4000,
    })
  }

  test('blocks dangerous commands without approval hook', async () => {
    const manager = createManager()

    const result = await manager.callOpenAITool('builtin__run', {
      command: 'rm -rf /tmp/wont-run',
    })

    expect(result).toContain('Execution denied')
    expect(result).toContain('contains rm')
  })

  test('runs safe commands and captures output', async () => {
    const manager = createManager()

    const result = await manager.callOpenAITool('builtin__run', {
      command: 'printf hello',
    })

    expect(result).toContain('exit_code: 0')
    expect(result).toContain('stdout:')
    expect(result).toContain('hello')
  })

  test('refuses file overwrite when overwrite=false', async () => {
    const manager = createManager()
    const filePath = path.join(sandboxDir, 'note.txt')
    await Bun.write(filePath, 'old-content')

    const result = await manager.callOpenAITool('builtin__write', {
      path: 'note.txt',
      content: 'new-content',
      overwrite: false,
    })

    expect(result).toContain('Refused to overwrite existing file')
    const content = await Bun.file(filePath).text()
    expect(content).toBe('old-content')
  })

  test('clamps delete_count in non-strict patch mode', async () => {
    const manager = createManager()
    const filePath = path.join(sandboxDir, 'sample.txt')
    await Bun.write(filePath, 'a\nb\nc\n')

    const result = await manager.callOpenAITool('builtin__patch', {
      path: 'sample.txt',
      hunks: [{ start_line: 2, delete_count: 99, insert_lines: ['B'] }],
      strict: false,
    })

    expect(result).toContain('hunks_applied: 1')
    expect(result).toContain('strict: false')
    const nextContent = await Bun.file(filePath).text()
    expect(nextContent).toBe('a\nB\n')
  })

  test('creates, lists, and deletes memory entries', async () => {
    const manager = createManager()

    const created = await manager.callOpenAITool('builtin__memory_set', {
      key: 'user-name',
      value: 'Lizhen',
    })
    expect(created).toContain('key: user-name')
    expect(created).toContain('status: created')

    const listed = await manager.callOpenAITool('builtin__memory_list', {
      query: 'liz',
    })
    expect(listed).toContain('count: 1')
    expect(listed).toContain('- user-name')
    expect(listed).toContain('value: Lizhen')

    const removed = await manager.callOpenAITool('builtin__memory_delete', {
      key: 'user-name',
    })
    expect(removed).toContain('status: deleted')

    const listedAfterDelete = await manager.callOpenAITool('builtin__memory_list', {})
    expect(listedAfterDelete).toContain('(No memory)')

    const raw = await Bun.file(path.join(sandboxDir, '.agents/memory.json')).text()
    const parsed = JSON.parse(raw) as { memories: Array<{ key: string }> }
    expect(parsed.memories).toEqual([])
  })

  test('refuses memory overwrite when overwrite=false', async () => {
    const manager = createManager()

    await manager.callOpenAITool('builtin__memory_set', {
      key: 'timezone',
      value: 'Asia/Shanghai',
    })
    const conflict = await manager.callOpenAITool('builtin__memory_set', {
      key: 'timezone',
      value: 'UTC',
      overwrite: false,
    })
    expect(conflict).toContain('Memory key already exists')

    const listed = await manager.callOpenAITool('builtin__memory_list', {
      key: 'timezone',
    })
    expect(listed).toContain('value: Asia/Shanghai')
  })

  test('creates task from chinese schedule text and persists to json', async () => {
    const manager = createManager()

    const result = await manager.callOpenAITool('builtin__task_create', {
      name: 'drink-water',
      schedule_text: '五分钟后',
      prompt: '提醒我喝水',
    }, {
      taskContext: {
        channelId: 'channel-1',
        requesterUserId: 'user-1',
        timezone: 'Asia/Shanghai',
      },
    })

    expect(result).toContain('id: task_')
    expect(result).toContain('schedule: once_delay(5m)')
    expect(result).toContain('channel_id: channel-1')
    expect(result).toContain('prompt: 提醒我喝水')

    const raw = await Bun.file(path.join(sandboxDir, '.agents/tasks.json')).text()
    const parsed = JSON.parse(raw) as {
      tasks: Array<{
        name: string
        channel_id: string
        creator_user_id: string
        prompt: string
        model?: string
        schedule: { kind: string; minutes?: number }
      }>
    }

    expect(parsed.tasks.length).toBe(1)
    expect(parsed.tasks[0]?.name).toBe('drink-water')
    expect(parsed.tasks[0]?.channel_id).toBe('channel-1')
    expect(parsed.tasks[0]?.creator_user_id).toBe('user-1')
    expect(parsed.tasks[0]?.prompt).toBe('提醒我喝水')
    expect(parsed.tasks[0]?.schedule.kind).toBe('once_delay')
    expect(parsed.tasks[0]?.schedule.minutes).toBe(5)
  })

  test('requires task create approval when hook is provided', async () => {
    const manager = createManager()

    const denied = await manager.callOpenAITool(
      'builtin__task_create',
      {
        name: 'approval-required',
        schedule_text: '五分钟后',
        prompt: 'test message',
      },
      {
        taskContext: {
          channelId: 'channel-1',
          requesterUserId: 'user-1',
          timezone: 'Asia/Shanghai',
        },
        confirmTaskCreate: async () => false,
      },
    )

    expect(denied).toContain('Task creation canceled')

    const listed = await manager.callOpenAITool('builtin__task_list', {})
    expect(listed).toContain('(No tasks)')
  })

  test('pauses and resumes daily task', async () => {
    const manager = createManager()

    const created = await manager.callOpenAITool('builtin__task_create', {
      name: 'daily-brief',
      schedule_text: '每天早上6点',
      prompt: '生成日报',
    })
    const matched = created.match(/^id:\s*(task_[a-z0-9_]+)/m)
    expect(matched).not.toBeNull()
    const id = matched?.[1] ?? ''

    const paused = await manager.callOpenAITool('builtin__task_pause', {
      id,
    })
    expect(paused).toContain(`id: ${id}`)
    expect(paused).toContain('enabled: false')

    const resumed = await manager.callOpenAITool('builtin__task_resume', {
      id,
    })
    expect(resumed).toContain(`id: ${id}`)
    expect(resumed).toContain('enabled: true')

    const listed = await manager.callOpenAITool('builtin__task_list', {})
    expect(listed).toContain(`- ${id}`)
    expect(listed).toContain('daily_at(06:00')
  })

  test('rejects task_create when prompt is missing', async () => {
    const manager = createManager()

    const result = await manager.callOpenAITool('builtin__task_create', {
      name: 'missing-prompt',
      schedule_text: '五分钟后',
    })

    expect(result).toContain('Invalid prompt')
    expect(result).toContain('Missing prompt')
  })
})
