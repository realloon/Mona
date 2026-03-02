type RequestErrorLike = Error & {
  status?: number
  request_id?: string
  code?: string
  type?: string
}

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function formatRequestError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error)
  }

  const apiError = error as RequestErrorLike
  const parts: string[] = [apiError.message]

  if (typeof apiError.status === 'number') {
    parts.push(`status=${apiError.status}`)
  }
  if (apiError.request_id) {
    parts.push(`request_id=${apiError.request_id}`)
  }
  if (apiError.code) {
    parts.push(`code=${apiError.code}`)
  }
  if (apiError.type) {
    parts.push(`type=${apiError.type}`)
  }

  return parts.join(' | ')
}
