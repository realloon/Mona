import path from 'node:path'
import { appendFile, mkdir, readFile, rm } from 'node:fs/promises'
import OpenAI from 'openai'
import { McpToolManager, parseToolArguments } from '../mcp'
import { SkillManager } from '../skills'
import { FunctionToolManager } from '../tools'
import { readMemoryStoreFromProjectRoot } from '../tools/memory'
import { asObject } from '../utils/guards'
import {
  TASK_CREATE_TOOL,
  TASK_LIST_TOOL,
  TASK_PAUSE_TOOL,
  TASK_RESUME_TOOL,
} from '../tools/tasks'
import { formatRequestError } from '../utils/errors'
import type {
  DangerousCommandRequest,
  TaskCreateApprovalRequest,
  TaskToolContext,
} from '../types/tools'

type Role = 'user' | 'assistant'

type Turn = {
  role: Role
  content: string
}

type SessionState = {
  turns: Turn[]
}

type TaskIntent = 'create' | 'list' | 'pause' | 'resume' | null

type CreateChatEngineOptions = {
  projectRoot: string
  promptLogEnabled: boolean
  client: OpenAI
  systemPrompt: string
  model: string
  skillRouterModel: string
  maxSelectedSkills?: number
  mcpTools: McpToolManager
  skillManager: SkillManager
  functionTools: FunctionToolManager
}

