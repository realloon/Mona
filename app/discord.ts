import OpenAI from 'openai'
import { env } from 'bun'
import {
  type ChatInputCommandInteraction,
  Client as DiscordClient,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  type Message,
} from 'discord.js'
import { McpToolManager, parseToolArguments } from './mcp.js'
import { SkillManager } from './skills.js'

type Role = 'user' | 'assistant'
type Turn = {
  role: Role
  content: string
}
type SessionState = {
  turns: Turn[]
}
type SendableChannel = {
  sendTyping: () => Promise<unknown>
  send: (content: string) => Promise<unknown>
}

const apiKey = env.OPENAI_API_KEY
if (!apiKey) {
  console.error('Missing OPENAI_API_KEY. Please set it in your environment.')
  process.exit(1)
}

const botToken = env.DISCORD_BOT_TOKEN
if (!botToken) {
  console.error('Missing DISCORD_BOT_TOKEN. Please set it in your environment.')
  process.exit(1)
}

const baseURL = env.OPENAI_BASE_URL
const client = new OpenAI({ apiKey, baseURL })

const maxHistoryMessages = Number.parseInt(env.MAX_HISTORY_MESSAGES ?? '20', 10)

const model = env.OPENAI_MODEL ?? 'gpt-4o-mini'
const systemPrompt = env.SYSTEM_PROMPT ?? 'You are a helpful assistant.'
const requireMention =
  (env.DISCORD_REQUIRE_MENTION ?? 'true').toLowerCase() !== 'false'
const commandGuildId = env.DISCORD_GUILD_ID?.trim() || null
const allowedChannelIds = new Set(
  (env.DISCORD_ALLOWED_CHANNEL_IDS ?? '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean),
)

const sessions = new Map<string, SessionState>()
const slashCommands = [
  {
    name: 'clear',
    description: 'Clear chat memory for this channel',
  },
  {
    name: 'skills',
    description: 'List loaded skills',
  },
]
const mcpTools = new McpToolManager()
const skillManager = new SkillManager()

function formatRequestError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error)
  }

  const apiError = error as Error & {
    status?: number
    request_id?: string
    code?: string
    type?: string
  }

  const parts: string[] = [apiError.message]

  if (typeof apiError.status === 'number') {
    parts.push(`status=${apiError.status}`)
  }
  if (apiError.request_id) {
    parts.push(`request_id=${apiError.request_id}`)
  }
  if (apiError.code) {
    parts.push(`code=${apiError.code}`)
  }
  if (apiError.type) {
    parts.push(`type=${apiError.type}`)
  }

  return parts.join(' | ')
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

