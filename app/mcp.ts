import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { OpenAIFunctionTool } from './types/tools.js'

type McpServerConfig = {
  url?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}

type McpToolBinding = {
  openaiToolName: string
  mcpServerName: string
  mcpToolName: string
  description?: string
  inputSchema?: unknown
  client: McpClient
}

type McpLoadResult = {
  configured: boolean
  loadedServers: number
  loadedTools: number
}

type McpServerState = {
  name: string
  enabled: boolean
  toolCount: number
}

type PersistedMcpState = {
  disabledServers: string[]
}

function sanitizeName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  return sanitized.length > 0 ? sanitized : 'tool'
}

function defaultJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {},
    additionalProperties: true,
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeServerConfig(
  serverName: string,
  raw: unknown,
): McpServerConfig {
  if (!isObject(raw)) {
    throw new Error(
      `Invalid MCP config for "${serverName}": expected an object.`,
    )
  }

  const commandRaw = raw.command
  const urlRaw = raw.url
  const hasCommand = typeof commandRaw === 'string' && !!commandRaw.trim()
  const hasUrl = typeof urlRaw === 'string' && !!urlRaw.trim()
  if (!hasCommand && !hasUrl) {
    throw new Error(
      `Invalid MCP config for "${serverName}": either "command" or "url" is required.`,
    )
  }

  const argsRaw = raw.args
  const cwdRaw = raw.cwd
  const envRaw = raw.env

  const args =
    Array.isArray(argsRaw) && argsRaw.every(v => typeof v === 'string')
      ? argsRaw
      : undefined
  const cwd = typeof cwdRaw === 'string' && cwdRaw.trim() ? cwdRaw : undefined

  let env: Record<string, string> | undefined
  if (isObject(envRaw)) {
    env = {}
    for (const [key, value] of Object.entries(envRaw)) {
      if (typeof value === 'string') {
        env[key] = value
      }
    }
  }

  return {
    command: hasCommand ? commandRaw.trim() : undefined,
    url: hasUrl ? urlRaw.trim() : undefined,
    args,
    cwd,
    env,
  }
}

function parseMcpServersFromJson(
  parsed: unknown,
): Record<string, McpServerConfig> {
  if (!isObject(parsed)) {
    throw new Error('MCP config must be a JSON object.')
  }

  const sourceRoot = isObject(parsed.mcpServers)
    ? (parsed.mcpServers as Record<string, unknown>)
    : parsed

  const servers: Record<string, McpServerConfig> = {}
  for (const [serverName, rawConfig] of Object.entries(sourceRoot)) {
    servers[serverName] = normalizeServerConfig(serverName, rawConfig)
  }

  return servers
}

async function readMcpServersFromConfigFile(): Promise<{
  servers: Record<string, McpServerConfig>
}> {
  const configPath = `${process.cwd()}/.agents/mcp.json`
  const configFile = Bun.file(configPath)

  try {
    if (!(await configFile.exists())) {
      return { servers: {} }
    }

    const content = await configFile.text()
    const parsed = JSON.parse(content)
    return {
      servers: parseMcpServersFromJson(parsed),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to load MCP config from ${configPath}: ${message}`)
  }
}

function getMcpStateFilePath(): string {
  return `${process.cwd()}/.agents/mcp.state.json`
}

function normalizePersistedState(raw: unknown): PersistedMcpState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { disabledServers: [] }
  }

  const obj = raw as { disabledServers?: unknown }
  const disabledServers = Array.isArray(obj.disabledServers)
    ? obj.disabledServers.filter(v => typeof v === 'string')
    : []

  return {
    disabledServers: Array.from(new Set(disabledServers)),
  }
}

async function readMcpStateFile(): Promise<PersistedMcpState> {
  const statePath = getMcpStateFilePath()
  const stateFile = Bun.file(statePath)
  if (!(await stateFile.exists())) {
    return { disabledServers: [] }
  }

  try {
    const raw = await stateFile.text()
    const parsed = JSON.parse(raw)
    return normalizePersistedState(parsed)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to parse MCP state file ${statePath}: ${message}`)
  }
}

