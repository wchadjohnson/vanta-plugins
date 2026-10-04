import path from 'node:path'

import {
  byCss,
  byLabel,
  byRole,
  byTestId,
  refAt,
  refCount,
  refElement,
  requireBrowserDriver,
} from '../shared/browser-driver.mjs'
import { depopAudienceOfGroup, isLiveActionName } from './profile.mjs'

const RECORD_TEST_ID = 'draft-verification'
const SAVED_HEADING = 'Draft saved'
const SETTLE_POLL_MS = 150
const UPLOAD_POLL_MS = 100
const MAX_CATEGORY_INFERENCE_CANDIDATES = 12

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function safeBrowserError(code, message) {
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

function requiredFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`)
  return value
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function exactPhotoFilenames(files, photos) {
  return files.every((file, index) => path.basename(file) === photos[index].filename)
}

async function clickAndSettle(driver, ref) {
  await driver.clickAndWaitForNavigation(ref)
}

function normalizedUrl(value, profile, label) {
  if (!nonEmptyString(value)) throw safeBrowserError('browser_url_missing', `${label} URL is missing`)
  const url = new URL(value)
  if (url.origin !== profile.origin) {
    throw safeBrowserError('browser_origin_mismatch', `${label} escaped the configured target origin`)
  }
  return url
}

function allowedAction(action, profile) {
  if (action === null || typeof action !== 'object' || Array.isArray(action)) return false
  if (isLiveActionName(action.name)) return false
  return [profile.actions.addDraft, profile.actions.saveDraft].some(
    (expected) => expected.role === action.role && expected.name === action.name
  )
}

/**
 * Every stable per-draft edit URL the currently open draft-list surface links to, filtered by the
 * profile's own draft-path shape so a hub or pagination link can never pass as a draft identity.
 *
 * Module-level because two paths need exactly this and nothing else around it: the per-field
 * capability, which diffs it to find the one draft it just created, and the bulk-listing capability,
 * which diffs it to find the drafts the platform's own importer created.
 */
export async function draftEditUrls(driver, profile) {
  const links = await driver.locate(byRole('link', 'Edit listing'))
  const urls = []
  for (let index = 0; index < refCount(links); index += 1) {
    const href = refElement(links, index).href
    if (!nonEmptyString(href)) continue
    const url = normalizedUrl(new URL(href, profile.origin).toString(), profile, 'Draft link')
    if (profile.draftPathPattern.test(url.pathname)) {
      url.search = ''
      url.hash = ''
      urls.push(url.toString())
    }
  }
  return urls
}

/**
 * The same set, but only once three consecutive reads agree. Depop's draft tables hydrate
 * progressively and can expose a partial link set mid-render, which once caused an undercounted
 * pre-save snapshot on a real account.
 */
export async function stableDraftEditUrls(driver, profile, { pollMs = SETTLE_POLL_MS } = {}) {
  let previous = null
  let stableReads = 0
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (pollMs > 0) await delay(pollMs)
    const current = [...new Set(await draftEditUrls(driver, profile))].sort()
    const unchanged =
      previous !== null &&
      previous.length === current.length &&
      previous.every((url, index) => url === current[index])
    stableReads = unchanged ? stableReads + 1 : 1
    if (stableReads >= 3) return current
    previous = current
  }
  throw safeBrowserError(
    'draft_snapshot_unstable',
    'Depop draft identities did not settle to one stable snapshot'
  )
}

function normalizedDelay(value) {
  const delayMs = value ?? 0
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 1000) {
    throw new TypeError('interactionDelayMs must be an integer from 0 through 1000')
  }
  return delayMs
}

/**
 * Adapts a host-provided visible browser tab to the narrow Depop adapter contract.
 *
 * The browser remains host-owned and is reached only through the Layer C driver interface in
 * `browser-driver.mjs`, so no automation tool's own API leaks into this layer. Photo URLs are never
 * logged or returned: the host resolves the prepared photo set to temporary local files through
 * resolvePhotoFiles immediately before upload. Persisted verification is read from the stable
 * saved-draft page contract, never by navigating the visible tab to a JSON endpoint.
 */
export function createDepopBrowserCapability(options = {}) {
  const tab = requiredObject(options.tab, 'tab')
  const profile = requiredObject(options.profile, 'profile')
  const driver = requireBrowserDriver(tab.driver, 'tab.driver')
  const resolvePhotoFiles = requiredFunction(options.resolvePhotoFiles, 'resolvePhotoFiles')
  const beforeAuthenticatedWrite =
    options.beforeAuthenticatedWrite === undefined
      ? async () => {}
      : requiredFunction(options.beforeAuthenticatedWrite, 'beforeAuthenticatedWrite')
  const interactionDelayMs = normalizedDelay(options.interactionDelayMs)
  for (const method of ['goto', 'url']) requiredFunction(tab[method], `tab.${method}`)
  if (profile.kind === 'depop') {
    return createAuthenticatedDepopBrowserCapability({
      tab,
      profile,
      driver,
      resolvePhotoFiles,
      beforeAuthenticatedWrite,
      interactionDelayMs,
    })
  }

  const metrics = {
    startedAt: null,
    completedAt: null,
    steps: 0,
  }

  async function pause() {
    metrics.steps += 1
    if (interactionDelayMs > 0) await delay(interactionDelayMs)
  }

  async function exactField(locator) {
    const field = await driver.locate(byLabel(locator.label))
    if (refCount(field) !== 1) {
      throw safeBrowserError(
        'browser_field_ambiguous',
        `Expected exactly one ${locator.label} field`
      )
    }
    if (refElement(field).role !== locator.role) {
      throw safeBrowserError('browser_field_role_mismatch', `${locator.label} has an unexpected role`)
    }
    return field
  }

  async function readVerificationRecord() {
    const record = await driver.locate(byTestId(RECORD_TEST_ID))
    if (refCount(record) !== 1) {
      throw safeBrowserError(
        'draft_verification_record_missing',
        'Saved draft verification record is missing or ambiguous'
      )
    }
    let parsed
    try {
      parsed = JSON.parse((await driver.readText(record)) ?? '')
    } catch {
      throw safeBrowserError(
        'draft_verification_record_invalid',
        'Saved draft verification record is invalid'
      )
    }
    return requiredObject(parsed, 'saved draft verification record')
  }

  return Object.freeze({
    async navigate(value) {
      const target = normalizedUrl(value, profile, 'Navigation')
      metrics.startedAt ??= Date.now()
      if ((await tab.url()) !== target.toString()) await tab.goto(target.toString())
      await pause()
    },

    async inspectDraftSurface() {
      const current = normalizedUrl(await tab.url(), profile, 'Browser surface')
      const controls = []
      for (const action of [profile.actions.addDraft, profile.actions.saveDraft]) {
        const control = await driver.locate(byRole(action.role, action.name))
        for (let index = 0; index < refCount(control); index += 1) controls.push({ ...action })
      }

      const fields = []
      const uniqueFields = new Map(
        Object.values(profile.fields).map((field) => [`${field.label}\0${field.role}`, field])
      )
      for (const field of uniqueFields.values()) {
        const located = await driver.locate(byLabel(field.label))
        for (let index = 0; index < refCount(located); index += 1) {
          fields.push({ label: field.label, role: refElement(located, index).role })
        }
      }
      return { url: current.toString(), controls, fields }
    },

    async fillField(locator, value) {
      await driver.fill(await exactField(locator), String(value))
      await pause()
    },

    async selectField(locator, value) {
      const field = await exactField(locator)
      if (locator.role === 'combobox') {
        if (Array.isArray(value)) {
          throw safeBrowserError('browser_combobox_value_invalid', 'Combobox value must be singular')
        }
        await driver.selectOption(field, String(value))
      } else if (locator.role === 'textbox') {
        await driver.fill(field, Array.isArray(value) ? value.join(', ') : String(value))
      } else {
        throw safeBrowserError('browser_field_operation_unsupported', 'Field operation is unsupported')
      }
      await pause()
    },

    async uploadPhotos(locator, photos) {
      const files = await resolvePhotoFiles(photos)
      if (!Array.isArray(files) || files.length !== photos.length || !files.every(nonEmptyString)) {
        throw safeBrowserError(
          'browser_photo_files_mismatch',
          'Resolved photo files do not match the prepared photo set'
        )
      }
      if (!exactPhotoFilenames(files, photos)) {
        throw safeBrowserError(
          'browser_photo_filenames_mismatch',
          'Resolved photo filenames do not preserve the prepared photo set'
        )
      }
      const result = await driver.uploadFiles(await exactField(locator), files)
      if (photos.length > 1 && result?.multiple !== true) {
        throw safeBrowserError('browser_photo_input_not_multiple', 'Photo input does not accept a batch')
      }
      await pause()
    },

    async activate(action) {
      if (!allowedAction(action, profile)) {
        throw safeBrowserError('browser_action_refused', 'Refusing a non-draft browser action')
      }
      const control = await driver.locate(byRole(action.role, action.name))
      if (refCount(control) !== 1) {
        throw safeBrowserError('browser_action_ambiguous', `Expected exactly one ${action.name} control`)
      }
      await pause()
      await clickAndSettle(driver, control)
      await pause()
    },

    async observeDraftSave() {
      const current = normalizedUrl(await tab.url(), profile, 'Saved draft')
      const heading = await driver.locate(byRole('heading', SAVED_HEADING))
      if (refCount(heading) !== 1 || !profile.draftPathPattern.test(current.pathname)) {
        return {
          outcome: 'ambiguous',
          status: 'unknown',
          error: 'Saved draft page did not expose one stable draft identity',
        }
      }
      const record = await readVerificationRecord()
      const status = nonEmptyString(record.status) ? record.status.trim().toLowerCase() : 'unknown'
      if (status !== 'draft' || !nonEmptyString(record.external_identity)) {
        return {
          outcome: 'ambiguous',
          status,
          error: 'Saved item did not expose draft status and stable identity',
        }
      }
      metrics.completedAt = Date.now()
      return {
        outcome: 'saved',
        status,
        canonical_url: current.toString(),
        external_identity: record.external_identity,
      }
    },

    async readDraft(identity) {
      const canonical = normalizedUrl(identity.canonical_url, profile, 'Draft verification')
      if ((await tab.url()) !== canonical.toString()) await tab.goto(canonical.toString())
      const record = await readVerificationRecord()
      if (
        record.external_identity !== identity.external_identity ||
        record.sku !== identity.sku ||
        record.canonical_url !== canonical.toString()
      ) {
        throw safeBrowserError(
          'draft_verification_identity_mismatch',
          'Saved draft identity correlation failed'
        )
      }
      return record
    },

    metrics() {
      return Object.freeze({
        elapsed_ms:
          metrics.startedAt === null || metrics.completedAt === null
            ? null
            : metrics.completedAt - metrics.startedAt,
        interaction_delay_ms: interactionDelayMs,
        visible_steps: metrics.steps,
      })
    },
  })
}

function createAuthenticatedDepopBrowserCapability({
  tab,
  profile,
  driver,
  resolvePhotoFiles,
  beforeAuthenticatedWrite,
  interactionDelayMs,
}) {
  const metrics = {
    startedAt: null,
    acknowledgedAt: null,
    completedAt: null,
    verifiedAt: null,
    steps: 0,
    inferenceWaitMs: 0,
    phases: Object.create(null),
  }
  let lastPrepared = null
  let lastPhotoCount = null
  let pendingPrewrite = null

  async function pause(multiplier = 1) {
    metrics.steps += 1
    const duration = interactionDelayMs * multiplier
    if (duration > 0) await delay(duration)
  }

  async function measure(name, operation) {
    const startedAt = Date.now()
    try {
      return await operation()
    } finally {
      metrics.phases[name] = (metrics.phases[name] ?? 0) + (Date.now() - startedAt)
    }
  }

  function resetMetrics() {
    metrics.startedAt = Date.now()
    metrics.acknowledgedAt = null
    metrics.completedAt = null
    metrics.verifiedAt = null
    metrics.steps = 0
    metrics.inferenceWaitMs = 0
    for (const name of Object.keys(metrics.phases)) delete metrics.phases[name]
  }

  async function resumablePrewrite(prepared) {
    const selection = prepared.categorySelection
    if (
      pendingPrewrite === null ||
      selection?.status !== 'resolved' ||
      pendingPrewrite.foldListingId !== prepared.foldListingId ||
      pendingPrewrite.sku !== prepared.sku ||
      pendingPrewrite.audience !== selection.audience ||
      JSON.stringify(pendingPrewrite.terms) !== JSON.stringify(selection.terms) ||
      (await tab.url()) !== profile.entryUrl
    ) {
      return null
    }
    return pendingPrewrite
  }

  async function exactRole(role, name) {
    const locator = await driver.locate(byRole(role, name))
    if (refCount(locator) !== 1) {
      throw safeBrowserError(
        'browser_control_ambiguous',
        `Expected exactly one ${name} ${role}`
      )
    }
    return locator
  }

  async function currentValue(role, name) {
    return String(refElement(await exactRole(role, name)).value ?? '')
  }

  async function selectExact(name, value) {
    const field = await exactRole('combobox', name)
    await driver.fill(field, String(value))
    await pause()
    const option = await driver.locate(byRole('option', String(value)))
    if (refCount(option) !== 1) {
      throw safeBrowserError(
        'browser_option_ambiguous',
        `${name} does not expose one exact qualified option`
      )
    }
    await driver.click(option)
    await pause()
  }

  /**
   * The options Depop currently offers for one search term, restricted to the audience group Fold's
   * category named. Exact matches are tracked separately from semantic suggestions so only the
   * latter can reach bounded AI inference.
   */
  async function categoryOptionsFor(field, term, audience) {
    await driver.fill(field, term)
    await pause()
    const options = await driver.locate(byRole('option'))
    const offered = []
    const matched = []
    for (let index = 0; index < refCount(options); index += 1) {
      const option = refElement(options, index)
      if (!nonEmptyString(option.name) || !nonEmptyString(option.group)) continue
      if (depopAudienceOfGroup(option.group) !== audience) continue
      const candidate = { index, name: option.name, group: option.group }
      offered.push(candidate)
      if (option.name === term) matched.push(candidate)
    }
    return { options, offered, matched }
  }

  /**
   * Chooses Depop's category from Fold's parsed selection, or refuses.
   *
   * Every candidate term is tried and the results are pooled. One exact match stays deterministic.
   * Several exact matches, or live suggestions when no exact match exists, become a bounded
   * inference request. Zero live options refuses without giving a model anything to invent from.
   *
   * A caller-resolved label skips the pooling but not the gate: it is re-enumerated below and must
   * still be exactly one real option under this exact audience group before anything is clicked.
   * Every refusal here happens before the draft is created, so no external state is left behind.
   */
  async function selectCategory(selection) {
    const field = await exactRole('combobox', selection.locator.label)
    let chosen
    if (selection.status === 'resolved') {
      chosen = selection.chosenLabel
    } else {
      const exactCandidates = new Map()
      const suggestedCandidates = new Map()
      for (const term of selection.terms) {
        const result = await categoryOptionsFor(field, term, selection.audience)
        for (const option of result.offered) {
          suggestedCandidates.set(`${option.group}|${option.name}`, option)
        }
        for (const option of result.matched) {
          exactCandidates.set(`${option.group}|${option.name}`, option)
        }
      }
      if (exactCandidates.size === 1) {
        chosen = [...exactCandidates.values()][0].name
      } else {
        const candidates = exactCandidates.size > 0 ? exactCandidates : suggestedCandidates
        if (candidates.size === 0) {
          throw safeBrowserError(
            'browser_category_unavailable',
            'Depop offered no category candidates for this listing under its own audience'
          )
        }
        if (candidates.size > MAX_CATEGORY_INFERENCE_CANDIDATES) {
          throw safeBrowserError(
            'browser_category_candidates_excessive',
            'Depop offered too many category candidates for bounded inference'
          )
        }
        const error = safeBrowserError(
          'browser_category_inference_required',
          'This listing requires a choice among Depop categories under its own audience'
        )
        error.candidates = [...candidates.values()].map(({ name: label, group }) => ({
          label,
          group,
        }))
        throw error
      }
    }

    const { options, matched } = await categoryOptionsFor(field, chosen, selection.audience)
    if (matched.length !== 1) {
      throw safeBrowserError(
        'browser_category_ambiguous',
        'The chosen Depop category no longer resolves to one option under its own audience'
      )
    }
    await driver.click(refAt(options, matched[0].index))
    await pause()

    // Depop unlocks Size and Material only once Category holds a value, so an empty control here
    // means every gated field that follows would be written to a disabled input.
    if (!nonEmptyString(await currentValue('combobox', selection.locator.label))) {
      throw safeBrowserError('browser_category_not_persisted', 'Depop category did not hold a value')
    }
    return chosen
  }

  /**
   * Depop suggests a package size once Category is set. Fold has no package-size data, so this only
   * confirms Depop filled it in: guessing one costs the seller real money on a wrong shipping label.
   */
  async function assertPackageSizeSuggested() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const field = await exactRole(
        profile.fields.packageSize.role,
        profile.fields.packageSize.label
      )
      if (nonEmptyString(refElement(field).value)) return
      await delay(SETTLE_POLL_MS)
    }
    throw safeBrowserError(
      'browser_package_size_missing',
      'Depop did not suggest a package size after the category was set'
    )
  }

  async function formPhotoCount() {
    return refCount(await driver.locate(byCss('main form img')))
  }

  async function uploadOrderedPhotos(photos) {
    const files = await resolvePhotoFiles(photos)
    if (!Array.isArray(files) || files.length !== photos.length || !files.every(nonEmptyString)) {
      throw safeBrowserError(
        'browser_photo_files_mismatch',
        'Resolved photo files do not match the prepared photo set'
      )
    }
    if (!exactPhotoFilenames(files, photos)) {
      throw safeBrowserError(
        'browser_photo_filenames_mismatch',
        'Resolved photo filenames do not preserve the prepared photo set'
      )
    }
    const button = await exactRole('button', profile.fields.photos.label)
    const result = await driver.uploadFiles(button, files)
    if (photos.length > 1 && result?.multiple !== true) {
      throw safeBrowserError('browser_photo_input_not_multiple', 'Photo input does not accept a batch')
    }
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const count = await formPhotoCount()
      if (count >= photos.length) {
        lastPhotoCount = count
        return
      }
      await delay(UPLOAD_POLL_MS)
    }
    throw safeBrowserError('browser_photo_upload_incomplete', 'Uploaded photo previews did not settle')
  }

  async function populateCreateForm(prepared) {
    // Category goes first: Depop keeps Type, Occasion, Material, Body fit, and Size locked until it
    // holds a value, and auto-suggests the package size the moment it does.
    await measure('taxonomy_ms', async () => {
      if (prepared.categorySelection !== null && prepared.categorySelection !== undefined) {
        await selectCategory(prepared.categorySelection)
        await assertPackageSizeSuggested()
      }
    })
    await measure('fields_ms', async () => {
      for (const field of prepared.formFields) {
        if (field.key === 'title' || field.key === 'sku' || field.key === 'photos') continue
        if (field.key === 'description') {
          await driver.fill(
            await exactRole('textbox', profile.fields.description.label),
            String(field.value)
          )
          await pause()
          continue
        }
        if (field.key === 'price') {
          await driver.fill(
            await exactRole('spinbutton', profile.fields.price.label),
            String(field.value)
          )
          await pause()
          continue
        }
        if (field.operation === 'select') await selectExact(field.locator.label, field.value)
      }
    })
    const photoField = prepared.formFields.find((field) => field.key === 'photos')
    if (photoField !== undefined) {
      await measure('photos_ms', () => uploadOrderedPhotos(photoField.value))
    }
  }

  async function newDraftUrl(before) {
    const currentUrl = normalizedUrl(await tab.url(), profile, 'Saved draft')
    currentUrl.search = ''
    currentUrl.hash = ''
    if (
      profile.draftPathPattern.test(currentUrl.pathname) &&
      !before.has(currentUrl.toString())
    ) {
      return currentUrl.toString()
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((await tab.url()) !== profile.draftListUrl) await tab.goto(profile.draftListUrl)
      const current = await stableDraftEditUrls(driver, profile)
      const created = current.filter((url) => !before.has(url))
      if (created.length === 1) return created[0]
      if (created.length > 1) {
        throw safeBrowserError('draft_identity_ambiguous', 'More than one new draft identity appeared')
      }
      await delay(SETTLE_POLL_MS)
    }
    throw safeBrowserError('draft_identity_missing', 'No stable new draft identity appeared')
  }

  async function readAuthenticatedDraft(canonicalUrl) {
    const canonical = normalizedUrl(canonicalUrl, profile, 'Draft verification')
    if (!profile.draftPathPattern.test(canonical.pathname)) {
      throw safeBrowserError('draft_verification_url_invalid', 'Draft verification URL is not stable')
    }
    if ((await tab.url()) !== canonical.toString()) await tab.goto(canonical.toString())
    await exactRole('heading', 'Draft')

    const description = await currentValue('textbox', profile.fields.description.label)
    const sku = await currentValue('textbox', profile.fields.sku.label)
    const price = await currentValue('spinbutton', profile.fields.price.label)
    const actualPhotoCount = await formPhotoCount()
    const expectedPhotoCount = lastPrepared?.photos.length ?? 0
    const structuredFields = {}
    for (const field of lastPrepared?.structuredFields ?? []) {
      structuredFields[field.key] = await currentValue('combobox', field.locator.label)
    }
    const externalIdentity = canonical.pathname.split('/').filter(Boolean).at(-1)

    return {
      status: 'draft',
      sku,
      title: lastPrepared?.approvedContent.title,
      description,
      price,
      structured_fields: structuredFields,
      photo_filenames:
        actualPhotoCount >= expectedPhotoCount && lastPhotoCount >= expectedPhotoCount
          ? lastPrepared.photos.map((photo) => photo.filename)
          : [],
      canonical_url: canonical.toString(),
      external_identity: externalIdentity,
    }
  }

  return Object.freeze({
    async navigate(value) {
      const target = normalizedUrl(value, profile, 'Navigation')
      metrics.startedAt ??= Date.now()
      if ((await tab.url()) !== target.toString()) await tab.goto(target.toString())
      await pause()
    },

    async inspectDraftSurface() {
      return { url: await tab.url(), controls: [], fields: [] }
    },

    async fillField() {
      throw safeBrowserError('browser_operation_invalid', 'Use savePreparedDraft for authenticated Depop')
    },

    async selectField() {
      throw safeBrowserError('browser_operation_invalid', 'Use savePreparedDraft for authenticated Depop')
    },

    async uploadPhotos() {
      throw safeBrowserError('browser_operation_invalid', 'Use savePreparedDraft for authenticated Depop')
    },

    async activate() {
      throw safeBrowserError('browser_operation_invalid', 'Use savePreparedDraft for authenticated Depop')
    },

    async observeDraftSave() {
      throw safeBrowserError('browser_operation_invalid', 'Use savePreparedDraft for authenticated Depop')
    },

    async savePreparedDraft({ prepared }) {
      lastPrepared = prepared
      const resume = await resumablePrewrite(prepared)
      if (resume === null) {
        resetMetrics()
      } else {
        metrics.inferenceWaitMs += Date.now() - resume.pausedAt
        // The first attempt recorded snapshot_ms and create_readiness_ms (they do not run on a
        // resume) plus a partial taxonomy_ms captured when selectCategory threw the inference
        // request. Every phase from taxonomy onward is measured fresh below, so drop the stale
        // partials — otherwise phase_ms double-counts the abandoned category search and stops
        // being one coherent transaction breakdown.
        for (const name of Object.keys(metrics.phases)) {
          if (name !== 'snapshot_ms' && name !== 'create_readiness_ms') {
            delete metrics.phases[name]
          }
        }
      }
      pendingPrewrite = null
      lastPhotoCount = null
      let stage = 'snapshot_existing_drafts'
      let externalWriteAttempted = false
      let before
      try {
        if (resume === null) {
          before = await measure('snapshot_ms', async () => {
            if ((await tab.url()) !== profile.draftListUrl) await tab.goto(profile.draftListUrl)
            return new Set(await stableDraftEditUrls(driver, profile))
          })
          stage = 'open_create_form'
          await measure('create_readiness_ms', async () => {
            await tab.goto(profile.entryUrl)
            await exactRole('heading', 'List an item')
            await beforeAuthenticatedWrite()
          })
        } else {
          before = resume.before
          stage = 'resume_create_form'
          await exactRole('heading', 'List an item')
        }
        stage = 'populate_create_form'
        await populateCreateForm(prepared)

        stage = 'submit_initial_draft'
        await measure('initial_save_ms', async () => {
          const save = await exactRole(profile.actions.saveDraft.role, profile.actions.saveDraft.name)
          externalWriteAttempted = true
          await clickAndSettle(driver, save)
        })

        stage = 'resolve_new_draft_identity'
        const canonicalUrl = await measure('identity_ms', () => newDraftUrl(before))
        metrics.acknowledgedAt = Date.now()
        stage = 'open_new_draft'
        await measure('sku_write_ms', async () => {
          if ((await tab.url()) !== canonicalUrl) await tab.goto(canonicalUrl)
          await exactRole('heading', 'Draft')
          stage = 'populate_sku'
          await driver.fill(await exactRole('textbox', profile.fields.sku.label), prepared.sku)
          await pause()
        })

        stage = 'submit_sku_update'
        await measure('sku_update_ms', async () => {
          const update = await exactRole(
            profile.actions.updateDraft.role,
            profile.actions.updateDraft.name
          )
          await clickAndSettle(driver, update)
        })

        stage = 'verify_sku_update'
        const persisted = await measure('sku_verification_ms', async () => {
          let observed
          for (let attempt = 0; attempt < 20; attempt += 1) {
            try {
              observed = await readAuthenticatedDraft(canonicalUrl)
              if (observed.sku === prepared.sku) break
            } catch {
              // The update may briefly redirect through the drafts table. Reopen the stable URL.
            }
            await delay(SETTLE_POLL_MS)
          }
          return observed
        })
        if (persisted?.sku !== prepared.sku) {
          throw safeBrowserError('draft_sku_not_persisted', 'Draft SKU did not persist')
        }
        metrics.completedAt = Date.now()
        return {
          outcome: 'saved',
          status: 'draft',
          canonical_url: canonicalUrl,
          external_identity: persisted.external_identity,
        }
      } catch (error) {
        if (
          error?.code === 'browser_category_inference_required' &&
          externalWriteAttempted === false &&
          before instanceof Set
        ) {
          pendingPrewrite = {
            before,
            foldListingId: prepared.foldListingId,
            sku: prepared.sku,
            audience: prepared.categorySelection?.audience,
            terms: [...(prepared.categorySelection?.terms ?? [])],
            pausedAt: Date.now(),
          }
        }
        if (error !== null && typeof error === 'object') {
          error.stage = stage
          error.externalWriteAttempted = externalWriteAttempted
        }
        throw error
      }
    },

    async readDraft(identity) {
      const persisted = await measure('persisted_verification_ms', () =>
        readAuthenticatedDraft(identity.canonical_url)
      )
      if (
        persisted.external_identity !== identity.external_identity ||
        persisted.sku !== identity.sku
      ) {
        throw safeBrowserError(
          'draft_verification_identity_mismatch',
          'Saved draft identity correlation failed'
        )
      }
      metrics.verifiedAt = Date.now()
      return persisted
    },

    metrics() {
      return Object.freeze({
        elapsed_ms:
          metrics.startedAt === null || metrics.completedAt === null
            ? null
            : metrics.completedAt - metrics.startedAt - metrics.inferenceWaitMs,
        draft_acknowledged_ms:
          metrics.startedAt === null || metrics.acknowledgedAt === null
            ? null
            : metrics.acknowledgedAt - metrics.startedAt - metrics.inferenceWaitMs,
        fully_verified_ms:
          metrics.startedAt === null || metrics.verifiedAt === null
            ? null
            : metrics.verifiedAt - metrics.startedAt - metrics.inferenceWaitMs,
        inference_wait_ms: metrics.inferenceWaitMs,
        phase_ms: Object.freeze({ ...metrics.phases }),
        interaction_delay_ms: interactionDelayMs,
        visible_steps: metrics.steps,
      })
    },
  })
}
