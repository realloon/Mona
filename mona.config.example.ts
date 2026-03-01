import { defineConfig } from './app/types/config.js'

export default defineConfig({
  openai: {
    apiKey: 'replace-with-openai-api-key',
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    skillRouterModel: 'gpt-4o-mini',
  },
  discord: {
    botToken: 'replace-with-discord-bot-token',
    requireMention: true,
    guildId: null,
    allowedChannelIds: [],
  },
  chat: {
    maxHistoryMessages: 20,
  },
  approvals: {
    terminalApprovalTimeoutMs: 30000,
  },
  scheduler: {
    intervalMs: 10000,
    defaultTimezone: 'Asia/Shanghai',
  },
  tools: {
    defaultTimeoutMs: 15000,
    maxOutputChars: 12000,
  },
})
