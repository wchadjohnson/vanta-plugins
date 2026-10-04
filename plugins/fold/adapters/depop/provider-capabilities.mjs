import { byLabel, byRole, refCount, refElement } from '../shared/browser-driver.mjs'
import {
  browserProviderTab,
  createWriteProbe,
  probeBrowserProvider,
  providerError,
} from '../shared/browser-provider-registry.mjs'
import { createDepopBrowserCapability } from './browser-capability.mjs'
import { createDepopBulkListingCapability } from './bulk-listing-capability.mjs'
import { createDepopDelistCapability } from './delist-capability.mjs'

function requiredObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`)
  }
  return value
}

async function exactSurfaceProbe(driver, profile) {
  const description = profile.kind === 'depop'
    ? await driver.locate(byRole('textbox', profile.fields.description.label))
    : await driver.locate(byLabel(profile.fields.description.label))
  if (refCount(description) !== 1 || refElement(description).role !== 'textbox') {
    throw providerError('browser_provider_unavailable', 'Draft form exact-locator probe failed')
  }

  const save = await driver.locate(byRole(profile.actions.saveDraft.role, profile.actions.saveDraft.name))
  if (refCount(save) !== 1) {
    throw providerError('browser_provider_unavailable', 'Draft-save exact-locator probe failed')
  }

  const photos = profile.kind === 'depop'
    ? await driver.locate(byRole(profile.fields.photos.role, profile.fields.photos.label))
    : await driver.locate(byLabel(profile.fields.photos.label))
  if (refCount(photos) !== 1) {
    throw providerError('browser_file_upload_unsupported', 'Photo control exact-locator probe failed')
  }
  const upload = await driver.inspectFileUpload(photos)
  if (upload?.present !== true) {
    throw providerError('browser_file_upload_unsupported', 'Photo control has no inspectable file input')
  }
  if (upload.multiple !== true) {
    throw providerError('browser_file_upload_unsupported', 'Photo input does not support ordered batches')
  }
}

function withWriteProbe(capability, ensure, profile) {
  const wrapped = {}
  for (const [name, method] of Object.entries(capability)) {
    if (typeof method !== 'function') continue
    if (['fillField', 'selectField', 'uploadPhotos'].includes(name)) {
      wrapped[name] = async (...args) => {
        await ensure()
        return method(...args)
      }
    } else if (name === 'activate') {
      wrapped[name] = async (action, ...args) => {
        if (
          action?.role === profile.actions.saveDraft.role &&
          action?.name === profile.actions.saveDraft.name
        ) {
          await ensure()
        }
        return method(action, ...args)
      }
    } else {
      wrapped[name] = (...args) => method(...args)
    }
  }
  return Object.freeze(wrapped)
}

/**
 * The bulk-listing page's own exact surface: one upload trigger and one addressable file control.
 * Deliberately separate from `exactSurfaceProbe` — the bulk page has no draft form to probe, and
 * probing for one would fail on a page that is working perfectly.
 */
async function exactBulkListingSurfaceProbe(driver, profile) {
  const bulkListing = requiredObject(profile.bulkListing, 'profile.bulkListing')
  const trigger = await driver.locate(byRole(bulkListing.trigger.role, bulkListing.trigger.name))
  if (refCount(trigger) !== 1) {
    throw providerError('browser_provider_unavailable', 'Bulk-listing trigger exact-locator probe failed')
  }
  const input = await driver.locate(byRole(bulkListing.fileInput.role))
  if (refCount(input) !== 1) {
    throw providerError(
      'browser_file_upload_unsupported',
      'Bulk-listing page does not expose exactly one file control'
    )
  }
}

function withBulkListingProbe(capability, ensure) {
  const wrapped = {}
  for (const [name, method] of Object.entries(capability)) {
    if (typeof method !== 'function') continue
    wrapped[name] = name === 'uploadCsv'
      ? async (...args) => {
        await ensure()
        return method(...args)
      }
      : (...args) => method(...args)
  }
  return Object.freeze(wrapped)
}

/**
 * Selects a concrete driver by the injected host transport, performs the read-only provider probe,
 * and gates the first data-bearing operation on an exact draft-form/file-input probe.
 */
export async function createDepopBrowserCapabilityForProvider(options = {}) {
  const profile = requiredObject(options.profile, 'profile')
  const tab = browserProviderTab(options)
  await probeBrowserProvider({ tab, profile })
  const ensureWriteSurface = createWriteProbe(tab.driver, profile, exactSurfaceProbe)
  const capability = createDepopBrowserCapability({
    tab,
    profile,
    resolvePhotoFiles: options.resolvePhotoFiles,
    beforeAuthenticatedWrite: ensureWriteSurface,
    interactionDelayMs: options.interactionDelayMs,
  })
  return withWriteProbe(capability, ensureWriteSurface, profile)
}

/**
 * The bulk-listing sibling of the factory above. Same transport selection and same read-only
 * provider probe; a different exact-surface gate, because the page it works on is the platform's
 * own importer rather than a create form. It is a sibling rather than a branch so that neither
 * path's surface assumptions can drift into the other's.
 */
export async function createDepopBulkListingCapabilityForProvider(options = {}) {
  const profile = requiredObject(options.profile, 'profile')
  const tab = browserProviderTab(options)
  await probeBrowserProvider({ tab, profile })
  const ensureBulkSurface = createWriteProbe(tab.driver, profile, exactBulkListingSurfaceProbe)
  const capability = createDepopBulkListingCapability({
    tab,
    profile,
    resolveCsvFile: options.resolveCsvFile,
    beforeBulkWrite: ensureBulkSurface,
    interactionDelayMs: options.interactionDelayMs,
    snapshotPollMs: options.snapshotPollMs,
    draftViewSettleMs: options.draftViewSettleMs,
    importPollMs: options.importPollMs,
    importTimeoutMs: options.importTimeoutMs,
    surfacePollMs: options.surfacePollMs,
    surfaceTimeoutMs: options.surfaceTimeoutMs,
  })
  return withBulkListingProbe(capability, ensureBulkSurface)
}

/**
 * The delist sibling of the two factories above. Same transport selection and same read-only
 * provider probe; no exact-surface write gate, because a delist run moves between Active/Selling and
 * the drafts views rather than working one form. Each surface's shape was live-captured
 * (2026-09-19, 2026-10-03, 2026-10-04 — see `delist` in `profile.mjs` and the header of
 * `delist-capability.mjs`), and `findSiblingRow()`, `findDraftSibling()`, `deleteDraftRow()` and
 * `confirmDelete()` each fail closed on a shape they do not recognise, so a separate probe here
 * would only duplicate their own refusals.
 */
export async function createDepopDelistCapabilityForProvider(options = {}) {
  const profile = requiredObject(options.profile, 'profile')
  const tab = browserProviderTab(options)
  await probeBrowserProvider({ tab, profile })
  return createDepopDelistCapability({
    tab,
    profile,
    interactionDelayMs: options.interactionDelayMs,
    activePageSettleMs: options.activePageSettleMs,
    activePagePollMs: options.activePagePollMs,
  })
}
