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

export type FunctionToolCallHooks = {
  confirmDangerousCommand?: (
    request: DangerousCommandRequest,
  ) => Promise<boolean>
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
