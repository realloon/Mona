import {
  ApplicationCommandOptionType,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client as DiscordClient,
  type Interaction,
} from 'discord.js'
import { McpToolManager } from '../mcp'
import { SkillManager } from '../skills'

const slashCommands = [
  {
    name: 'clear',
    description: 'Clear chat memory for this channel',
  },
  {
    name: 'skills',
    description: 'List loaded skills',
  },
  {
    name: 'mcp',
    description: 'Manage MCP servers',
    options: [
      {
        type: ApplicationCommandOptionType.Subcommand as const,
        name: 'list',
        description: 'List MCP server states',
      },
      {
        type: ApplicationCommandOptionType.Subcommand as const,
        name: 'enable',
        description: 'Enable one MCP server',
        options: [
          {
            type: ApplicationCommandOptionType.String as const,
            name: 'server',
            description: 'MCP server name in .agents/mcp.json',
            required: true,
          },
        ],
      },
      {
        type: ApplicationCommandOptionType.Subcommand as const,
        name: 'disable',
        description: 'Disable one MCP server',
        options: [
          {
            type: ApplicationCommandOptionType.String as const,
            name: 'server',
            description: 'MCP server name in .agents/mcp.json',
            required: true,
          },
        ],
      },
    ],
  },
]

type CreateSlashCommandHandlerOptions = {
  mcpTools: McpToolManager
  skillManager: SkillManager
  clearSession: (sessionId: string) => boolean
}

type CreateInteractionHandlerOptions = {
  handleApprovalButton: (interaction: ButtonInteraction) => Promise<void>
  handleSlashCommand: (
    interaction: ChatInputCommandInteraction,
  ) => Promise<void>
}

export async function registerSlashCommands(
  discordClient: DiscordClient,
  commandGuildId: string | null,
): Promise<void> {
  if (!discordClient.application) {
    throw new Error('Discord application is not ready.')
  }

  if (commandGuildId) {
    await discordClient.application.commands.set(slashCommands, commandGuildId)
    console.log(`Registered slash commands in guild: ${commandGuildId}`)
    return
  }

  await discordClient.application.commands.set(slashCommands)
  console.log('Registered global slash commands')
}

export function createSlashCommandHandler(options: CreateSlashCommandHandlerOptions) {
  return async function handleSlashCommand(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    if (interaction.commandName === 'mcp') {
      const subcommand = interaction.options.getSubcommand()

      if (subcommand === 'list') {
        const states = options.mcpTools.getServerStates()
        const content =
          states.length === 0
            ? 'No MCP servers configured in .agents/mcp.json.'
            : [
                `MCP runtime: ${options.mcpTools.getRuntimeSummary()}`,
                ...states.map(state =>
                  `- ${state.name}: ${state.enabled ? 'enabled' : 'disabled'} (${state.toolCount} tools)`,
                ),
              ].join('\n')

        await interaction.reply({
          content,
          flags: MessageFlags.Ephemeral,
        })
        return
      }

      const server = interaction.options.getString('server', true).trim()
      if (!server) {
        await interaction.reply({
          content: 'Missing server name.',
          flags: MessageFlags.Ephemeral,
        })
        return
      }

      if (!options.mcpTools.isConfigured(server)) {
        await interaction.reply({
          content: `MCP server "${server}" is not configured in .agents/mcp.json.`,
          flags: MessageFlags.Ephemeral,
        })
        return
      }

      try {
        if (subcommand === 'enable') {
          await options.mcpTools.enableServer(server)
          await interaction.reply({
            content: `Enabled MCP server "${server}". Runtime: ${options.mcpTools.getRuntimeSummary()}`,
            flags: MessageFlags.Ephemeral,
          })
          return
        }

        if (subcommand === 'disable') {
          await options.mcpTools.disableServer(server)
          await interaction.reply({
            content: `Disabled MCP server "${server}". Runtime: ${options.mcpTools.getRuntimeSummary()}`,
            flags: MessageFlags.Ephemeral,
          })
          return
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await interaction.reply({
          content: `MCP operation failed: ${message}`,
          flags: MessageFlags.Ephemeral,
        })
        return
      }
    }

    if (interaction.commandName === 'skills') {
      const summaries = options.skillManager.getSummaries()
      const content =
        summaries.length === 0
          ? 'No skills loaded from .agents/skills.'
          : summaries
              .map(skill => `- ${skill.name}: ${skill.description}`)
              .join('\n')

      await interaction.reply({
        content,
        flags: MessageFlags.Ephemeral,
      })
      return
    }

    if (interaction.commandName === 'clear') {
      const channelId = interaction.channelId
      const cleared = options.clearSession(channelId)
      const content = cleared
        ? 'Context cleared for this channel.'
        : 'No stored context for this channel.'

      await interaction.reply({
        content,
        flags: MessageFlags.Ephemeral,
      })
      return
    }
  }
}

export function createInteractionHandler(options: CreateInteractionHandlerOptions) {
  return async function handleInteraction(interaction: Interaction): Promise<void> {
    if (interaction.isButton()) {
      await options.handleApprovalButton(interaction)
      return
    }

    if (!interaction.isChatInputCommand()) {
      return
    }

    await options.handleSlashCommand(interaction)
  }
}
