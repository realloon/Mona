import OpenAI from 'openai'
import { env, file } from 'bun'
import { Client as DiscordClient, GatewayIntentBits, Partials } from 'discord.js'
import { McpToolManager } from './mcp.js'
import { TaskScheduler } from './scheduler.js'
import { SkillManager } from './skills.js'
import { FunctionToolManager } from './tools/index.js'
import { createApprovalHandlers } from './gateway/approvals.js'
import { createChatEngine } from './gateway/chat-engine.js'
import {
  createInteractionHandler,
  createSlashCommandHandler,
  registerSlashCommands,
} from './gateway/interaction-handler.js'
import { createMessageHandler } from './gateway/message-handler.js'

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
const systemPromptPath = `${process.cwd()}/.agents/system.xml`
const systemPromptFile = file(systemPromptPath)
if (!(await systemPromptFile.exists())) {
  console.error(`Missing system prompt file: ${systemPromptPath}`)
  process.exit(1)
}
const systemPrompt = (await systemPromptFile.text()).trim()
if (!systemPrompt) {
  console.error(`System prompt file is empty: ${systemPromptPath}`)
  process.exit(1)
}

const maxHistoryMessages = Number.parseInt(env.MAX_HISTORY_MESSAGES ?? '20', 10)
const terminalApprovalTimeoutMs = Number.parseInt(
  env.TERMINAL_APPROVAL_TIMEOUT_MS ?? '30000',
  10,
)

const model = env.OPENAI_MODEL ?? 'gpt-4o-mini'
const skillRouterModel = env.SKILL_ROUTER_MODEL ?? model
const schedulerIntervalMs = Number.parseInt(
  env.TASK_SCHEDULER_INTERVAL_MS ?? '10000',
  10,
)
const defaultTaskTimezone =
  env.TASK_DEFAULT_TIMEZONE?.trim() ||
  Intl.DateTimeFormat().resolvedOptions().timeZone ||
  'UTC'
const requireMention =
  (env.DISCORD_REQUIRE_MENTION ?? 'true').toLowerCase() !== 'false'
const commandGuildId = env.DISCORD_GUILD_ID?.trim() || null
const allowedChannelIds = new Set(
  (env.DISCORD_ALLOWED_CHANNEL_IDS ?? '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean),
)

const mcpTools = new McpToolManager()
const skillManager = new SkillManager()
const functionTools = new FunctionToolManager({
  projectRoot: process.cwd(),
  defaultTimeoutMs: Number.parseInt(env.TERMINAL_TOOL_TIMEOUT_MS ?? '15000', 10),
  maxOutputChars: Number.parseInt(
    env.TERMINAL_TOOL_MAX_OUTPUT_CHARS ?? '12000',
    10,
  ),
})

async function run(): Promise<void> {
  let mcpLoad
  try {
    mcpLoad = await mcpTools.loadFromConfig()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`MCP initialization failed: ${message}`)
  }

  let skillLoad
  try {
    skillLoad = await skillManager.loadFromConfigDir()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Skills initialization failed: ${message}`)
  }

  const discordClient = new DiscordClient({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  })

  const approvals = createApprovalHandlers({
    terminalApprovalTimeoutMs,
  })

  const chatEngine = createChatEngine({
    client,
    systemPrompt,
    model,
    skillRouterModel,
    maxHistoryMessages,
    mcpTools,
    skillManager,
    functionTools,
  })

  const handleMessage = createMessageHandler({
    discordClient,
    generateReply: chatEngine.generateReply,
    requestDangerousCommandApproval: approvals.requestDangerousCommandApproval,
    requestTaskCreateApproval: approvals.requestTaskCreateApproval,
    allowedChannelIds,
    requireMention,
    defaultTaskTimezone,
  })

  const handleSlashCommand = createSlashCommandHandler({
    mcpTools,
    skillManager,
    clearSession: chatEngine.clearSession,
  })

  const handleInteraction = createInteractionHandler({
    handleApprovalButton: approvals.handleApprovalButton,
    handleSlashCommand,
  })

  const taskScheduler = new TaskScheduler({
    projectRoot: process.cwd(),
    intervalMs: schedulerIntervalMs,
    openaiClient: client,
    defaultModel: model,
    discordClient,
  })

  discordClient.once('clientReady', ready => {
    void (async () => {
      await registerSlashCommands(discordClient, commandGuildId)
      taskScheduler.start()
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
      console.log(functionTools.getStatusSummary())
      if (skillLoad.loadedSkills > 0) {
        console.log(`Skills: ${skillLoad.loadedSkills} loaded`)
      } else {
        console.log('Skills: 0 loaded')
      }
      console.log(`Task scheduler: running (interval=${schedulerIntervalMs}ms)`)
    })().catch(error => {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`Failed to initialize Discord bot: ${message}`)
      taskScheduler.stop()
    })
  })

  discordClient.on('messageCreate', message => {
    void handleMessage(message)
  })

  discordClient.on('interactionCreate', interaction => {
    void handleInteraction(interaction)
  })

  try {
    await discordClient.login(botToken)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Discord login failed: ${message}`)
  }
}

run().catch(error => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`Fatal error: ${message}`)
  void mcpTools.closeAll()
  process.exit(1)
})
