import { file, write } from 'bun'
import { rename, rm } from 'node:fs/promises'
export { toErrorMessage } from './errors'

export function parseIsoDateOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null
  }
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) {
    return null
  }
  return date.toISOString()
}

export async function readJsonIfExists(path: string): Promise<unknown | null> {
  const ref = file(path)
  if (!(await ref.exists())) {
    return null
  }

  const raw = (await ref.text()).trim()
  if (!raw) {
    return null
  }

  return JSON.parse(raw)
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tempPath = `${path}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  const content = `${JSON.stringify(value, null, 2)}\n`
  await write(tempPath, content, { createPath: true })
  try {
    await rename(tempPath, path)
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
}
