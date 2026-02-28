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