function trimHistory(history: Turn[]): Turn[] {
  if (!Number.isFinite(maxHistoryMessages) || maxHistoryMessages <= 0) {
    return history
  }
  if (history.length <= maxHistoryMessages) {
    return history
  }
  return history.slice(history.length - maxHistoryMessages)
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

async function askWithChat(
  session: SessionState,
  userInput: string,
): Promise<string> {
  const skillInstruction = skillManager.buildSkillInstruction(userInput)
  const combinedSystemPrompt = skillInstruction
    ? `${systemPrompt}\n\n${skillInstruction}`
    : systemPrompt

  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: combinedSystemPrompt },
    ...session.turns.map(turn => ({
      role: turn.role,
      content: turn.content,
    })),
  ]

  const tools = mcpTools.getOpenAITools()
  const maxToolRounds = 6

  for (let round = 0; round < maxToolRounds; round += 1) {
    const completion = await client.chat.completions.create({
      model,
      messages: messages as never,
      ...(tools.length > 0
        ? { tools: tools as never, tool_choice: 'auto' as const }
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

    for (const call of toolCalls) {
      if (call.type !== 'function') {
        continue
      }
      const args = parseToolArguments(call.function.arguments ?? '')
      const toolResult = await mcpTools.callOpenAITool(call.function.name, args)
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
): Promise<{ answer: string }> {
  const session = getSession(sessionId)
  session.turns.push({ role: 'user', content: userInput })
  session.turns = trimHistory(session.turns)

  try {
    const answer = await askWithChat(session, userInput)
    session.turns.push({ role: 'assistant', content: answer })
    session.turns = trimHistory(session.turns)
    return { answer }
  } catch (error) {
    session.turns.pop()
    throw error
  }
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

function stripBotMention(content: string, botUserId: string): string {
  const escapedUserId = botUserId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const mentionPattern = new RegExp(`<@!?${escapedUserId}>`, 'g')
  return content.replace(mentionPattern, '').trim()
}

function isWritableTextChannel(
  channel: Message['channel'],
): channel is Message['channel'] & SendableChannel {
  return (
    channel.isTextBased() &&
    'send' in channel &&
    typeof channel.send === 'function' &&
    'sendTyping' in channel &&
    typeof channel.sendTyping === 'function'
  )
}

async function handleMessage(
  discordClient: DiscordClient,
  message: Message,
): Promise<void> {
  if (message.author.bot || message.system) {
    return
  }

  if (allowedChannelIds.size > 0 && !allowedChannelIds.has(message.channelId)) {
    return
  }

  const isDM = message.guildId === null
  let userInput = message.content.trim()
  if (!userInput) {
    return
  }

  if (!isDM && requireMention) {
    const botUserId = discordClient.user?.id
    if (!botUserId || !message.mentions.users.has(botUserId)) {
      return
    }
    userInput = stripBotMention(userInput, botUserId)
    if (!userInput) {
      return
    }
  }

  const sessionId = message.channelId

  if (!isWritableTextChannel(message.channel)) {
    return
  }

  const channel = message.channel

  try {
    await channel.sendTyping()
    const { answer } = await generateReply(sessionId, userInput)

    const chunks = splitDiscordMessage(answer)
    for (let idx = 0; idx < chunks.length; idx += 1) {
      const chunk = chunks[idx]
      if (idx === 0) {
        await message.reply({
          content: chunk,
          allowedMentions: { repliedUser: false },
        })
      } else {
        await channel.send(chunk)
      }
    }
  } catch (error) {
    const formatted = formatRequestError(error)
    console.error(`LLM request failed: ${formatted}`)
    await message.reply({
      content: `Request failed: ${formatted}`,
      allowedMentions: { repliedUser: false },
    })
  }
}

async function handleSlashCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (interaction.commandName === 'skills') {
    const summaries = skillManager.getSummaries()
    const content =
      summaries.length === 0
        ? 'No skills loaded from .agents/skills.'
        : summaries
            .map(skill =>
              skill.description
                ? `- ${skill.name} (${skill.id}): ${skill.description}`
                : `- ${skill.name} (${skill.id})`,
            )
            .join('\n')

    await interaction.reply({
      content,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  if (interaction.commandName === 'clear') {
    const channelId = interaction.channelId
    const cleared = clearSession(channelId)
    const content = cleared
      ? 'Context cleared for this channel.'
      : 'No stored context for this channel.'

    await interaction.reply({
      content,
      flags: MessageFlags.Ephemeral,
    })
    return
  }
}

async function registerSlashCommands(
  discordClient: DiscordClient,
): Promise<void> {
  if (!discordClient.application) {
    throw new Error('Discord application is not ready.')
  }

  if (commandGuildId) {
    await discordClient.application.commands.set(slashCommands, commandGuildId)
    console.log(`Registered slash commands in guild: ${commandGuildId}`)
    return
  }

  await discordClient.application.commands.set(slashCommands)
  console.log('Registered global slash commands')
}

async function run(): Promise<void> {
  const mcpLoad = await mcpTools.loadFromConfig()
  const skillLoad = await skillManager.loadFromConfigDir()

  const discordClient = new DiscordClient({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  })

  discordClient.once('clientReady', ready => {
    void (async () => {
      await registerSlashCommands(discordClient)
      console.log('Discord gateway online')
      console.log(`Bot: ${ready.user.tag}`)
      console.log(`Model: ${model}`)
      if (baseURL) {
        console.log(`Base URL: ${baseURL}`)
      }
      console.log(`Require mention in guild: ${requireMention}`)
      if (commandGuildId) {
        console.log(`Slash command scope: guild ${commandGuildId}`)
      } else {
        console.log('Slash command scope: global')
      }
      if (allowedChannelIds.size > 0) {
        console.log(
          `Allowed channels: ${Array.from(allowedChannelIds).join(', ')}`,
        )
      }
      if (mcpLoad.configured) {
        console.log(
          `MCP: ${mcpLoad.loadedServers} servers, ${mcpLoad.loadedTools} tools loaded`,
        )
      } else {
        console.log('MCP: disabled (missing .agents/mcp.json or no servers)')
      }
      if (skillLoad.configured) {
        console.log(`Skills: ${skillLoad.loadedSkills} loaded`)
      } else {
        console.log('Skills: disabled (missing .agents/skills)')
      }
    })().catch(error => {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`Failed to initialize Discord bot: ${message}`)
    })
  })

  discordClient.on('messageCreate', message => {
    void handleMessage(discordClient, message)
  })

  discordClient.on('interactionCreate', interaction => {
    if (!interaction.isChatInputCommand()) {
      return
    }
    void handleSlashCommand(interaction)
  })

  await discordClient.login(botToken)
}

run().catch(error => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`Fatal error: ${message}`)
  void mcpTools.closeAll()
  process.exit(1)
})
