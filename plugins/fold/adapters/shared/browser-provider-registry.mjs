import { requireBrowserDriver } from './browser-driver.mjs'
import { createClaudeInChromeTab } from './claude-in-chrome-driver.mjs'
import { createCodexBrowserClientTab } from './codex-browser-client-driver.mjs'

/**
 * Marketplace-agnostic browser transport selection. Each marketplace adapter owns its own
 * provider factories (`<adapter>/provider-capabilities.mjs`) and its own exact-surface probe; this
 * module only routes by the injected host transport and performs the read-only probe every
 * marketplace shares.
 */
export const BROWSER_PROVIDER_IDS = Object.freeze({
  claudeInChrome: 'claude-in-chrome',
  codexBrowserClient: 'codex-browser-client',
})

const UNSUPPORTED_SURFACES = new Set(['codex-cli', 'codex-ide'])

export function providerError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function requiredObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`)
  }
  return value
}

/** Builds the host-selected tab for the injected transport, or refuses with a safe code. */
export function browserProviderTab(options) {
  const provider = options.provider
  if (provider === undefined || provider === null || provider === '') {
    throw providerError('browser_provider_unavailable', 'No browser provider was supplied')
  }
  if (UNSUPPORTED_SURFACES.has(provider)) {
    throw providerError(
      'browser_provider_unsupported',
      'This Codex surface has no qualified browser provider'
    )
  }
  try {
    if (provider === BROWSER_PROVIDER_IDS.codexBrowserClient) {
      if (options.tab === undefined || options.tab === null) {
        throw providerError('browser_tab_not_selected', 'No host-selected Codex browser tab was supplied')
      }
      return createCodexBrowserClientTab(options)
    }
    if (provider === BROWSER_PROVIDER_IDS.claudeInChrome) {
      if (options.tabId === undefined || options.tabId === null) {
        throw providerError('browser_tab_not_selected', 'No host-selected Claude Chrome tab was supplied')
      }
      return createClaudeInChromeTab(options)
    }
  } catch (error) {
    if (typeof error?.code === 'string') throw error
    throw providerError('browser_provider_unavailable', 'Browser provider could not be initialized')
  }
  throw providerError('browser_provider_unsupported', 'Browser provider is not qualified')
}

function safeOrigin(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw providerError('browser_tab_not_selected', 'Selected browser tab has no readable URL')
  }
  try {
    return new URL(value).origin
  } catch (error) {
    throw providerError('browser_tab_not_selected', 'Selected browser tab URL is invalid')
  }
}

/** Read-only transport probe. It neither navigates nor resolves listing photos. */
export async function probeBrowserProvider({ tab, profile } = {}) {
  const selectedTab = requiredObject(tab, 'tab')
  const targetProfile = requiredObject(profile, 'profile')
  const candidateDriver = selectedTab.driver
  if (candidateDriver === null || typeof candidateDriver !== 'object') {
    throw providerError('browser_provider_unavailable', 'Selected tab has no browser driver')
  }
  if (typeof candidateDriver.clickAndWaitForNavigation !== 'function') {
    throw providerError(
      'browser_navigation_wait_unsupported',
      'Browser provider cannot atomically observe navigation'
    )
  }
  let driver
  try {
    driver = requireBrowserDriver(selectedTab.driver, 'tab.driver')
  } catch (error) {
    throw providerError('browser_provider_unavailable', 'Browser driver contract is incomplete')
  }
  if (typeof selectedTab.url !== 'function') {
    throw providerError('browser_provider_unavailable', 'Browser provider cannot read the selected tab URL')
  }
  if (typeof driver.inspectFileUpload !== 'function') {
    throw providerError(
      'browser_file_upload_unsupported',
      'Browser provider cannot inspect exact file-upload capability'
    )
  }
  let current
  try {
    current = await selectedTab.url()
  } catch (error) {
    throw providerError('browser_tab_not_selected', 'Selected browser tab URL could not be read')
  }
  if (safeOrigin(current) !== targetProfile.origin) {
    throw providerError('browser_origin_mismatch', 'Selected browser tab is outside the allowed origin')
  }
  return Object.freeze({
    exactLocators: true,
    fileChooser: true,
    navigationObservation: true,
    urlReads: true,
    selectedTab: true,
    allowedOrigin: true,
  })
}

/**
 * Runs a marketplace's exact-surface probe once, before the first data-bearing operation. A failed
 * probe is not cached, so a later attempt probes again rather than inheriting a stale refusal.
 */
export function createWriteProbe(driver, profile, probe) {
  let completed = false
  let running = null
  return async function ensure() {
    if (completed) return
    running ??= probe(driver, profile).then(() => {
      completed = true
    })
    try {
      await running
    } catch (error) {
      running = null
      throw error
    }
  }
}
