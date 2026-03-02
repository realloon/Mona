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
  approvals: {
    terminalApprovalTimeoutMs: number
  }
  devMode: {
    enabled: boolean
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
