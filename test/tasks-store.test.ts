import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readTaskStoreFromProjectRoot } from '../app/tools/tasks.ts'

describe('task store normalization', () => {
  let sandboxDir = ''

  beforeEach(async () => {
    sandboxDir = await mkdtemp(path.join(tmpdir(), 'mona-task-store-test-'))
    await mkdir(path.join(sandboxDir, '.agents'), { recursive: true })
  })

  afterEach(async () => {
    if (sandboxDir) {
      await rm(sandboxDir, { recursive: true, force: true })
    }
  })

  test('keeps normalization strict when action is missing', async () => {
    const payload = {
      tasks: [
        {
          id: 'task_invalid_1',
          name: 'invalid-task',
          schedule: { kind: 'once_delay', minutes: 5 },
          prompt: 'missing-action-should-fail',
          next_run_at: '2026-03-02T00:00:00.000Z',
        },
      ],
    }
    await Bun.write(
      path.join(sandboxDir, '.agents/tasks.json'),
      `${JSON.stringify(payload, null, 2)}\n`,
    )

    const store = await readTaskStoreFromProjectRoot(sandboxDir)
    expect(store.tasks.length).toBe(0)
  })

  test('loads valid records in current schema', async () => {
    const payload = {
      tasks: [
        {
          id: 'task_valid_1',
          name: 'valid-task',
          schedule: { kind: 'once_delay', minutes: 5 },
          action: { type: 'llm', prompt: 'send summary' },
          enabled: true,
          channel_id: 'channel-1',
          creator_user_id: 'user-1',
          next_run_at: '2026-03-02T00:00:00.000Z',
          created_at: '2026-03-01T00:00:00.000Z',
          updated_at: '2026-03-01T00:00:00.000Z',
        },
      ],
    }
    await Bun.write(
      path.join(sandboxDir, '.agents/tasks.json'),
      `${JSON.stringify(payload, null, 2)}\n`,
    )

    const store = await readTaskStoreFromProjectRoot(sandboxDir)
    expect(store.tasks.length).toBe(1)
    expect(store.tasks[0]?.id).toBe('task_valid_1')
    expect(store.tasks[0]?.action.type).toBe('llm')
  })
})
