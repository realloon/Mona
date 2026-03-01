import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FunctionToolManager } from '../app/function-tools.ts'

describe('FunctionToolManager', () => {
  let sandboxDir = ''

  beforeEach(async () => {
    sandboxDir = await mkdtemp(path.join(tmpdir(), 'mona-tools-test-'))
  })

  afterEach(async () => {
    if (sandboxDir) {
      await rm(sandboxDir, { recursive: true, force: true })
    }
  })

  function createManager(): FunctionToolManager {
    return new FunctionToolManager({
      projectRoot: sandboxDir,
      defaultTimeoutMs: 2000,
      maxOutputChars: 4000,
    })
  }

  test('blocks dangerous commands without approval hook', async () => {
    const manager = createManager()

    const result = await manager.callOpenAITool('builtin__run', {
      command: 'rm -rf /tmp/wont-run',
    })

    expect(result).toContain('Execution denied')
    expect(result).toContain('contains rm')
  })

  test('runs safe commands and captures output', async () => {
    const manager = createManager()

    const result = await manager.callOpenAITool('builtin__run', {
      command: 'printf hello',
    })

    expect(result).toContain('exit_code: 0')
    expect(result).toContain('stdout:')
    expect(result).toContain('hello')
  })

  test('refuses file overwrite when overwrite=false', async () => {
    const manager = createManager()
    const filePath = path.join(sandboxDir, 'note.txt')
    await Bun.write(filePath, 'old-content')

    const result = await manager.callOpenAITool('builtin__write', {
      path: 'note.txt',
      content: 'new-content',
      overwrite: false,
    })

    expect(result).toContain('Refused to overwrite existing file')
    const content = await Bun.file(filePath).text()
    expect(content).toBe('old-content')
  })

  test('clamps delete_count in non-strict patch mode', async () => {
    const manager = createManager()
    const filePath = path.join(sandboxDir, 'sample.txt')
    await Bun.write(filePath, 'a\nb\nc\n')

    const result = await manager.callOpenAITool('builtin__patch', {
      path: 'sample.txt',
      hunks: [{ start_line: 2, delete_count: 99, insert_lines: ['B'] }],
      strict: false,
    })

    expect(result).toContain('hunks_applied: 1')
    expect(result).toContain('strict: false')
    const nextContent = await Bun.file(filePath).text()
    expect(nextContent).toBe('a\nB\n')
  })
})
