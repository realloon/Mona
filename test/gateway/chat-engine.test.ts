import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type OpenAI from 'openai'
import { createChatEngine } from '../../app/gateway/chat-engine'
import { McpToolManager } from '../../app/mcp'
import { SkillManager } from '../../app/skills'
import { FunctionToolManager } from '../../app/tools'

function createFakeClient(replies: string[]): OpenAI {
  let index = 0
  return {
    chat: {
      completions: {
        create: async () => {
          const content = replies[Math.min(index, replies.length - 1)] ?? '(empty)'
          index += 1
          return {
            choices: [
              {
                message: {
                  content,
                },
              },
            ],
          }
        },
      },
    },
  } as unknown as OpenAI
}

function getSessionFilePath(projectRoot: string, sessionId: string): string {
  const safeSessionId = Buffer.from(sessionId).toString('base64url') || 'empty'
  return path.join(projectRoot, '.agents/sessions', `${safeSessionId}.jsonl`)
}

function parseTurnsFromJsonl(raw: string): Array<{ role: string; content: string }> {
  return raw
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as { role: string; content: string })
}

describe('ChatEngine session persistence', () => {
  let sandboxDir = ''

  beforeEach(async () => {
    sandboxDir = await mkdtemp(path.join(tmpdir(), 'mona-chat-engine-test-'))
  })

  afterEach(async () => {
    if (sandboxDir) {
      await rm(sandboxDir, { recursive: true, force: true })
    }
  })

  function createEngine(replies: string[]) {
    return createChatEngine({
      projectRoot: sandboxDir,
      promptLogEnabled: false,
      client: createFakeClient(replies),
      systemPrompt: 'test system prompt',
      model: 'test-model',
      skillRouterModel: 'test-model',
      mcpTools: new McpToolManager(),
      skillManager: new SkillManager(),
      functionTools: new FunctionToolManager({
        projectRoot: sandboxDir,
        defaultTimeoutMs: 1000,
        maxOutputChars: 4000,
      }),
    })
  }

  test('restores turns for one session after restart (lazy by session id)', async () => {
    const firstEngine = createEngine(['assistant-1'])
    await firstEngine.generateReply('session-a', 'user-1')

    const secondEngine = createEngine(['assistant-2'])
    await secondEngine.generateReply('session-a', 'user-2')

    const raw = await Bun.file(getSessionFilePath(sandboxDir, 'session-a')).text()
    const turns = parseTurnsFromJsonl(raw)
    expect(turns).toEqual([
      { role: 'user', content: 'user-1' },
      { role: 'assistant', content: 'assistant-1' },
      { role: 'user', content: 'user-2' },
      { role: 'assistant', content: 'assistant-2' },
    ])
  })

  test('clear removes both in-memory and persisted session', async () => {
    const firstEngine = createEngine(['assistant-1'])
    await firstEngine.generateReply('session-a', 'user-1')

    const secondEngine = createEngine(['assistant-2'])
    const cleared = secondEngine.clearSession('session-a')
    expect(cleared).toBe(false)

    const sessionPath = getSessionFilePath(sandboxDir, 'session-a')
    let exists = true
    for (let attempt = 0; attempt < 20; attempt += 1) {
      exists = await Bun.file(sessionPath).exists()
      if (!exists) {
        break
      }
      await Bun.sleep(10)
    }
    expect(exists).toBe(false)
  })

  test('after clear, next message starts from empty history immediately', async () => {
    const firstEngine = createEngine(['assistant-1'])
    await firstEngine.generateReply('session-a', 'user-1')

    const secondEngine = createEngine(['assistant-2'])
    secondEngine.clearSession('session-a')
    await secondEngine.generateReply('session-a', 'user-2')

    const raw = await Bun.file(getSessionFilePath(sandboxDir, 'session-a')).text()
    const turns = parseTurnsFromJsonl(raw)
    expect(turns).toEqual([
      { role: 'user', content: 'user-2' },
      { role: 'assistant', content: 'assistant-2' },
    ])
  })

  test('failed request may keep the user turn in jsonl', async () => {
    const successEngine = createEngine(['assistant-1'])
    await successEngine.generateReply('session-a', 'user-1')

    const failingClient = {
      chat: {
        completions: {
          create: async () => {
            throw new Error('upstream failure')
          },
        },
      },
    } as unknown as OpenAI

    const failingEngine = createChatEngine({
      projectRoot: sandboxDir,
      promptLogEnabled: false,
      client: failingClient,
      systemPrompt: 'test system prompt',
      model: 'test-model',
      skillRouterModel: 'test-model',
      mcpTools: new McpToolManager(),
      skillManager: new SkillManager(),
      functionTools: new FunctionToolManager({
        projectRoot: sandboxDir,
        defaultTimeoutMs: 1000,
        maxOutputChars: 4000,
      }),
    })

    await expect(
      failingEngine.generateReply('session-a', 'user-2'),
    ).rejects.toThrow('upstream failure')

    const raw = await Bun.file(getSessionFilePath(sandboxDir, 'session-a')).text()
    const turns = parseTurnsFromJsonl(raw)
    expect(turns).toEqual([
      { role: 'user', content: 'user-1' },
      { role: 'assistant', content: 'assistant-1' },
      { role: 'user', content: 'user-2' },
    ])
  })
})
