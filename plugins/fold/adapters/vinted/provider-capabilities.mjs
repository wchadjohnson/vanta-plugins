import { byTestId, refCount } from '../shared/browser-driver.mjs'
import {
  browserProviderTab,
  createWriteProbe,
  probeBrowserProvider,
  providerError,
} from '../shared/browser-provider-registry.mjs'
import { createVintedBrowserCapability } from './browser-capability.mjs'
import { createVintedDelistCapability } from './delist-capability.mjs'

function requiredObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`)
  }
  return value
}

/**
 * The sell form's own exact surface, probed once before the first write: one title field, one
 * photo input and one Save draft button, each by the test id the live capture recorded.
 */
async function exactVintedSurfaceProbe(driver, profile) {
  for (const [testId, code, what] of [
    [profile.controls.title, 'browser_provider_unavailable', 'title field'],
    [profile.actions.saveDraft.testId, 'browser_provider_unavailable', 'Save draft button'],
    [profile.controls.photosInput, 'browser_file_upload_unsupported', 'photo input'],
  ]) {
    if (refCount(await driver.locate(byTestId(testId))) !== 1) {
      throw providerError(code, `Vinted ${what} exact-locator probe failed`)
    }
  }
}

/**
 * Selects the driver by the injected host transport, runs the shared read-only provider probe, and
 * gates the draft transaction's first write on the Vinted form's exact surface.
 */
export async function createVintedBrowserCapabilityForProvider(options = {}) {
  const profile = requiredObject(options.profile, 'profile')
  const tab = browserProviderTab(options)
  await probeBrowserProvider({ tab, profile })
  return createVintedBrowserCapability({
    tab,
    profile,
    resolvePhotoFiles: options.resolvePhotoFiles,
    beforeAuthenticatedWrite: createWriteProbe(tab.driver, profile, exactVintedSurfaceProbe),
    interactionDelayMs: options.interactionDelayMs,
    pollMs: options.pollMs,
    memberId: options.memberId,
    saveConfirmationMs: options.saveConfirmationMs,
  })
}

/**
 * The delist sibling of the factory above: same transport selection and read-only probe, no write
 * gate — every page it acts on is reached by the sibling's own URL and proven before any click.
 */
export async function createVintedDelistCapabilityForProvider(options = {}) {
  const profile = requiredObject(options.profile, 'profile')
  const tab = browserProviderTab(options)
  await probeBrowserProvider({ tab, profile })
  return createVintedDelistCapability({ tab, profile, memberId: options.memberId, pollMs: options.pollMs })
}
