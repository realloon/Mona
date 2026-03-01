export type OpenAIFunctionTool = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export type DangerousCommandRequest = {
  command: string
  cwd: string
  reason: string
}

export type TaskCreateApprovalRequest = {
  name: string
  channelId: string
  scheduleSummary: string
  actionSummary: string
  nextRunAt: string
}

export type TaskToolContext = {
  channelId?: string
  requesterUserId?: string
  timezone?: string
}

export type FunctionToolCallHooks = {
  confirmDangerousCommand?: (
    request: DangerousCommandRequest,
  ) => Promise<boolean>
  confirmTaskCreate?: (request: TaskCreateApprovalRequest) => Promise<boolean>
  taskContext?: TaskToolContext
}

export type FunctionToolRuntime = {
  projectRoot: string
  defaultTimeoutMs: number
  maxOutputChars: number
}

export type FunctionToolOptions = {
  projectRoot: string
  defaultTimeoutMs: number
  maxOutputChars: number
}