async function writeMcpStateFile(state: PersistedMcpState): Promise<void> {
  const statePath = getMcpStateFilePath()
  const content = `${JSON.stringify(state, null, 2)}\n`
  await Bun.write(statePath, content, { createPath: true })
}

function normalizeToolContent(result: unknown): string {
  if (!result || typeof result !== 'object') {
    return String(result ?? '')
  }

  const obj = result as {
    content?: unknown
    structuredContent?: unknown
    isError?: boolean
  }

  const chunks: string[] = []
  if (Array.isArray(obj.content)) {
    for (const item of obj.content) {
      if (!item || typeof item !== 'object') {
        continue
      }
      const typed = item as { type?: string; text?: string }
      if (typed.type === 'text' && typeof typed.text === 'string') {
        chunks.push(typed.text)
      } else {
        chunks.push(JSON.stringify(item))
      }
    }
  }

  if (obj.structuredContent !== undefined) {
    chunks.push(
      `structuredContent: ${JSON.stringify(obj.structuredContent, null, 2)}`,
    )
  }

  if (chunks.length === 0) {
    chunks.push(JSON.stringify(result, null, 2))
  }

  const combined = chunks.join('\n').trim()
  if (obj.isError) {
    return `MCP tool returned error:\n${combined}`
  }
  return combined
}

export class McpToolManager {
  private configuredServers = new Map<string, McpServerConfig>()
  private disabledServers = new Set<string>()
  private readonly serverClients = new Map<string, McpClient>()
  private readonly serverTransports = new Map<string, Transport>()
  private readonly toolsByOpenAIName = new Map<string, McpToolBinding>()

  hasTools(): boolean {
    return this.toolsByOpenAIName.size > 0
  }

  toolCount(): number {
    return this.toolsByOpenAIName.size
  }

  hasOpenAITool(name: string): boolean {
    return this.toolsByOpenAIName.has(name)
  }

  isConfigured(serverName: string): boolean {
    return this.configuredServers.has(serverName)
  }

  isEnabled(serverName: string): boolean {
    return this.serverClients.has(serverName)
  }

  getServerStates(): McpServerState[] {
    const states: McpServerState[] = []
    for (const name of this.configuredServers.keys()) {
      states.push({
        name,
        enabled: this.isEnabled(name),
        toolCount: this.getToolCountForServer(name),
      })
    }
    return states.sort((a, b) => a.name.localeCompare(b.name))
  }

  getRuntimeSummary(): string {
    return `${this.serverClients.size} servers enabled, ${this.toolsByOpenAIName.size} tools loaded`
  }

  async loadFromConfig(): Promise<McpLoadResult> {
    await this.closeAll()

    const { servers } = await readMcpServersFromConfigFile()
    const entries = Object.entries(servers)
    this.configuredServers = new Map(entries)
    this.disabledServers.clear()

    const persisted = await readMcpStateFile()
    for (const name of persisted.disabledServers) {
      if (this.configuredServers.has(name)) {
        this.disabledServers.add(name)
      }
    }

    if (entries.length === 0) {
      return { configured: false, loadedServers: 0, loadedTools: 0 }
    }

    for (const [serverName] of entries) {
      if (this.disabledServers.has(serverName)) {
        continue
      }
      await this.enableServer(serverName)
    }

    return {
      configured: true,
      loadedServers: this.serverClients.size,
      loadedTools: this.toolsByOpenAIName.size,
    }
  }

  async enableServer(serverName: string): Promise<void> {
    const config = this.configuredServers.get(serverName)
    if (!config) {
      throw new Error(`MCP server "${serverName}" is not configured.`)
    }
    this.disabledServers.delete(serverName)
    if (this.serverClients.has(serverName)) {
      await this.persistState()
      return
    }
    await this.connectServer(serverName, config)
    await this.persistState()
  }

  async disableServer(serverName: string): Promise<void> {
    if (!this.configuredServers.has(serverName)) {
      throw new Error(`MCP server "${serverName}" is not configured.`)
    }
    this.disabledServers.add(serverName)
    await this.disconnectServer(serverName)
    await this.persistState()
  }

