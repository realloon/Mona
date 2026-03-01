import OpenAI from 'openai'
import { McpToolManager, parseToolArguments } from '../mcp'
import { SkillManager } from '../skills'
import { FunctionToolManager } from '../tools'
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
  client: OpenAI
  systemPrompt: string
  model: string
  skillRouterModel: string
  maxHistoryMessages: number
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

function extractRouterSelectedSkillIds(raw: Record<string, unknown>): string[] {
  const idsRaw = raw.selected_skill_ids
  if (!Array.isArray(idsRaw)) {
    return []
  }
  return idsRaw.filter((value): value is string => typeof value === 'string')
}

export function createChatEngine(options: CreateChatEngineOptions): ChatEngine {
  const sessions = new Map<string, SessionState>()
  const maxSelectedSkills = options.maxSelectedSkills ?? 1

  function trimHistory(history: Turn[]): Turn[] {
    if (!Number.isFinite(options.maxHistoryMessages) || options.maxHistoryMessages <= 0) {
      return history
    }
    if (history.length <= options.maxHistoryMessages) {
      return history
    }
    return history.slice(history.length - options.maxHistoryMessages)
  }

  function getSession(sessionId: string): SessionState {
    const cached = sessions.get(sessionId)
    if (cached) {
      return cached
    }

    const created: SessionState = {
      turns: [],
    }
    sessions.set(sessionId, created)
    return created
  }

  function clearSession(sessionId: string): boolean {
    return sessions.delete(sessionId)
  }

  function resolveForcedTaskToolName(
    selectedSkillIds: string[],
    userInput: string,
  ): string | null {
    // Force only when scheduler is selected to avoid affecting normal chat.
    if (!selectedSkillIds.includes('scheduler')) {
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

  async function selectSkillIdsForInput(
    userInput: string,
    availableSkillsXml: string,
  ): Promise<string[]> {
    const explicit = options.skillManager.selectExplicitSkillIds(
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
      const routerCompletion = await options.client.chat.completions.create({
        model: options.skillRouterModel,
        messages: [
          {
            role: 'system',
            content: [
              'You are a skill router.',
              'Choose the best skill IDs for the user request.',
              'Return strict JSON: {"selected_skill_ids": string[]}.',
              `Rules: choose at most ${maxSelectedSkills} skill IDs; use [] when no skill is relevant.`,
              'Do not include unknown IDs.',
              availableSkillsXml,
            ].join('\n\n'),
          },
          {
            role: 'user',
            content: userInput,
          },
        ] as never,
        response_format: { type: 'json_object' } as never,
      })

      const routerText = contentToText(routerCompletion.choices[0]?.message?.content)
      const parsed = parseToolArguments(routerText)
      const selected = extractRouterSelectedSkillIds(parsed)
      return options.skillManager.filterKnownSkillIds(selected, maxSelectedSkills)
    } catch (error) {
      const formatted = formatRequestError(error)
      console.error(`Skill routing failed: ${formatted}`)
      return []
    }
  }

  async function askWithChat(
    session: SessionState,
    userInput: string,
    dangerousCommandApproval?: (
      request: DangerousCommandRequest,
    ) => Promise<boolean>,
    taskCreateApproval?: (
      request: TaskCreateApprovalRequest,
    ) => Promise<boolean>,
    taskContext?: TaskToolContext,
  ): Promise<string> {
    const availableSkillsXml = options.skillManager.buildAvailableSkillsXml()
    const selectedSkillIds = await selectSkillIdsForInput(
      userInput,
      availableSkillsXml,
    )
    const skillInstruction = await options.skillManager.buildSkillInstructionForIds(
      selectedSkillIds,
    )
    const combinedSystemPrompt = [
      options.systemPrompt,
      availableSkillsXml,
      skillInstruction,
    ]
      .filter(Boolean)
      .join('\n\n')

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
    const forcedTaskTool = resolveForcedTaskToolName(selectedSkillIds, userInput)

    for (let round = 0; round < maxToolRounds; round += 1) {
      const toolChoice =
        round === 0 && forcedTaskTool
          ? ({
              type: 'function',
              function: { name: forcedTaskTool },
            } as const)
          : ('auto' as const)

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
    const session = getSession(sessionId)
    session.turns.push({ role: 'user', content: userInput })
    session.turns = trimHistory(session.turns)

    try {
      const answer = await askWithChat(
        session,
        userInput,
        dangerousCommandApproval,
        taskCreateApproval,
        taskContext,
      )
      session.turns.push({ role: 'assistant', content: answer })
      session.turns = trimHistory(session.turns)
      return { answer }
    } catch (error) {
      session.turns.pop()
      throw error
    }
  }

  return {
    generateReply,
    clearSession,
  }
}
