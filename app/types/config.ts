export type MonaConfig = {
  openai: {
    apiKey: string
    baseURL?: string
    model: string
    skillRouterModel?: string
  }
  discord: {
    botToken: string
    requireMention: boolean
    guildId: string | null
    allowedChannelIds: string[]
  }
  chat: {
    maxHistoryMessages: number
  }
  approvals: {
    terminalApprovalTimeoutMs: number
  }
  scheduler: {
    intervalMs: number
    defaultTimezone: string
  }
  tools: {
    defaultTimeoutMs: number
    maxOutputChars: number
  }
}

export const defineConfig = (config: MonaConfig) => config
