const MAX_DETAIL_LENGTH = 300

/**
 * A host-diagnosable, secret-free rendering of an underlying error: its message (and code, when it
 * has one) with every URL cut back to origin and path — signed photo URLs and session-bearing
 * query strings never survive — bearer credentials and full Fold reference tokens masked, and the
 * whole thing bounded. Used wherever a failure is reported with a safe code, so the code says what
 * failed and this says why.
 */
export function errorDetail(error) {
  if (error === null || error === undefined) return ''
  const message = typeof error === 'object' ? String(error.message ?? '') : String(error)
  const code = typeof error === 'object' && typeof error.code === 'string' ? error.code : ''
  const detail = (code !== '' && !message.includes(code) ? `${code}: ${message}` : message)
    .replace(/https?:\/\/[^\s'"<>)]+/gi, (value) => {
      try {
        const url = new URL(value)
        return `${url.origin}${url.pathname}`
      } catch {
        return '[url]'
      }
    })
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bFOLD-[A-Z0-9_-]+/g, 'FOLD-[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
  return detail.length > MAX_DETAIL_LENGTH ? `${detail.slice(0, MAX_DETAIL_LENGTH - 1)}…` : detail
}

/** `message`, followed by the underlying error's detail when there is one. */
export function withDetail(message, cause) {
  const detail = errorDetail(cause)
  return detail === '' ? message : `${message}: ${detail}`
}
