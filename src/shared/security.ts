const SECRET_PATTERNS = [
  /\b(sk|pk|key|token|gho|github_pat)-?[a-z0-9_-]{8,}\b/gi,
  /\bBearer\s+[a-z0-9._~+-]+=*\b/gi,
  /("?(?:api[_-]?key|authorization|token)"?\s*[:=]\s*)["']?[^\s,"']+/gi
]

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce(
    (redacted, pattern) => redacted.replace(pattern, (_match, prefix?: string) => `${prefix ?? ''}[REDACTED]`),
    value
  )
}

export function safeErrorCategory(error: unknown): string {
  if (error instanceof Error) return redactSecrets(error.name).slice(0, 120) || 'Error'
  return 'UnknownError'
}
