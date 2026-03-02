import { file, Glob } from 'bun'

type LoadedSkill = {
  name: string
  description: string
  path: string
  aliases: string[]
}

type SkillLoadResult = {
  configured: boolean
  loadedSkills: number
}

type SkillSummary = {
  name: string
  description: string
}

type SkillPromptMetadata = SkillSummary & {
  location: string
}

function normalizeNameKey(input: string): string {
  return input.toLowerCase().trim()
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseFrontmatter(content: string): {
  metadata: Record<string, string>
  body: string
} {
  const normalized = content.replace(/\r\n/g, '\n')

  if (!normalized.startsWith('---\n')) {
    return { metadata: {}, body: normalized }
  }

  const end = normalized.indexOf('\n---\n', 4)
  if (end < 0) {
    return { metadata: {}, body: normalized }
  }

  const rawMeta = normalized.slice(4, end)
  const body = normalized.slice(end + 5)
  const metadata: Record<string, string> = {}

  for (const line of rawMeta.split('\n')) {
    const idx = line.indexOf(':')
    if (idx <= 0) {
      continue
    }
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (!key || !value) {
      continue
    }
    metadata[key] = value
  }

  return { metadata, body }
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values))
}

function escapeXml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function shouldSelectSkillByText(input: string, aliases: string[]): boolean {
  const lower = input.toLowerCase()

  for (const alias of aliases) {
    if (!alias) {
      continue
    }
    const escaped = escapeRegExp(alias.toLowerCase())
    const mentionPattern = new RegExp(`\\$${escaped}(?![a-z0-9_-])`, 'i')
    if (mentionPattern.test(lower)) {
      return true
    }

    const intentPattern = new RegExp(
      `(use|using|with)\\s+${escaped}(?![a-z0-9_-])`,
      'i',
    )
    if (intentPattern.test(lower)) {
      return true
    }
  }

  return false
}

export class SkillManager {
  private readonly skills: LoadedSkill[] = []
  private readonly bodyCache = new Map<string, string>()

  async loadFromConfigDir(): Promise<SkillLoadResult> {
    const skillsRoot = `${process.cwd()}/.agents/skills`
    this.skills.length = 0
    this.bodyCache.clear()
    const seenNames = new Map<string, string>()

    const glob = new Glob('**/SKILL.md')
    try {
      for await (const relativePath of glob.scan({ cwd: skillsRoot })) {
        const absolutePath = `${skillsRoot}/${relativePath}`
        const raw = (await file(absolutePath).text()).trim()
        if (!raw) {
          continue
        }

        const { metadata } = parseFrontmatter(raw)
        const name = metadata.name?.trim()
        if (!name) {
          throw new Error(`Skill name is required in frontmatter: ${absolutePath}`)
        }
        const nameKey = normalizeNameKey(name)
        if (!nameKey) {
          throw new Error(`Skill name is required in frontmatter: ${absolutePath}`)
        }
        const duplicatePath = seenNames.get(nameKey)
        if (duplicatePath) {
          throw new Error(
            `Duplicate skill name "${name}" in frontmatter: ${duplicatePath} and ${absolutePath}`,
          )
        }
        seenNames.set(nameKey, absolutePath)
        const description = metadata.description?.trim()
        if (!description) {
          throw new Error(
            `Skill description is required in frontmatter: ${absolutePath}`,
          )
        }

        const aliases = dedupe([name]).filter(Boolean)

        this.skills.push({
          name,
          description,
          path: absolutePath,
          aliases,
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('ENOENT')) {
        return { configured: false, loadedSkills: 0 }
      }
      throw error
    }

    return {
      configured: true,
      loadedSkills: this.skills.length,
    }
  }

  getSummaries(): SkillSummary[] {
    return this.skills.map(skill => ({
      name: skill.name,
      description: skill.description,
    }))
  }

  getPromptMetadata(): SkillPromptMetadata[] {
    return this.skills.map(skill => ({
      name: skill.name,
      description: skill.description,
      location: skill.path,
    }))
  }

  buildAvailableSkillsXml(): string {
    if (this.skills.length === 0) {
      return ''
    }

    const blocks = this.skills.map(skill =>
      [
        '  <skill>',
        `    <name>${escapeXml(skill.name)}</name>`,
        `    <description>${escapeXml(skill.description)}</description>`,
        '  </skill>',
      ].join('\n'),
    )

    return [
      '<available_skills>',
      ...blocks,
      '</available_skills>',
    ].join('\n')
  }

  selectExplicitSkillNames(userInput: string, limit = 1): string[] {
    if (this.skills.length === 0) {
      return []
    }

    const selected = this.skills
      .filter(skill => shouldSelectSkillByText(userInput, skill.aliases))
      .map(skill => skill.name)
    return this.filterKnownSkillNames(selected, limit)
  }

  filterKnownSkillNames(skillNames: string[], limit = 1): string[] {
    if (!Array.isArray(skillNames) || skillNames.length === 0) {
      return []
    }

    const knownByKey = new Map(
      this.skills.map(skill => [normalizeNameKey(skill.name), skill.name] as const),
    )
    const deduped = dedupe(skillNames)
    const normalized = dedupe(
      deduped
        .map(name => knownByKey.get(normalizeNameKey(name)) ?? '')
        .filter(Boolean),
    )

    if (!Number.isFinite(limit) || limit <= 0) {
      return normalized
    }
    return normalized.slice(0, Math.floor(limit))
  }

  private async loadSkillBody(skill: LoadedSkill): Promise<string> {
    const cached = this.bodyCache.get(skill.name)
    if (cached !== undefined) {
      return cached
    }

    const raw = await file(skill.path).text()
    const { body } = parseFrontmatter(raw)
    const trimmed = body.trim()
    this.bodyCache.set(skill.name, trimmed)
    return trimmed
  }

  async buildSkillInstructionForNames(skillNames: string[]): Promise<string> {
    const selectedNames = this.filterKnownSkillNames(skillNames, skillNames.length)
    if (selectedNames.length === 0) {
      return ''
    }

    const byKey = new Map(
      this.skills.map(skill => [normalizeNameKey(skill.name), skill] as const),
    )
    const selected = selectedNames
      .map(name => byKey.get(normalizeNameKey(name)))
      .filter((skill): skill is LoadedSkill => !!skill)

    if (selected.length === 0) {
      return ''
    }

    const blocks: string[] = []
    for (const skill of selected) {
      const content = await this.loadSkillBody(skill)
      if (!content) {
        continue
      }
      const header = `Skill: ${skill.name} - ${skill.description}`
      blocks.push(`${header}\n${content}`)
    }

    if (blocks.length === 0) {
      return ''
    }

    return `Apply the following skill instructions for this request:\n\n${blocks.join('\n\n')}`
  }

  async buildSkillInstruction(userInput: string): Promise<string> {
    const selectedNames = this.selectExplicitSkillNames(userInput)
    return await this.buildSkillInstructionForNames(selectedNames)
  }
}