export type ChatEngine = {
  generateReply: (
    sessionId: string,
    userInput: string,
    dangerousCommandApproval?: (
      request: DangerousCommandRequest,
    ) => Promise<boolean>,
    taskCreateApproval?: (
      request: TaskCreateApprovalRequest,
    ) => Promise<boolean>,
    taskContext?: TaskToolContext,
  ) => Promise<{ answer: string }>
  clearSession: (sessionId: string) => boolean
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

function detectTaskIntent(userInput: string): TaskIntent {
  const input = userInput.toLowerCase()
  if (
    /(恢复|启用|继续|resume)\b/i.test(input) &&
    /(任务|提醒|task|reminder)\b/i.test(input)
  ) {
    return 'resume'
  }
  if (
    /(暂停|停用|关闭|pause)\b/i.test(input) &&
    /(任务|提醒|task|reminder)\b/i.test(input)
  ) {
    return 'pause'
  }
  if (/(列出|查看|任务列表|list)\b/i.test(input)) {
    return 'list'
  }
  if (
    /(提醒|定时|分钟后|小时后|每天|创建任务|新增任务|schedule|remind)\b/i.test(
      input,
    )
  ) {
    return 'create'
  }
  return null
}

function extractRouterSelectedSkillNames(raw: Record<string, unknown>): string[] {
  const namesRaw = raw.selected_skill_names
  if (!Array.isArray(namesRaw)) {
    return []
  }
  return namesRaw.filter((value): value is string => typeof value === 'string')
}

function buildMemoryPromptBlock(lines: string[]): string {
  return ['<memory_context>', ...lines, '</memory_context>'].join('\n')
}

function buildBasePromptBlock(content: string): string {
  return ['<base_prompt>', content, '</base_prompt>'].join('\n')
}

function buildSkillsPromptBlock(content: string): string {
  return ['<skills_context>', content, '</skills_context>'].join('\n')
}

function buildSystemPrompt(
  basePrompt: string,
  memoryInstruction: string,
  skillInstruction: string,
): string {
  return [
    '<system_prompt>',
    buildBasePromptBlock(basePrompt),
    memoryInstruction,
    skillInstruction,
    '</system_prompt>',
  ]
    .filter(Boolean)
    .join('\n\n')
}

const PROMPT_LOG_RELATIVE_PATH = '.agents/debug/prompts.jsonl'
const SESSIONS_DIR_RELATIVE_PATH = '.agents/sessions'

async function appendPromptLog(
  projectRoot: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const logPath = path.join(projectRoot, PROMPT_LOG_RELATIVE_PATH)
  await mkdir(path.dirname(logPath), { recursive: true })
  await appendFile(logPath, `${JSON.stringify(payload)}\n`, 'utf8')
}

function normalizeTurn(raw: unknown): Turn | null {
  const obj = asObject(raw)
  const role = obj.role === 'assistant' ? 'assistant' : obj.role === 'user' ? 'user' : null
  const content = typeof obj.content === 'string' ? obj.content : null
  if (!role || content === null) {
    return null
  }

  return { role, content }
}

function getSessionFilePath(projectRoot: string, sessionId: string): string {
  const safeSessionId = Buffer.from(sessionId).toString('base64url') || 'empty'
  return path.join(projectRoot, SESSIONS_DIR_RELATIVE_PATH, `${safeSessionId}.jsonl`)
}

function isEnoentError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

export function createChatEngine(options: CreateChatEngineOptions): ChatEngine {
  const sessions = new Map<string, SessionState>()
  const clearedSessionIds = new Set<string>()
  const maxSelectedSkills = options.maxSelectedSkills ?? 1
  const sessionWriteQueues = new Map<string, Promise<void>>()

  async function logPrompt(payload: Record<string, unknown>): Promise<void> {
    if (!options.promptLogEnabled) {
      return
    }
    try {
      await appendPromptLog(options.projectRoot, {
        timestamp: new Date().toISOString(),
        ...payload,
      })
    } catch (error) {
      const formatted = formatRequestError(error)
      console.error(`Prompt logging failed: ${formatted}`)
    }
  }

  function queueSessionWrite(sessionId: string, task: () => Promise<void>): Promise<void> {
    const previous = sessionWriteQueues.get(sessionId) ?? Promise.resolve()
    const current = previous.then(task, task)
    sessionWriteQueues.set(sessionId, current)
    void current.finally(() => {
      if (sessionWriteQueues.get(sessionId) === current) {
        sessionWriteQueues.delete(sessionId)
      }
    })
    return current
  }

  async function loadPersistedSession(sessionId: string): Promise<SessionState> {
    const sessionPath = getSessionFilePath(options.projectRoot, sessionId)
    try {
      const raw = await readFile(sessionPath, 'utf8')
      const lines = raw.split('\n')
      const turns: Turn[] = []
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) {
          continue
        }
        try {
          const parsed = JSON.parse(trimmed)
          const turn = normalizeTurn(parsed)
          if (turn) {
            turns.push(turn)
          }
        } catch {
          // Skip malformed JSONL lines and continue loading remaining turns.
        }
      }
      return { turns }
    } catch (error) {
      if (isEnoentError(error)) {
        return { turns: [] }
      }
      const formatted = formatRequestError(error)
      console.error(`Session restore failed for "${sessionId}": ${formatted}`)
      return { turns: [] }
    }
  }

  async function appendSessionTurns(sessionId: string, turns: Turn[]): Promise<void> {
    if (turns.length === 0) {
      return
    }

    const sessionPath = getSessionFilePath(options.projectRoot, sessionId)
    const payload = `${turns.map(turn => JSON.stringify(turn)).join('\n')}\n`
    try {
      await queueSessionWrite(sessionId, async () => {
        await mkdir(path.dirname(sessionPath), { recursive: true })
        await appendFile(sessionPath, payload, 'utf8')
      })
      clearedSessionIds.delete(sessionId)
    } catch (error) {
      const formatted = formatRequestError(error)
      console.error(`Session persist failed for "${sessionId}": ${formatted}`)
    }
  }

  async function deletePersistedSession(sessionId: string): Promise<void> {
    const sessionPath = getSessionFilePath(options.projectRoot, sessionId)
    await queueSessionWrite(sessionId, async () => {
      await rm(sessionPath, { force: true })
    })
  }

  async function getSession(sessionId: string): Promise<SessionState> {
    const cached = sessions.get(sessionId)
    if (cached) {
      return cached
    }

    if (clearedSessionIds.has(sessionId)) {
      const fresh: SessionState = { turns: [] }
      sessions.set(sessionId, fresh)
      return fresh
    }

    const restored = await loadPersistedSession(sessionId)
    sessions.set(sessionId, restored)
    return restored
  }

  function clearSession(sessionId: string): boolean {
    const clearedInMemory = sessions.delete(sessionId)
    clearedSessionIds.add(sessionId)
    void deletePersistedSession(sessionId).catch(error => {
      const formatted = formatRequestError(error)
      console.error(`Session clear failed for "${sessionId}": ${formatted}`)
    })
    return clearedInMemory
  }

  function resolveForcedTaskToolName(
    selectedSkillNames: string[],
    userInput: string,
  ): string | null {
    // Force only when scheduler is selected to avoid affecting normal chat.
    const schedulerSelected = selectedSkillNames.some(
      name => name.toLowerCase().trim() === 'scheduler',
    )
    if (!schedulerSelected) {
      return null
    }

    const intent = detectTaskIntent(userInput)
    if (intent === 'create' && options.functionTools.hasOpenAITool(TASK_CREATE_TOOL)) {
      return TASK_CREATE_TOOL
    }
    if (intent === 'list' && options.functionTools.hasOpenAITool(TASK_LIST_TOOL)) {
      return TASK_LIST_TOOL
    }
    if (intent === 'pause' && options.functionTools.hasOpenAITool(TASK_PAUSE_TOOL)) {
      return TASK_PAUSE_TOOL
    }
    if (intent === 'resume' && options.functionTools.hasOpenAITool(TASK_RESUME_TOOL)) {
      return TASK_RESUME_TOOL
    }

    return null
  }

  async function selectSkillNamesForInput(
    userInput: string,
    availableSkillsXml: string,
    requestId: string,
  ): Promise<string[]> {
    const explicit = options.skillManager.selectExplicitSkillNames(
      userInput,
      maxSelectedSkills,
    )
    if (explicit.length > 0) {
      return explicit
    }

    if (!availableSkillsXml) {
      return []
    }

    try {
      const routerMessages: Array<Record<string, unknown>> = [
        {
          role: 'system',
          content: [
            'Select skill names for the user request.',
            'Return JSON exactly: {"selected_skill_names": string[]}.',
            `Choose up to ${maxSelectedSkills} names from <available_skills>; return [] if none apply.`,
            availableSkillsXml,
          ].join('\n\n'),
        },
        {
          role: 'user',
          content: userInput,
        },
      ]
      await logPrompt({
        kind: 'skill_router',
        request_id: requestId,
        model: options.skillRouterModel,
        messages: routerMessages,
        response_format: { type: 'json_object' },
      })

      const routerCompletion = await options.client.chat.completions.create({
        model: options.skillRouterModel,
        messages: routerMessages as never,
        response_format: { type: 'json_object' } as never,
      })

      const routerText = contentToText(routerCompletion.choices[0]?.message?.content)
      const parsed = parseToolArguments(routerText)
      const selected = extractRouterSelectedSkillNames(parsed)
      return options.skillManager.filterKnownSkillNames(selected, maxSelectedSkills)
    } catch (error) {
      const formatted = formatRequestError(error)
      console.error(`Skill routing failed: ${formatted}`)
      return []
    }
  }

  async function askWithChat(
    session: SessionState,
    requestId: string,
    userInput: string,
    dangerousCommandApproval?: (
      request: DangerousCommandRequest,
    ) => Promise<boolean>,
    taskCreateApproval?: (
      request: TaskCreateApprovalRequest,
    ) => Promise<boolean>,
    taskContext?: TaskToolContext,
  ): Promise<string> {
    let memoryInstruction = ''
    try {
      const memoryStore = await readMemoryStoreFromProjectRoot(options.projectRoot)
      if (memoryStore.memories.length > 0) {
        const lines = memoryStore.memories
          .slice()
          .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
          .map(item => `- ${item.key}: ${item.value}`)
        memoryInstruction = buildMemoryPromptBlock(lines)
      }
    } catch (error) {
      const formatted = formatRequestError(error)
      console.error(`Memory injection failed: ${formatted}`)
    }

    const availableSkillsXml = options.skillManager.buildAvailableSkillsXml()
    const selectedSkillNames = await selectSkillNamesForInput(
      userInput,
      availableSkillsXml,
      requestId,
    )
    const rawSkillInstruction =
      await options.skillManager.buildSkillInstructionForNames(selectedSkillNames)
    const skillInstruction = rawSkillInstruction
      ? buildSkillsPromptBlock(rawSkillInstruction)
      : ''
    const combinedSystemPrompt = buildSystemPrompt(
      options.systemPrompt,
      memoryInstruction,
      skillInstruction,
    )

    const messages: Array<Record<string, unknown>> = [
      { role: 'system', content: combinedSystemPrompt },
      ...session.turns.map(turn => ({
        role: turn.role,
        content: turn.content,
      })),
    ]

    const tools = [
      ...options.mcpTools.getOpenAITools(),
      ...options.functionTools.getOpenAITools(),
    ]
    const maxToolRounds = 6
    const forcedTaskTool = resolveForcedTaskToolName(selectedSkillNames, userInput)

    for (let round = 0; round < maxToolRounds; round += 1) {
      const toolChoice =
        round === 0 && forcedTaskTool
          ? ({
              type: 'function',
              function: { name: forcedTaskTool },
            } as const)
          : ('auto' as const)

      await logPrompt({
        kind: 'chat',
        request_id: requestId,
        round,
        model: options.model,
        tool_choice: tools.length > 0 ? toolChoice : null,
        tools,
        selected_skill_names: selectedSkillNames,
        forced_task_tool: forcedTaskTool,
        messages,
      })

      const completion = await options.client.chat.completions.create({
        model: options.model,
        messages: messages as never,
        ...(tools.length > 0
          ? { tools: tools as never, tool_choice: toolChoice as never }
          : {}),
      })

      const assistantMessage = completion.choices[0]?.message
      if (!assistantMessage) {
        return '(No assistant message returned)'
      }

      const toolCalls = assistantMessage.tool_calls ?? []
      messages.push({
        role: 'assistant',
        content: assistantMessage.content ?? '',
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      })

      if (toolCalls.length === 0) {
        return (
          contentToText(assistantMessage.content) || '(No text content returned)'
        )
      }

      for (let callIndex = 0; callIndex < toolCalls.length; callIndex += 1) {
        const call = toolCalls[callIndex]
        if (call.type !== 'function') {
          continue
        }
        const args = parseToolArguments(call.function.arguments ?? '')
        let toolResult: string
        if (options.mcpTools.hasOpenAITool(call.function.name)) {
          toolResult = await options.mcpTools.callOpenAITool(call.function.name, args)
        } else if (options.functionTools.hasOpenAITool(call.function.name)) {
          toolResult = await options.functionTools.callOpenAITool(
            call.function.name,
            args,
            {
              confirmDangerousCommand: dangerousCommandApproval,
              confirmTaskCreate: taskCreateApproval,
              taskContext,
            },
          )
        } else {
          toolResult = `Unknown tool: ${call.function.name}`
        }
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: toolResult,
        })
      }
    }

    return 'Tool call round limit reached. Please simplify the request.'
  }

  async function generateReply(
    sessionId: string,
    userInput: string,
    dangerousCommandApproval?: (
      request: DangerousCommandRequest,
    ) => Promise<boolean>,
    taskCreateApproval?: (
      request: TaskCreateApprovalRequest,
    ) => Promise<boolean>,
    taskContext?: TaskToolContext,
  ): Promise<{ answer: string }> {
    const session = await getSession(sessionId)
    const requestId = `req_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`
    const userTurn: Turn = { role: 'user', content: userInput }
    session.turns.push(userTurn)
    await appendSessionTurns(sessionId, [userTurn])

    try {
      const answer = await askWithChat(
        session,
        requestId,
        userInput,
        dangerousCommandApproval,
        taskCreateApproval,
        taskContext,
      )
      const assistantTurn: Turn = { role: 'assistant', content: answer }
      session.turns.push(assistantTurn)
      await appendSessionTurns(sessionId, [assistantTurn])
      return { answer }
    } catch (error) {
      throw error
    }
  }

  return {
    generateReply,
    clearSession,
  }
}
