type LoadedSkill = {
  id: string
  name: string
  description?: string
  path: string
  content: string
  aliases: string[]
}

type SkillLoadResult = {
  configured: boolean
  loadedSkills: number
}

function normalizeToken(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]/g, '')
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

  async loadFromConfigDir(): Promise<SkillLoadResult> {
    const skillsRoot = `${process.cwd()}/.agents/skills`
    this.skills.length = 0

    const glob = new Bun.Glob('**/SKILL.md')
    try {
      for await (const relativePath of glob.scan({ cwd: skillsRoot })) {
        const absolutePath = `${skillsRoot}/${relativePath}`
        const raw = (await Bun.file(absolutePath).text()).trim()
        if (!raw) {
          continue
        }

        const { metadata, body } = parseFrontmatter(raw)
        const folderName = relativePath.split('/')[0] ?? relativePath
        const id = normalizeToken(metadata.name || folderName) || folderName
        const name = metadata.name?.trim() || folderName
        const description = metadata.description?.trim()

        const aliases = dedupe([
          normalizeToken(id),
          normalizeToken(name),
          normalizeToken(folderName),
        ]).filter(Boolean)

        this.skills.push({
          id,
          name,
          description,
          path: absolutePath,
          content: body.trim(),
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

  getSummaries(): Array<{ id: string; name: string; description?: string }> {
    return this.skills.map(skill => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
    }))
  }

  buildSkillInstruction(userInput: string): string {
    if (this.skills.length === 0) {
      return ''
    }

    const selected = this.skills.filter(skill =>
      shouldSelectSkillByText(userInput, skill.aliases),
    )

    if (selected.length === 0) {
      return ''
    }

    const blocks = selected.map(skill => {
      const header = `Skill: ${skill.name}${skill.description ? ` - ${skill.description}` : ''}`
      return `${header}\n${skill.content}`
    })

    return `Apply the following skill instructions for this request:\n\n${blocks.join('\n\n')}`
  }
}
