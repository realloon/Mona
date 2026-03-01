import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ButtonInteraction,
  type Message,
} from 'discord.js'
import type {
  DangerousCommandRequest,
  TaskCreateApprovalRequest,
} from '../types/tools.js'

type PendingApproval = {
  requesterUserId: string
  resolve: (approved: boolean) => void
  timeout: ReturnType<typeof setTimeout>
  promptMessageId: string
  commandPreview: string
}

type PendingTaskCreateApproval = {
  requesterUserId: string
  resolve: (approved: boolean) => void
  timeout: ReturnType<typeof setTimeout>
  promptMessageId: string
  summary: string
}

type ParsedDecision = {
  approvalId: string
  decision: 'yes' | 'no'
}

type CreateApprovalHandlersOptions = {
  terminalApprovalTimeoutMs: number
}

export type ApprovalHandlers = {
  requestDangerousCommandApproval: (
    message: Message,
    request: DangerousCommandRequest,
  ) => Promise<boolean>
  requestTaskCreateApproval: (
    message: Message,
    request: TaskCreateApprovalRequest,
  ) => Promise<boolean>
  handleApprovalButton: (interaction: ButtonInteraction) => Promise<void>
}

const RUN_APPROVAL_CUSTOM_ID_PREFIX = 'builtin-run-approval'
const TASK_CREATE_APPROVAL_CUSTOM_ID_PREFIX = 'builtin-task-create-approval'

function clampPositiveInt(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback
  }
  return Math.floor(value)
}

function truncatePreview(input: string, max = 240): string {
  const clean = input.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) {
    return clean
  }
  return `${clean.slice(0, max - 15)}...(truncated)`
}

function buildDecisionCustomId(
  prefix: string,
  id: string,
  decision: 'yes' | 'no',
): string {
  return `${prefix}:${id}:${decision}`
}

function parseDecisionCustomId(
  prefix: string,
  customId: string,
): ParsedDecision | null {
  const parts = customId.split(':')
  if (
    parts.length !== 3 ||
    parts[0] !== prefix ||
    !parts[1] ||
    (parts[2] !== 'yes' && parts[2] !== 'no')
  ) {
    return null
  }

  return {
    approvalId: parts[1],
    decision: parts[2],
  }
}

