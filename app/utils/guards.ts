export function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null
  }

  if (!value.every(v => typeof v === 'string')) {
    return null
  }

  return value as string[]
}