  async closeAll(): Promise<void> {
    const names = Array.from(this.serverTransports.keys())
    for (const name of names) {
      await this.disconnectServer(name)
    }
  }

  getOpenAITools(): OpenAIFunctionTool[] {
    return Array.from(this.toolsByOpenAIName.values()).map(tool => ({
      type: 'function',
      function: {
        name: tool.openaiToolName,
        description:
          tool.description?.trim() ||
          `MCP tool ${tool.mcpServerName}/${tool.mcpToolName}`,
        parameters:
          tool.inputSchema &&
          typeof tool.inputSchema === 'object' &&
          !Array.isArray(tool.inputSchema)
            ? (tool.inputSchema as Record<string, unknown>)
            : defaultJsonSchema(),
      },
    }))
  }

  async callOpenAITool(name: string, args: unknown): Promise<string> {
    const binding = this.toolsByOpenAIName.get(name)
    if (!binding) {
      return `Unknown MCP tool mapping: ${name}`
    }

    try {
      const normalizedArgs =
        args && typeof args === 'object' && !Array.isArray(args) ? args : {}
      const result = await binding.client.callTool({
        name: binding.mcpToolName,
        arguments: normalizedArgs as Record<string, unknown>,
      })
      return normalizeToolContent(result)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return `MCP tool call failed (${binding.mcpServerName}/${binding.mcpToolName}): ${message}`
    }
  }

  private async connectServer(
    serverName: string,
    config: McpServerConfig,
  ): Promise<void> {
    let transport: Transport
    if (config.url) {
      transport = new StreamableHTTPClientTransport(new URL(config.url))
    } else if (config.command && config.command.trim()) {
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        cwd: config.cwd,
        env: config.env,
        stderr: 'inherit',
      })
    } else {
      throw new Error(
        `MCP server "${serverName}" must define either "url" or "command"`,
      )
    }

    const client = new McpClient(
      { name: 'mona-mcp-client', version: '0.1.0' },
      { capabilities: {} },
    )

    await client.connect(transport)
    const listed = await client.listTools()

    this.serverTransports.set(serverName, transport)
    this.serverClients.set(serverName, client)

    for (const tool of listed.tools) {
      const mappedName = this.buildUniqueOpenAIToolName(serverName, tool.name)
      this.toolsByOpenAIName.set(mappedName, {
        openaiToolName: mappedName,
        mcpServerName: serverName,
        mcpToolName: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        client,
      })
    }
  }

  private async disconnectServer(serverName: string): Promise<void> {
    const transport = this.serverTransports.get(serverName)
    if (!transport) {
      return
    }

    try {
      await transport.close()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`Failed to close MCP transport ${serverName}: ${message}`)
    }

    this.serverTransports.delete(serverName)
    this.serverClients.delete(serverName)

    for (const [openaiName, binding] of this.toolsByOpenAIName) {
      if (binding.mcpServerName === serverName) {
        this.toolsByOpenAIName.delete(openaiName)
      }
    }
  }

  private getToolCountForServer(serverName: string): number {
    let count = 0
    for (const binding of this.toolsByOpenAIName.values()) {
      if (binding.mcpServerName === serverName) {
        count += 1
      }
    }
    return count
  }

  private async persistState(): Promise<void> {
    const disabledServers = Array.from(this.disabledServers)
      .filter(name => this.configuredServers.has(name))
      .sort((a, b) => a.localeCompare(b))

    await writeMcpStateFile({ disabledServers })
  }

  private buildUniqueOpenAIToolName(
    serverName: string,
    toolName: string,
  ): string {
    const base = `${sanitizeName(serverName)}__${sanitizeName(toolName)}`
    const maxLen = 64
    let candidate = base.slice(0, maxLen)
    let suffix = 1

    while (this.toolsByOpenAIName.has(candidate)) {
      const suffixText = `_${suffix}`
      const allowedLen = maxLen - suffixText.length
      candidate = `${base.slice(0, allowedLen)}${suffixText}`
      suffix += 1
    }

    return candidate
  }
}

export function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw || !raw.trim()) {
    return {}
  }

  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return {}
  } catch {
    return {}
  }
}
