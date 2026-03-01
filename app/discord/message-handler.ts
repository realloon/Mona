import type { Client as DiscordClient, Message } from 'discord.js'
import type {
  DangerousCommandRequest,
  TaskCreateApprovalRequest,
} from '../types/tools.js'
import { formatRequestError } from '../utils/errors.js'
import type { ChatEngine } from './chat-engine.js'

type SendableChannel = {
  sendTyping: () => Promise<unknown>
  send: (content: string) => Promise<unknown>
}

type CreateMessageHandlerOptions = {
  discordClient: DiscordClient
  generateReply: ChatEngine['generateReply']
  requestDangerousCommandApproval: (
    message: Message,
    request: DangerousCommandRequest,
  ) => Promise<boolean>
  requestTaskCreateApproval: (
    message: Message,
    request: TaskCreateApprovalRequest,
  ) => Promise<boolean>
  allowedChannelIds: Set<string>
  requireMention: boolean
  defaultTaskTimezone: string
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

export function createMessageHandler(options: CreateMessageHandlerOptions) {
  return async function handleMessage(message: Message): Promise<void> {
    if (message.author.bot || message.system) {
      return
    }

    if (
      options.allowedChannelIds.size > 0 &&
      !options.allowedChannelIds.has(message.channelId)
    ) {
      return
    }

    const isDM = message.guildId === null
    let userInput = message.content.trim()
    if (!userInput) {
      return
    }

    if (!isDM && options.requireMention) {
      const botUserId = options.discordClient.user?.id
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
      const { answer } = await options.generateReply(
        sessionId,
        userInput,
        async request =>
          options.requestDangerousCommandApproval(message, request),
        async request => options.requestTaskCreateApproval(message, request),
        {
          channelId: message.channelId,
          requesterUserId: message.author.id,
          timezone: options.defaultTaskTimezone,
        },
      )

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
}
