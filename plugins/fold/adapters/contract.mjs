const REQUIRED_METHODS = ['validateListing', 'prepareDraft', 'saveDraft', 'verifyDraft']

export function assertPlatformAdapter(adapter) {
  if (adapter === null || typeof adapter !== 'object' || Array.isArray(adapter)) {
    throw new TypeError('Platform adapter must be an object')
  }
  if (typeof adapter.id !== 'string' || adapter.id.trim() === '') {
    throw new TypeError('Platform adapter id must be a non-empty string')
  }
  if (typeof adapter.platform !== 'string' || adapter.platform.trim() === '') {
    throw new TypeError('Platform adapter platform must be a non-empty string')
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof adapter[method] !== 'function') {
      throw new TypeError(`Platform adapter ${adapter.id} is missing ${method}`)
    }
  }
  return adapter
}
