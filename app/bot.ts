import OpenAI from 'openai'
import { file } from 'bun'
import { Client as DiscordClient, GatewayIntentBits, Partials } from 'discord.js'
import config from '../mona.config'
import { McpToolManager } from './mcp'
import { TaskScheduler } from './scheduler'
import { SkillManager } from './skills'
import { FunctionToolManager } from './tools'
import { createApprovalHandlers } from './gateway/approvals'
import { createChatEngine } from './gateway/chat-engine'
import {
  createInteractionHandler,
  createSlashCommandHandler,
  registerSlashCommands,
} from './gateway/interaction-handler'
import { createMessageHandler } from './gateway/message-handler'
import { toErrorMessage } from './utils/errors'

const client = new OpenAI({
  apiKey: config.openai.apiKey,
  baseURL: config.openai.baseURL,
})
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

const model = config.openai.model
const skillRouterModel = config.openai.skillRouterModel || model
const terminalApprovalTimeoutMs = config.approvals.terminalApprovalTimeoutMs
const promptLogEnabled = config.devMode.enabled
const schedulerIntervalMs = config.scheduler.intervalMs
const defaultTaskTimezone = config.scheduler.defaultTimezone
const requireMention = config.discord.requireMention
const commandGuildId = config.discord.guildId
const allowedChannelIds = new Set(config.discord.allowedChannelIds)

const mcpTools = new McpToolManager()
const skillManager = new SkillManager()
const functionTools = new FunctionToolManager({
  projectRoot: process.cwd(),
  defaultTimeoutMs: config.tools.defaultTimeoutMs,
  maxOutputChars: config.tools.maxOutputChars,
})

async function run(): Promise<void> {
  let mcpLoad
  try {
    mcpLoad = await mcpTools.loadFromConfig()
  } catch (error) {
    const message = toErrorMessage(error)
    throw new Error(`MCP initialization failed: ${message}`)
  }

  let skillLoad
  try {
    skillLoad = await skillManager.loadFromConfigDir()
  } catch (error) {
    const message = toErrorMessage(error)
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
    projectRoot: process.cwd(),
    promptLogEnabled,
    client,
    systemPrompt,
    model,
    skillRouterModel,
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
      if (config.openai.baseURL) {
        console.log(`Base URL: ${config.openai.baseURL}`)
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
      if (promptLogEnabled) {
        console.log('Prompt logging: enabled (.agents/debug/prompts.jsonl)')
      }
    })().catch(error => {
      const message = toErrorMessage(error)
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
    await discordClient.login(config.discord.botToken)
  } catch (error) {
    const message = toErrorMessage(error)
    throw new Error(`Discord login failed: ${message}`)
  }
}

run().catch(error => {
  const message = toErrorMessage(error)
  console.error(`Fatal error: ${message}`)
  void mcpTools.closeAll()
  process.exit(1)
})