export function createApprovalHandlers(
  options: CreateApprovalHandlersOptions,
): ApprovalHandlers {
  const pendingApprovals = new Map<string, PendingApproval>()
  const pendingTaskCreateApprovals = new Map<string, PendingTaskCreateApproval>()

  function buildApprovalComponents(prefix: string, approvalId: string) {
    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(buildDecisionCustomId(prefix, approvalId, 'yes'))
          .setLabel('Yes')
          .setStyle(
            prefix === RUN_APPROVAL_CUSTOM_ID_PREFIX
              ? ButtonStyle.Danger
              : ButtonStyle.Success,
          ),
        new ButtonBuilder()
          .setCustomId(buildDecisionCustomId(prefix, approvalId, 'no'))
          .setLabel('No')
          .setStyle(ButtonStyle.Secondary),
      ),
    ]
  }

  async function requestDangerousCommandApproval(
    message: Message,
    request: DangerousCommandRequest,
  ): Promise<boolean> {
    const approvalId = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
    const timeoutMs = clampPositiveInt(options.terminalApprovalTimeoutMs, 30000)
    const commandPreview = truncatePreview(request.command, 280)

    const prompt = await message.reply({
      content: [
        'Dangerous command needs confirmation.',
        `Reason: ${request.reason}`,
        `cwd: ${request.cwd}`,
        `command: \`${commandPreview}\``,
        'Approve this execution?',
      ].join('\n'),
      components: buildApprovalComponents(RUN_APPROVAL_CUSTOM_ID_PREFIX, approvalId),
      allowedMentions: { repliedUser: false },
    })

    return await new Promise<boolean>(resolve => {
      const timeout = setTimeout(() => {
        const pending = pendingApprovals.get(approvalId)
        if (!pending) {
          return
        }
        pendingApprovals.delete(approvalId)
        pending.resolve(false)
        void prompt.edit({
          content: [
            'Dangerous command approval timed out.',
            `command: \`${pending.commandPreview}\``,
          ].join('\n'),
          components: [],
        })
      }, timeoutMs)

      pendingApprovals.set(approvalId, {
        requesterUserId: message.author.id,
        resolve,
        timeout,
        promptMessageId: prompt.id,
        commandPreview,
      })
    })
  }

  async function requestTaskCreateApproval(
    message: Message,
    request: TaskCreateApprovalRequest,
  ): Promise<boolean> {
    const approvalId = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
    const timeoutMs = clampPositiveInt(options.terminalApprovalTimeoutMs, 30000)
    const summary = [
      `name: ${request.name}`,
      `channel_id: ${request.channelId}`,
      `schedule: ${request.scheduleSummary}`,
      `action: ${request.actionSummary}`,
      `next_run_at: ${request.nextRunAt}`,
    ].join('\n')

    const prompt = await message.reply({
      content: [
        'Task creation needs confirmation.',
        summary,
        'Create this scheduled task?',
      ].join('\n'),
      components: buildApprovalComponents(
        TASK_CREATE_APPROVAL_CUSTOM_ID_PREFIX,
        approvalId,
      ),
      allowedMentions: { repliedUser: false },
    })

    return await new Promise<boolean>(resolve => {
      const timeout = setTimeout(() => {
        const pending = pendingTaskCreateApprovals.get(approvalId)
        if (!pending) {
          return
        }
        pendingTaskCreateApprovals.delete(approvalId)
        pending.resolve(false)
        void prompt.edit({
          content: ['Task creation approval timed out.', pending.summary].join('\n'),
          components: [],
        })
      }, timeoutMs)

      pendingTaskCreateApprovals.set(approvalId, {
        requesterUserId: message.author.id,
        resolve,
        timeout,
        promptMessageId: prompt.id,
        summary,
      })
    })
  }

  async function handleRunApprovalButton(
    interaction: ButtonInteraction,
    parsed: ParsedDecision,
  ): Promise<void> {
    const pending = pendingApprovals.get(parsed.approvalId)
    if (!pending) {
      await interaction.reply({
        content: 'This approval request has expired.',
        flags: MessageFlags.Ephemeral,
      })
      return
    }

    if (pending.promptMessageId !== interaction.message.id) {
      await interaction.reply({
        content: 'Approval message mismatch.',
        flags: MessageFlags.Ephemeral,
      })
      return
    }

    if (interaction.user.id !== pending.requesterUserId) {
      await interaction.reply({
        content: 'Only the original requester can approve this command.',
        flags: MessageFlags.Ephemeral,
      })
      return
    }

    clearTimeout(pending.timeout)
    pendingApprovals.delete(parsed.approvalId)

    const approved = parsed.decision === 'yes'
    pending.resolve(approved)

    await interaction.update({
      content: approved
        ? `Dangerous command approved.\ncommand: \`${pending.commandPreview}\``
        : `Dangerous command rejected.\ncommand: \`${pending.commandPreview}\``,
      components: [],
    })
  }

  async function handleTaskCreateApprovalButton(
    interaction: ButtonInteraction,
    parsed: ParsedDecision,
  ): Promise<void> {
    const pending = pendingTaskCreateApprovals.get(parsed.approvalId)
    if (!pending) {
      await interaction.reply({
        content: 'This task approval request has expired.',
        flags: MessageFlags.Ephemeral,
      })
      return
    }

    if (pending.promptMessageId !== interaction.message.id) {
      await interaction.reply({
        content: 'Task approval message mismatch.',
        flags: MessageFlags.Ephemeral,
      })
      return
    }

    if (interaction.user.id !== pending.requesterUserId) {
      await interaction.reply({
        content: 'Only the original requester can approve this task.',
        flags: MessageFlags.Ephemeral,
      })
      return
    }

    clearTimeout(pending.timeout)
    pendingTaskCreateApprovals.delete(parsed.approvalId)

    const approved = parsed.decision === 'yes'
    pending.resolve(approved)

    await interaction.update({
      content: approved
        ? ['Task creation approved.', pending.summary].join('\n')
        : ['Task creation rejected.', pending.summary].join('\n'),
      components: [],
    })
  }

  async function handleApprovalButton(interaction: ButtonInteraction): Promise<void> {
    const runParsed = parseDecisionCustomId(
      RUN_APPROVAL_CUSTOM_ID_PREFIX,
      interaction.customId,
    )
    if (runParsed) {
      await handleRunApprovalButton(interaction, runParsed)
      return
    }

    const taskParsed = parseDecisionCustomId(
      TASK_CREATE_APPROVAL_CUSTOM_ID_PREFIX,
      interaction.customId,
    )
    if (taskParsed) {
      await handleTaskCreateApprovalButton(interaction, taskParsed)
    }
  }

  return {
    requestDangerousCommandApproval,
    requestTaskCreateApproval,
    handleApprovalButton,
  }
}
