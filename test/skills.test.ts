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

  test('selects explicit skills and builds instructions', async () => {
    const manager = new SkillManager()
    await manager.loadFromConfigDir()
    const [firstSkill] = manager.getSummaries()
    expect(firstSkill).toBeDefined()

    const selectedNames = manager.selectExplicitSkillNames(
      `please use $${firstSkill!.name}`,
    )
    expect(selectedNames).toContain(firstSkill!.name)

    const selected = await manager.buildSkillInstructionForNames(selectedNames)
    expect(selected).toContain(`Skill: ${firstSkill!.name}`)

    const notSelected = manager.selectExplicitSkillNames(
      'just chatting without skill mention',
    )
    expect(notSelected).toEqual([])
  })

  test('builds available skills xml', async () => {
    const manager = new SkillManager()
    await manager.loadFromConfigDir()

    const xml = manager.buildAvailableSkillsXml()
    expect(xml).toContain('<available_skills>')
    expect(xml).toContain('<skill>')
    expect(xml).toContain('<name>')
    expect(xml).toContain('<description>')
  })

  test('keeps only known skill names', async () => {
    const manager = new SkillManager()
    await manager.loadFromConfigDir()
    const [firstSkill] = manager.getSummaries()
    expect(firstSkill).toBeDefined()

    const filtered = manager.filterKnownSkillNames(
      [firstSkill!.name, 'unknown-skill'],
      2,
    )
    expect(filtered).toEqual([firstSkill!.name])
  })
})
