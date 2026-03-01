import { describe, expect, test } from 'bun:test'
import { SkillManager } from '../app/skills.ts'

describe('SkillManager', () => {
  test('loads skills from .agents/skills', async () => {
    const manager = new SkillManager()

    const result = await manager.loadFromConfigDir()

    expect(result.configured).toBe(true)
    expect(result.loadedSkills).toBeGreaterThan(0)
    expect(manager.getSummaries().length).toBeGreaterThan(0)
  })

  test('builds instruction only when a skill is explicitly requested', async () => {
    const manager = new SkillManager()
    await manager.loadFromConfigDir()
    const [firstSkill] = manager.getSummaries()
    expect(firstSkill).toBeDefined()

    const selected = manager.buildSkillInstruction(`please use $${firstSkill!.id}`)
    expect(selected).toContain(`Skill: ${firstSkill!.name}`)

    const notSelected = manager.buildSkillInstruction('just chatting without skill mention')
    expect(notSelected).toBe('')
  })
})
