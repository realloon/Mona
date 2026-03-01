import path from 'node:path'
import type { FunctionToolRuntime } from '../types/tools'

export function resolvePath(runtime: FunctionToolRuntime, input: string): string {
  if (!input) {
    return runtime.projectRoot
  }

  if (path.isAbsolute(input)) {
    return path.normalize(input)
  }

  return path.resolve(runtime.projectRoot, input)
}

export function truncateText(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input
  }
  return `${input.slice(0, Math.max(0, maxChars - 21))}\n...(truncated output)`
}
