import path from 'node:path'

import {
  byCss,
  byId,
  byRole,
  byTestId,
  refAt,
  refCount,
  refElement,
  requireBrowserDriver,
} from '../shared/browser-driver.mjs'
import {
  isVintedLiveActionName,
  vintedDraftEditUrl,
  vintedWardrobeMemberId,
  vintedWardrobeUrl,
} from './profile.mjs'
import { withDetail } from '../shared/error-detail.mjs'

const POLL_MS = 150
const POLL_ATTEMPTS = 40
const STABLE_READS = 3

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function collapsed(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function capabilityError(code, message, extra = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, extra)
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

function normalizedInteger(value, name, fallback, max) {
  const resolved = value ?? fallback
  if (!Number.isInteger(resolved) || resolved < 0 || resolved > max) {
    throw new TypeError(`${name} must be an integer from 0 through ${max}`)
  }
  return resolved
}

/**
 * A brand label's comparison key: accents stripped (NFD, combining marks removed), case folded,
 * whitespace collapsed. Vinted's label "Aéropostale" is Fold's "Aeropostale" (run 14). Titles are
 * never compared this way — only brands.
 */
function brandKey(value) {
  return collapsed(value).normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('en-US')
}

/** A price field's text as `"12.50"`, or the raw text when it is not a plain dollar amount. */
function normalizedPrice(value) {
  const text = collapsed(value).replace(/^\$/, '').replaceAll(',', '')
  return /^\d+(?:\.\d{1,2})?$/.test(text) ? Number(text).toFixed(2) : collapsed(value)
}

/**
 * Drives the vinted.com sell form for one prepared Fold listing and saves it with Save draft.
 *
 * Every control is reached through the shared Layer C driver by the exact test id or element id the
 * live capture recorded, every value is read back after it is written, and every failure is thrown
 * with a field-scoped code before Save draft is ever pressed. Nothing here can activate Vinted's
 * Upload button: each click passes `assertClickable`, which refuses that control by test id and by
 * name, and the one button this capability presses must be exactly Save draft.
 */
export function createVintedBrowserCapability(options = {}) {
  const tab = requiredObject(options.tab, 'tab')
  const profile = requiredObject(options.profile, 'profile')
  if (profile.kind !== 'vinted') throw new TypeError('profile must be a Vinted target profile')
  const driver = requireBrowserDriver(tab.driver, 'tab.driver')
  for (const method of ['goto', 'url']) requiredFunction(tab[method], `tab.${method}`)
  const resolvePhotoFiles = requiredFunction(options.resolvePhotoFiles, 'resolvePhotoFiles')
  const beforeAuthenticatedWrite =
    options.beforeAuthenticatedWrite === undefined
      ? async () => {}
      : requiredFunction(options.beforeAuthenticatedWrite, 'beforeAuthenticatedWrite')
  const interactionDelayMs = normalizedInteger(options.interactionDelayMs, 'interactionDelayMs', 0, 1000)
  const pollMs = normalizedInteger(options.pollMs, 'pollMs', POLL_MS, 5000)
  // The seller's wardrobe is `/member/{memberId}`; Save draft lands there. Supplied by the host, or
  // learned from the first landing; required before a draft is created so an existing one is found.
  let memberId = options.memberId === undefined || options.memberId === null ? null : String(options.memberId)
  // How long one call waits for Save draft to reach the wardrobe before handing the confirmation to
  // the next call (a draft must fit a host's ~55 s call budget; run 13's landing took longer).
  const saveConfirmationMs = normalizedInteger(options.saveConfirmationMs, 'saveConfirmationMs', 20000, 120000)
  // Expectations of a save not yet confirmed, kept for the call that confirms it.
  const pendingExpectations = new Map()
  if (memberId !== null && !/^\d+$/.test(memberId)) {
    throw capabilityError(
      'vinted_member_id_invalid',
      `memberId must be the number in the seller's wardrobe URL (/member/{id}), not "${memberId.slice(0, 40)}"`
    )
  }
  const { controls, options: optionIds, optionPatterns, actions, fieldIds } = profile

  const metrics = { startedAt: null, completedAt: null, verifiedAt: null, steps: 0, phases: Object.create(null) }
  let stage = 'idle'
  let notes = {}
  // What this transaction put on the form, re-read from the saved draft's edit page.
  let expected = {}
  // Re-reads run just before Save draft: Vinted fills fields itself from the photos (category,
  // brand, colors), possibly after this transaction already set them.
  let finalChecks = []

  async function pause() {
    metrics.steps += 1
    if (interactionDelayMs > 0) await delay(interactionDelayMs)
  }

  async function measure(name, operation) {
    const startedAt = Date.now()
    try {
      return await operation()
    } finally {
      metrics.phases[name] = (metrics.phases[name] ?? 0) + (Date.now() - startedAt)
    }
  }

  /**
   * Run at every step: the page must still be on vinted.com, and must not have been redirected to
   * the account-verification flow. That redirect is a blocking precondition for the seller, never
   * something to click through.
   */
  async function checkpoint() {
    let current
    try {
      current = new URL(await tab.url())
    } catch (error) {
      throw capabilityError('browser_url_missing', withDetail('The Vinted tab URL could not be read', error))
    }
    if (current.origin !== profile.origin) {
      throw capabilityError('browser_origin_mismatch', 'The Vinted tab left the configured origin')
    }
    if (current.pathname.startsWith(profile.verificationPathPrefix)) {
      throw capabilityError(
        'vinted_phone_verification_required',
        'Vinted redirected to account verification; the seller must verify their account first',
        { blocking: true }
      )
    }
    await settleAuthenticityPrompts()
  }

  /**
   * Vinted's proof-of-authenticity modal can sit over the form. It is closed with its own Close
   * button and nothing else; when it — or the inline hint under Brand — is present, the seller is
   * told Vinted wants authenticity photos.
   */
  async function settleAuthenticityPrompts() {
    const { authenticity } = profile
    if (refCount(await driver.locate(byRole('heading', authenticity.inlineHeading))) > 0) {
      notes.authenticity_hint = authenticity.hint
    }
    if (refCount(await driver.locate(byRole('heading', authenticity.overlayHeading))) === 0) return
    notes.authenticity_hint = authenticity.hint
    const closes = await driver.locate(byRole('button', authenticity.overlayClose))
    // Both Close buttons seen live belong to the modal; more than that and "Close" cannot be scoped.
    if (refCount(closes) === 0 || refCount(closes) > 2) {
      throw capabilityError(
        'vinted_authenticity_overlay_unhandled',
        `Vinted's proof-of-authenticity dialog is open and offers ${refCount(closes)} Close buttons`
      )
    }
    await click(refAt(closes, 0))
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
      if (refCount(await driver.locate(byRole('heading', authenticity.overlayHeading))) === 0) return
      if (pollMs > 0) await delay(pollMs)
    }
    throw capabilityError(
      'vinted_authenticity_overlay_unhandled',
      "Vinted's proof-of-authenticity dialog did not close"
    )
  }

  function fieldError(field, problem, message) {
    return capabilityError(`vinted_${field}_${problem}`, message, { field })
  }

  async function exactlyOne(query, field, what) {
    const located = await driver.locate(query)
    const count = refCount(located)
    if (count === 1) return located
    throw fieldError(
      field,
      count === 0 ? 'control_missing' : 'control_ambiguous',
      `Expected exactly one ${what} on the Vinted form, found ${count} (${describeQuery(query)})`
    )
  }

  /** Polls for one exact control; Vinted renders dropdown rows and category fields asynchronously. */
  async function waitForOne(query, field, what) {
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
      const located = await driver.locate(query)
      const count = refCount(located)
      if (count === 1) return located
      if (count > 1) throw fieldError(field, 'option_ambiguous', `More than one ${what} is on the Vinted form`)
      if (pollMs > 0) await delay(pollMs)
    }
    throw fieldError(field, 'option_missing', `Vinted did not offer ${what}`)
  }

  /** Refuses Vinted's publish control however it was reached. */
  function assertClickable(element) {
    if (element.testId === actions.publish.testId) {
      throw capabilityError('vinted_live_action_refused', "Refusing Vinted's publishing Upload control")
    }
    if (element.role === 'button' && collapsed(element.name) === actions.publish.name) {
      throw capabilityError('vinted_live_action_refused', "Refusing Vinted's publishing Upload control")
    }
    if (profile.authenticity.neverClick.includes(collapsed(element.name))) {
      throw capabilityError('vinted_control_refused', `Refusing Vinted's "${collapsed(element.name)}" control`)
    }
  }

  async function click(located) {
    assertClickable(refElement(located))
    await driver.click(located)
    await pause()
  }

  async function inputValue(testId, field) {
    return String(refElement(await fieldInput(testId, field)).value ?? '')
  }

  async function fillExact(testId, value, field, normalize = (text) => text.replace(/\r\n/g, '\n')) {
    await driver.fill(await fieldInput(testId, field), value)
    await pause()
    if (normalize(await inputValue(testId, field)) !== normalize(value)) {
      throw fieldError(field, 'not_persisted', `Vinted did not keep the ${field} that was written`)
    }
    finalChecks.push(async () => {
      if (normalize(await inputValue(testId, field)) !== normalize(value)) {
        throw fieldError(field, 'changed_before_save', `Vinted changed the ${field} before Save draft`)
      }
    })
  }

  /**
   * Every captured dropdown renders its content under the input's test id with `-input` swapped for
   * `-content` (catalog-select-dropdown-input -> catalog-select-dropdown-content, and so on).
   */
  function contentTestId(testId) {
    return testId.replace(/-input$/, '-content')
  }

  async function dropdownOpen(testId) {
    if (refCount(await driver.locate(byTestId(contentTestId(testId)))) > 0) return true
    // A brand dropdown whose content carries another test id is still recognised by its search.
    return testId === controls.brand && refCount(await driver.locate(byId(optionIds.brandSearchInput))) > 0
  }

  /**
   * Field inputs are addressed by element id (`#brand`, `#category`, …): live run 9 found the
   * Brand input under its id on Straight fit jeans while its captured test id matched nothing. The
   * test id still names the field and its dropdown content.
   */
  function inputQuery(testId) {
    const id = fieldIds[testId] ?? /^category-(.+)-single-list-input$/.exec(testId)?.[1]
    if (id === undefined) throw new TypeError(`No field id is known for ${testId}`)
    return byId(id)
  }

  /**
   * One field input, waited for. Choosing a category re-renders the fields that depend on it, so a
   * field can be briefly absent right after (live run 10: `#brand` matched nothing on the first
   * read). A field still absent after the wait is reported with what the form did show.
   */
  async function fieldInput(testId, field) {
    const query = inputQuery(testId)
    let count = 0
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
      const located = await driver.locate(query)
      count = refCount(located)
      if (count === 1) return located
      if (pollMs > 0) await delay(pollMs)
    }
    const present = []
    for (const id of Object.values(fieldIds)) {
      const found = refCount(await driver.locate(byId(id)))
      if (found > 0) present.push(found === 1 ? `#${id}` : `#${id}×${found}`)
    }
    throw fieldError(
      field,
      count === 0 ? 'control_missing' : 'control_ambiguous',
      `Expected exactly one ${field} field on the Vinted form, found ${count} (${describeQuery(query)}) ` +
        `after waiting; fields present: ${present.join(', ') || 'none'}`
    )
  }

  function describeQuery(query) {
    if (query.by === 'id') return `#${query.id}`
    if (query.by === 'testId') return `[data-testid=${query.testId}]`
    return query.by
  }

  async function waitUntil(predicate) {
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
      if (await predicate()) return true
      if (pollMs > 0) await delay(pollMs)
    }
    return false
  }

  /**
   * Every open dropdown's content element. Matched by test-id suffix — every captured dropdown
   * content ends `-dropdown-content`, `-list-content` or `-grid-content` — so one Vinted adds is
   * still seen. The selector only finds where to deliver Escape; it never picks a control.
   */
  const OPEN_DROPDOWN_SELECTOR =
    '[data-testid$="-dropdown-content"], [data-testid$="-list-content"], [data-testid$="-grid-content"]'

  async function openDropdownContents() {
    return driver.locate(byCss(OPEN_DROPDOWN_SELECTOR))
  }

  /**
   * Closes whatever dropdown is open with Escape. Observed live 2026-10-04: Vinted opens the
   * category picker by itself after photos upload, clicking a field's own input does not close its
   * dropdown, and an Escape keydown closes any of them.
   */
  /**
   * Codex cannot press keys at a non-focusable element such as the content div, so Escape is
   * pressed at the open dropdown's own field input (focusable; the keydown bubbles to the document).
   * The category picker can also be closed by clicking its already-checked suggestion (observed
   * live), which is the fallback when Escape does not take.
   */
  async function escapeFrom(content) {
    const testId = refElement(content).testId
    const fieldTestId = typeof testId === 'string' ? testId.replace(/-content$/, '-input') : null
    if (fieldTestId !== null && typeof driver.pressKey === 'function') {
      let input = null
      try {
        input = await driver.locate(inputQuery(fieldTestId))
      } catch {}
      if (input !== null && refCount(input) === 1) {
        await driver.pressKey(input, 'Escape')
        await pause()
        if (await waitUntil(async () => refCount(await driver.locate(byTestId(testId))) === 0)) return true
      }
    }
    if (testId === controls.categoryContent) {
      const { located, members } = await optionFamily('radio', optionPatterns.catalogSuggestion)
      const checked = members.filter(({ element }) => element.checked === true)
      if (checked.length === 1) {
        await click(refAt(located, checked[0].index))
        if (await waitUntil(async () => refCount(await driver.locate(byTestId(testId))) === 0)) return true
      }
    }
    return false
  }

  /**
   * Closes whatever dropdown is open. Observed live 2026-10-04: Vinted opens the category picker by
   * itself after photos upload, clicking a field's own input does not close its dropdown, and an
   * Escape keydown closes any of them.
   */
  async function closeAllDropdowns(field) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const open = await openDropdownContents()
      if (refCount(open) === 0) return
      if (!(await escapeFrom(refAt(open, 0)))) break
    }
    const still = await openDropdownContents()
    if (refCount(still) === 0) return
    const names = []
    for (let index = 0; index < refCount(still); index += 1) names.push(refElement(still, index).testId)
    throw fieldError(
      field,
      'dropdown_stuck',
      typeof driver.pressKey === 'function'
        ? `Neither Escape at its field nor its checked suggestion closed the open dropdown (${names.join(', ')})`
        : `A dropdown is open (${names.join(', ')}) and this browser driver cannot press Escape`
    )
  }

  async function closeDropdown(testId, field) {
    if (await dropdownOpen(testId)) await closeAllDropdowns(field)
  }

  /** What is showing around a dropdown that failed to open, for the failure text. */
  async function dropdownSituation(testId, field) {
    const contents = await openDropdownContents()
    const open = []
    for (let index = 0; index < refCount(contents); index += 1) open.push(refElement(contents, index).testId)
    const value = collapsed(await inputValue(testId, field))
    return `field value "${value}", open dropdowns: ${open.join(', ') || 'none'}`
  }

  /**
   * Opens one field's dropdown and waits for it. Any other open dropdown is closed first, with
   * Escape — a click on a field while another dropdown is open can be spent closing that one. If one
   * click does not open it, a second click is tried.
   */
  async function openDropdown(testId, field) {
    await waitForOne(inputQuery(testId), field, `${field} field`)
    if (await dropdownOpen(testId)) return
    await closeAllDropdowns(field)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await click(await exactlyOne(inputQuery(testId), field, `${field} field`))
      if (await waitUntil(() => dropdownOpen(testId))) return
    }
    throw fieldError(
      field,
      'dropdown_unopened',
      `The ${field} dropdown did not open after two clicks; ${await dropdownSituation(testId, field)}`
    )
  }

  /**
   * After a single-choice pick the field's own input shows the chosen option's label — observed for
   * Category in the capture and for Brand, Size and Condition on the first saved draft (run 11). A
   * mismatch fails that field closed.
   */
  async function assertDropdownShows(testId, expected, field) {
    let shown
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
      shown = collapsed(await inputValue(testId, field))
      if (shown === collapsed(expected)) return
      if (pollMs > 0) await delay(pollMs)
    }
    throw fieldError(field, 'not_persisted', `Vinted shows "${shown}" for ${field}, not "${collapsed(expected)}"`)
  }

  /** Records a re-read of one single-choice field for the pre-save check. */
  function expectShows(testId, wanted, field) {
    expected[field] = collapsed(wanted)
    finalChecks.push(async () => {
      const shown = collapsed(await inputValue(testId, field))
      if (shown !== collapsed(wanted)) {
        throw fieldError(field, 'changed_before_save', `Vinted changed ${field} to "${shown}" before Save draft`)
      }
    })
  }

  /** Every element of one option family, identified by its own id or test id pattern. */
  async function optionFamily(role, pattern, key = 'id') {
    const located = await driver.locate(byRole(role))
    const members = []
    for (let index = 0; index < refCount(located); index += 1) {
      const element = refElement(located, index)
      if (typeof element[key] === 'string' && pattern.test(element[key])) {
        members.push({ index, element })
      }
    }
    return { located, members }
  }

  /**
   * `resolvePhotoFiles(photos)` is the host's half of the photo contract. It receives the prepared
   * photos — `[{ sourceUrl, filename, order }]`, Fold order — and must return one absolute local file
   * path per photo, same order, each path's basename equal to that photo's `filename`. The installed
   * `workflows/photo-files.mjs` `createPhotoFileResolver()` does exactly this.
   */
  async function resolvedPhotoPaths(photos) {
    let files
    try {
      files = await resolvePhotoFiles(
        photos.map(({ sourceUrl, filename, order }) => ({ sourceUrl, filename, order }))
      )
    } catch (error) {
      throw fieldError('photos', 'files_unresolved', withDetail('resolvePhotoFiles(photos) failed', error))
    }
    const contract =
      'resolvePhotoFiles(photos) receives [{ sourceUrl, filename, order }] and must return absolute ' +
      'file paths in the same order whose basenames equal each filename'
    if (!Array.isArray(files) || files.length !== photos.length || !files.every(nonEmptyString)) {
      const got = Array.isArray(files) ? `${files.length} entries` : typeof files
      throw fieldError('photos', 'files_mismatch', `${contract}; got ${got} for ${photos.length} photos`)
    }
    if (!files.every((file) => path.isAbsolute(file))) {
      throw fieldError('photos', 'files_not_absolute', `${contract}; a returned path is not absolute`)
    }
    const misnamed = files.findIndex((file, index) => path.basename(file) !== photos[index].filename)
    if (misnamed !== -1) {
      throw fieldError(
        'photos',
        'filenames_mismatch',
        `${contract}; path ${misnamed} is not named ${photos[misnamed].filename}`
      )
    }
    return files
  }

  async function uploadPhotos(photos) {
    const files = await resolvedPhotoPaths(photos)
    // The input takes a batch (run 11 saved a two-photo draft in one delivery). Both drivers still
    // refuse a multi-file delivery to a single-file input before sending anything.
    const input = await exactlyOne(byTestId(controls.photosInput), 'photos', 'photo input')
    // The visible "Upload photos" button opens the same chooser. A driver that must click to get a
    // file chooser (Codex) clicks it rather than the hidden input; claude-in-chrome never clicks.
    const trigger = await driver.locate(byRole('button', controls.photosTrigger))
    const result = await driver.uploadFiles(input, files, refCount(trigger) === 1 ? { trigger } : undefined)
    if (files.length > 1 && result?.multiple !== true) {
      throw fieldError('photos', 'input_not_multiple', 'The Vinted photo input does not accept a batch')
    }
    expected.photo_count = files.length
    await pause()
  }

  function expectCategory(category) {
    finalChecks.push(async () => {
      if (collapsed(await inputValue(controls.category, 'category')) !== category.title) {
        throw fieldError('category', 'changed_before_save', 'Vinted changed the category before Save draft')
      }
    })
  }

  async function categoryPickerOpen() {
    return refCount(await driver.locate(byTestId(controls.categoryContent))) > 0
  }

  /** Opens the picker at its root. Reopening resets it to the root, so an open picker is closed first. */
  async function openCategoryAtRoot(rootId) {
    await waitForOne(inputQuery(controls.category), 'category', 'category field')
    await closeAllDropdowns('category')
    await openDropdown(controls.category, 'category')
    await appearsWithin(byId(optionIds.catalogRow(rootId)))
  }

  async function appearsWithinOrNull(query) {
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
      const located = await driver.locate(query)
      if (refCount(located) === 1) return located
      if (pollMs > 0) await delay(pollMs)
    }
    return null
  }

  /** Polls for exactly one match; returns it, or null if none appears in time. */
  async function appearsWithin(query) {
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
      const located = await driver.locate(query)
      if (refCount(located) === 1) return located
      if (refCount(located) > 1) {
        throw fieldError('category', 'option_ambiguous', `More than one ${query.id ?? 'category row'} is on the form`)
      }
      if (pollMs > 0) await delay(pollMs)
    }
    return null
  }

  async function visibleCategoryRows() {
    const ids = []
    for (const role of ['button', 'radio']) {
      const { members } = await optionFamily(role, optionPatterns.catalogRow)
      ids.push(...members.map(({ element }) => element.id))
    }
    return ids.slice(0, 12).join(', ') || 'none'
  }

  /**
   * One leaf, chosen by Vinted's own id. If Vinted already suggests exactly that leaf (it guesses a
   * category from the photos), its suggestion radio is clicked; otherwise the tree is walked root ->
   * leaf, each branch click followed by a bounded wait for the next expected row. Vinted can reset
   * the picker while it applies its own photo-based guess, so a broken walk is retried once from the
   * root; a second failure names the level and the rows that were showing.
   */
  async function selectCategory(category) {
    // Vinted opens the picker by itself once it has guessed from the photos. When its checked
    // suggestion is already Fold's exact leaf and the field shows that leaf, it is accepted as is.
    if (await categoryPickerOpen()) {
      const arrived = await driver.locate(byId(optionIds.catalogSuggestion(category.leafId)))
      if (
        refCount(arrived) === 1 &&
        refElement(arrived).checked === true &&
        collapsed(await inputValue(controls.category, 'category')) === category.title
      ) {
        await closeAllDropdowns('category')
        expectCategory(category)
        return
      }
    }
    let failure = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await openCategoryAtRoot(category.ids[0])
      const suggestion = await driver.locate(byId(optionIds.catalogSuggestion(category.leafId)))
      if (refCount(suggestion) === 1) {
        if (refElement(suggestion).checked !== true) await click(suggestion)
      } else {
        failure = null
        for (let level = 0; level < category.ids.length; level += 1) {
          const row = await appearsWithin(byId(optionIds.catalogRow(category.ids[level])))
          if (row === null) {
            failure =
              `Vinted did not offer category row ${category.titles[level]} (${category.ids[level]}) at ` +
              `depth ${level + 1} of ${category.ids.length} (${category.titles.slice(0, level).join(' > ') || 'root'}); ` +
              `rows showing: ${await visibleCategoryRows()}`
            break
          }
          const expectedRole = level === category.ids.length - 1 ? 'radio' : 'button'
          if (refElement(row).role !== expectedRole) {
            throw fieldError(
              'category',
              'path_mismatch',
              `Category row ${category.ids[level]} is a ${refElement(row).role || 'plain element'}, not a ${expectedRole}`
            )
          }
          await click(row)
          await checkpoint()
        }
        if (failure !== null) continue
      }
      try {
        await assertDropdownShows(controls.category, category.title, 'category')
      } catch (error) {
        failure = `the category field shows "${collapsed(await inputValue(controls.category, 'category'))}", not "${category.title}"`
        continue
      }
      await closeAllDropdowns('category')
      expectCategory(category)
      return
    }
    throw fieldError('category', 'option_missing', failure ?? 'Vinted did not hold the category')
  }

  async function selectListOption({ code, id }) {
    await openDropdown(optionIds.listInput(code), code)
    const option = await waitForOne(byId(optionIds.listOption(code, id)), code, `${code} option ${id}`)
    const label = collapsed(refElement(option).name)
    await click(option)
    await assertDropdownShows(optionIds.listInput(code), label, code)
    expectShows(optionIds.listInput(code), label, code)
    expected[code] = label
  }

  /**
   * Brand results are only read once they demonstrably belong to this search: the custom-brand row
   * echoes the query, the "Popular brands" list shown before typing is gone, and the same result
   * set is read three times running. LIVE-UNCONFIRMED: that the popular label leaves once a search
   * runs — it is present in the captured unsearched dropdown and absent from both captured searches.
   */
  async function settledBrandResults(query) {
    const customText = `Use "${query}" as brand`
    let previous = null
    let stableReads = 0
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
      const family = await optionFamily('radio', optionPatterns.brand)
      const custom = await driver.locate(byId(optionIds.brandCustom))
      const popular = refCount(await driver.locate(byId(optionIds.brandPopularLabel)))
      const empty = refCount(await driver.locate(byTestId(controls.brandEmptyState)))
      const ready =
        refCount(custom) === 1 &&
        collapsed(refElement(custom).name) === customText &&
        popular === 0 &&
        (family.members.length > 0 || empty === 1)
      const signature = JSON.stringify(family.members.map(({ element }) => [element.id, collapsed(element.name)]))
      if (ready) {
        stableReads = signature === previous ? stableReads + 1 : 1
        previous = signature
        if (stableReads >= STABLE_READS) return family.members.map(({ element }) => element)
      } else {
        stableReads = 0
        previous = null
      }
      if (pollMs > 0) await delay(pollMs)
    }
    throw fieldError('brand', 'results_unsettled', 'Vinted brand search results did not settle')
  }

  /** Exact brand (case-insensitive) -> that row; no exact match -> Vinted's custom brand; none -> No brand. */
  async function selectBrand(brand) {
    const preset = collapsed(await inputValue(controls.brand, 'brand'))
    // Vinted may already show Fold's brand (it guesses brands from the photos). The same name,
    // ignoring case only, is accepted as is and still re-read before Save draft.
    if (brand !== null && preset !== '' && brandKey(preset) === brandKey(brand)) {
      expectShows(controls.brand, preset, 'brand')
      return
    }
    await openDropdown(controls.brand, 'brand')
    if (brand === null) {
      const none = await waitForOne(byId(optionIds.brandNone), 'brand', 'the No brand option')
      const label = collapsed(refElement(none).name)
      await click(none)
      await assertDropdownShows(controls.brand, label, 'brand')
      expectShows(controls.brand, label, 'brand')
      return
    }
    const search = await appearsWithinOrNull(byTestId(controls.brandSearch))
    if (search === null) {
      throw fieldError(
        'brand',
        'search_missing',
        `The brand dropdown opened without its search field; ${await dropdownSituation(controls.brand, 'brand')}`
      )
    }
    await driver.fill(search, brand)
    await pause()
    const results = await settledBrandResults(brand)
    const wanted = brandKey(brand)
    const exact = results.filter((element) => brandKey(element.name) === wanted)
    if (exact.length > 1) {
      throw fieldError('brand', 'option_ambiguous', 'More than one Vinted brand matches this brand exactly')
    }
    // Re-located by id right before the click: a later enumeration can re-address an element a
    // driver already handed out, so only a fresh ref is acted on.
    if (exact.length === 1) {
      const label = collapsed(exact[0].name)
      await click(await exactlyOne(byId(exact[0].id), 'brand', `brand ${label}`))
      await assertDropdownShows(controls.brand, label, 'brand')
      expectShows(controls.brand, label, 'brand')
      return
    }
    await click(await exactlyOne(byId(optionIds.brandCustom), 'brand', 'the custom brand option'))
    await assertDropdownShows(controls.brand, brand, 'brand')
    expectShows(controls.brand, brand, 'brand')
  }

  async function selectSize(size) {
    await openDropdown(controls.size, 'size')
    let matches = []
    let located
    for (let attempt = 0; attempt < POLL_ATTEMPTS && matches.length === 0; attempt += 1) {
      const family = await optionFamily('checkbox', optionPatterns.sizeOption, 'testId')
      located = family.located
      matches = family.members.filter(({ element }) => collapsed(element.name) === collapsed(size))
      if (matches.length === 0 && pollMs > 0) await delay(pollMs)
    }
    if (matches.length === 0) throw fieldError('size', 'option_missing', 'This Vinted category offers no such size')
    if (matches.length > 1) throw fieldError('size', 'option_ambiguous', 'More than one Vinted size has this label')
    await click(refAt(located, matches[0].index))
    await assertDropdownShows(controls.size, size, 'size')
    expectShows(controls.size, size, 'size')
  }

  async function selectCondition(condition) {
    await openDropdown(controls.condition, 'condition')
    const option = await waitForOne(byId(optionIds.condition(condition.id)), 'condition', `condition ${condition.id}`)
    const title = collapsed(
      await driver.readText(
        await exactlyOne(byTestId(optionIds.conditionTitle(condition.id)), 'condition', 'condition title')
      )
    )
    if (title !== condition.label) {
      throw fieldError('condition', 'label_mismatch', 'The Vinted condition id no longer carries its captured label')
    }
    await click(option)
    await assertDropdownShows(controls.condition, title, 'condition')
    expectShows(controls.condition, title, 'condition')
  }

  /**
   * The option rows of one multi-choice dropdown (`#color-{id}`, `#material-{id}`, role=checkbox,
   * `aria-checked`), with their labels. They exist only while the dropdown is open (proven live
   * 2026-10-04); their inner `input#…-checkbox-{id}` can be hidden from a host's role queries, so
   * state is read from the rows themselves.
   */
  async function optionRows(rowPattern, prefix) {
    const { members } = await optionFamily('checkbox', rowPattern)
    return members.map(({ element }) => ({
      id: element.id.slice(prefix.length),
      label: collapsed(element.name),
      checked: element.checked === true,
    }))
  }

  /** A multi-choice field's closed input shows the chosen labels joined with ", " (seen live). */
  function shownLabels(value) {
    return collapsed(value).split(/\s*,\s*/).filter((label) => label !== '').sort()
  }

  /**
   * Multi-choice pick. Vinted may already have ticked values it guessed from the photos; any id Fold
   * did not send is unticked, so the draft never carries a guess. The result is verified twice:
   * from the rows while the dropdown is still open, and — after it closes, when the rows are gone —
   * from the field's own value against the labels those rows carried. With nothing to send and
   * nothing shown, the field is left alone.
   */
  async function selectMany(field, testId, ids, optionId, rowPattern, prefix) {
    const shown = collapsed(await inputValue(testId, field))
    if (ids.length === 0 && shown === '') return
    const wanted = [...ids].sort()
    await openDropdown(testId, field)
    let rows = []
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
      rows = await optionRows(rowPattern, prefix)
      if (rows.length > 0) break
      if (pollMs > 0) await delay(pollMs)
    }
    const labels = new Map(rows.map((row) => [row.id, row.label]))
    const missing = wanted.filter((id) => !labels.has(id))
    if (missing.length > 0) {
      throw fieldError(field, 'option_missing', `Vinted did not offer ${field} ${missing.join(', ')}`)
    }
    for (const row of rows.filter((entry) => entry.checked && !wanted.includes(entry.id))) {
      await click(await exactlyOne(byId(optionId(row.id)), field, `${field} ${row.id}`))
    }
    for (const id of wanted.filter((value) => !rows.some((row) => row.id === value && row.checked))) {
      await click(await exactlyOne(byId(optionId(id)), field, `${field} ${id}`))
    }
    const held = (await optionRows(rowPattern, prefix)).filter((row) => row.checked).map((row) => row.id).sort()
    if (JSON.stringify(held) !== JSON.stringify(wanted)) {
      throw fieldError(field, 'not_persisted', `Vinted holds ${field} [${held}], not [${wanted}]`)
    }
    await closeDropdown(testId, field)
    const expectedLabels = wanted.map((id) => labels.get(id)).sort()
    const closedLabels = shownLabels(await inputValue(testId, field))
    if (JSON.stringify(closedLabels) !== JSON.stringify(expectedLabels)) {
      throw fieldError(
        field,
        'not_persisted',
        `The closed ${field} field shows [${closedLabels.join(', ')}], not [${expectedLabels.join(', ')}]`
      )
    }
    expected[field] = expectedLabels
    finalChecks.push(async () => {
      const again = shownLabels(await inputValue(testId, field))
      if (JSON.stringify(again) !== JSON.stringify(expectedLabels)) {
        throw fieldError(field, 'changed_before_save', `Vinted changed ${field} to [${again.join(', ')}] before Save draft`)
      }
    })
  }

  /**
   * Vinted pre-selects a "Recommended" package size once the category is set, so Fold's own id is
   * clicked explicitly and then confirmed as the only checked package radio.
   */
  async function selectPackageSize(id) {
    await click(await waitForOne(byId(optionIds.packageSize(id)), 'package_size', `package size ${id}`))
    const { members } = await optionFamily('radio', optionPatterns.packageSize)
    const checked = members.filter(({ element }) => element.checked === true).map(({ element }) => element.id)
    if (checked.length !== 1 || checked[0] !== optionIds.packageSize(id)) {
      throw fieldError('package_size', 'not_persisted', 'Vinted did not hold the chosen package size')
    }
    expected.package_size = optionIds.packageSize(id)
    finalChecks.push(async () => {
      const { members: again } = await optionFamily('radio', optionPatterns.packageSize)
      const now = again.filter(({ element }) => element.checked === true).map(({ element }) => element.id)
      if (now.length !== 1 || now[0] !== optionIds.packageSize(id)) {
        throw fieldError('package_size', 'changed_before_save', 'Vinted changed the package size before Save draft')
      }
    })
  }

  async function step(name, operation) {
    stage = name
    await measure(`${name}_ms`, operation)
    await checkpoint()
  }

  async function populate(prepared) {
    await step('photos', () => uploadPhotos(prepared.photos))
    await step('title', () => fillExact(controls.title, prepared.title, 'title'))
    await step('description', () => fillExact(controls.description, prepared.description, 'description'))
    await step('category', () => selectCategory(prepared.category))
    for (const list of prepared.lists) await step(list.code, () => selectListOption(list))
    await step('brand', () => selectBrand(prepared.brand))
    if (prepared.size !== null) await step('size', () => selectSize(prepared.size))
    await step('condition', () => selectCondition(prepared.condition))
    await step('color', () =>
      selectMany('color', controls.color, prepared.colors, optionIds.color, optionPatterns.colorRow, 'color-')
    )
    await step('material', () =>
      selectMany(
        'material',
        controls.material,
        prepared.materials,
        optionIds.material,
        optionPatterns.materialRow,
        'material-'
      )
    )
    await step('package_size', () => selectPackageSize(prepared.packageSize))
    await step('price', () => fillExact(controls.price, prepared.price, 'price', normalizedPrice))
    await step('final_check', async () => {
      for (const check of finalChecks) await check()
    })
  }

  /** The one button this capability presses. It must be exactly Save draft, never Upload. */
  async function saveDraftControl() {
    const save = await exactlyOne(byTestId(actions.saveDraft.testId), 'save_draft', 'Save draft button')
    const element = refElement(save)
    assertClickable(element)
    if (
      element.testId !== actions.saveDraft.testId ||
      collapsed(element.name) !== actions.saveDraft.name ||
      isVintedLiveActionName(element.name)
    ) {
      throw capabilityError('vinted_live_action_refused', 'The save control is not exactly Save draft')
    }
    return save
  }

  /** True when no Fold value is on the form yet: nothing typed, nothing chosen. */
  async function formIsPristine() {
    for (const [testId, field] of [
      [controls.title, 'title'],
      [controls.description, 'description'],
      [controls.category, 'category'],
      [controls.price, 'price'],
    ]) {
      if (collapsed(await inputValue(testId, field)) !== '') return false
    }
    return true
  }

  /**
   * Every transaction starts on an empty sell form, and a half-filled form from an earlier attempt
   * is abandoned, never saved. A host that can open a fresh tab per draft (`tab.openFresh`, Codex:
   * `openFreshTab`) gets one, and the old tab is released unsaved. Otherwise the tab navigates; if a
   * dirty form makes the browser abort that navigation (Vinted's leave-page guard surfaces as
   * net::ERR_ABORTED), the transaction stops unless the tab nevertheless shows an empty form.
   */
  async function openFreshForm() {
    try {
      if (typeof tab.openFresh === 'function') await tab.openFresh(profile.entryUrl)
      else await tab.goto(profile.entryUrl)
    } catch (error) {
      let onForm = false
      try {
        onForm = new URL(await tab.url()).pathname === new URL(profile.entryUrl).pathname
      } catch {}
      if (!onForm || refCount(await driver.locate(inputQuery(controls.title))) !== 1 || !(await formIsPristine())) {
        throw error
      }
    }
    await checkpoint()
    await waitForOne(inputQuery(controls.title), 'title', 'title field')
    if (!(await formIsPristine())) {
      throw capabilityError(
        'vinted_form_not_fresh',
        'The sell form still holds an earlier attempt; it is never saved or reused'
      )
    }
    await beforeAuthenticatedWrite()
  }

  async function openPage(url) {
    if (typeof tab.openFresh === 'function') await tab.openFresh(url)
    else await tab.goto(url)
  }

  /**
   * The wardrobe's cards once they have settled: the draft filter (`closet-seller-filters-draft`)
   * marks the page as rendered, and the same set of cards is read three times running.
   */
  async function wardrobeCards() {
    await appearsWithinOrNull(byTestId('closet-seller-filters-draft'))
    let previous = null
    let stableReads = 0
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
      const links = await driver.locate(byCss(profile.wardrobe.cardLinkSelector))
      const ids = []
      const linkTitles = new Map()
      for (let index = 0; index < refCount(links); index += 1) {
        const element = refElement(links, index)
        const id = profile.wardrobe.cardLinkTestId.exec(element.testId ?? '')?.[1]
        if (id !== undefined) {
          ids.push(id)
          linkTitles.set(id, element.title)
        }
      }
      const signature = JSON.stringify(ids)
      stableReads = signature === previous ? stableReads + 1 : 1
      previous = signature
      if (stableReads >= STABLE_READS) {
        const cards = []
        for (const id of ids) {
          const read = async (testId) => {
            const located = await driver.locate(byTestId(testId))
            return refCount(located) === 1 ? collapsed(refElement(located).name) : null
          }
          // The card's own "title" line is a view count on the owner's wardrobe (run 12); the
          // listing summary lives in the overlay link's title attribute, else the card image's alt.
          let summary = linkTitles.get(id)
          if (typeof summary !== 'string' || summary === '') {
            const images = await driver.locate(byCss(profile.wardrobe.cardImageSelector(id)))
            summary = refCount(images) > 0 ? refElement(images, 0).alt : undefined
          }
          cards.push({
            id,
            status: await read(profile.wardrobe.status(id)),
            summary: typeof summary === 'string' ? collapsed(summary) : null,
          })
        }
        return cards
      }
      if (pollMs > 0) await delay(pollMs)
    }
    throw capabilityError('vinted_wardrobe_unsettled', 'The Vinted wardrobe did not settle to one set of cards')
  }

  /**
   * Draft cards that are this listing's, read from the summary Vinted writes for each card:
   * `${title}, brand: ${brand}, condition: …, size: …, $price` (captured live, run 12). The title
   * may itself contain commas, so the card must start with the exact title followed by ", brand: "
   * — or by ", condition: " for a draft with no brand, a shape assumed rather than seen live (no
   * brandless draft has been captured). When the brand label this transaction picked is known, that
   * brand must follow, compared by `brandKey` (accents and case aside).
   */
  function draftsTitled(cards, title, brandLabel = null) {
    const prefix = `${collapsed(title)}, `
    const brandPart = profile.wardrobe.summaryBrandSeparator.slice(2)
    return cards.filter((card) => {
      if (card.status !== profile.wardrobe.draftStatus || typeof card.summary !== 'string') return false
      if (!card.summary.startsWith(prefix)) return false
      const rest = card.summary.slice(prefix.length)
      if (rest.startsWith(brandPart)) {
        return brandLabel === null || brandKey(rest.slice(brandPart.length)).startsWith(`${brandKey(brandLabel)},`)
      }
      return brandLabel === null && rest.startsWith(profile.wardrobe.summaryConditionPart)
    })
  }

  /**
   * Before anything is written: a draft in the wardrobe with exactly this title may already be this
   * listing (a run that saved it but never recorded it). It is reported, never duplicated.
   */
  async function refuseExistingDraft(prepared) {
    if (memberId === null) {
      throw capabilityError(
        'vinted_member_id_required',
        "The seller's Vinted member id (the number in their wardrobe URL /member/{id}) is needed to " +
          'check for an existing draft before creating one',
        { blocking: true }
      )
    }
    await openPage(vintedWardrobeUrl(memberId, profile))
    await checkpoint()
    const existing = draftsTitled(await wardrobeCards(), prepared.title)
    if (existing.length > 0) {
      const candidates = existing.map((card) => vintedDraftEditUrl(card.id, profile))
      throw capabilityError(
        'vinted_draft_already_exists',
        `A Vinted draft with this exact title already exists: ${candidates.join(', ')}`,
        { candidates }
      )
    }
  }

  /** After Save draft: the landing must be this seller's wardrobe holding exactly one such draft. */
  /** Any alert or error text the form shows, for a save that never left it. */
  async function visibleFormMessages() {
    const texts = []
    for (const role of ['alert', 'status']) {
      const located = await driver.locate(byRole(role))
      for (let index = 0; index < refCount(located); index += 1) {
        const text = collapsed(refElement(located, index).name)
        if (text !== '') texts.push(text)
      }
    }
    return texts.slice(0, 3)
  }

  function pendingSave(message) {
    return capabilityError('vinted_save_unconfirmed', message, { pendingConfirmation: true })
  }

  /** Waits, within this call's budget, for Save draft to reach the seller's wardrobe. */
  async function awaitWardrobeLanding() {
    const deadline = Date.now() + saveConfirmationMs
    for (;;) {
      const url = await tab.url()
      const landed = vintedWardrobeMemberId(url, profile)
      if (landed !== null) {
        if (memberId !== null && landed !== memberId) {
          throw capabilityError('vinted_draft_identity_unconfirmed', "Save draft landed on another member's wardrobe")
        }
        memberId = landed
        return
      }
      if (new URL(url).pathname.startsWith(profile.verificationPathPrefix)) await checkpoint()
      if (Date.now() >= deadline) break
      await delay(Math.max(pollMs, 50))
    }
    const messages = await visibleFormMessages()
    throw pendingSave(
      `Save draft was pressed; Vinted had not reached the wardrobe after ${Math.round(saveConfirmationMs / 1000)} s` +
        (messages.length > 0 ? `; the form shows: ${messages.join(' | ')}` : '')
    )
  }

  /**
   * The one Draft card that is this listing's. A wardrobe that has landed but not yet listed the
   * new draft is reloaded a few times; still nothing is a pending confirmation, never a re-save.
   * Several matches is ambiguous.
   */
  async function findSavedDraft(prepared, brandLabel) {
    for (let reload = 0; reload < 3; reload += 1) {
      if (reload > 0) {
        await openPage(vintedWardrobeUrl(memberId, profile))
        await checkpoint()
      }
      const matches = draftsTitled(await wardrobeCards(), prepared.title, brandLabel)
      const candidates = matches.map((card) => vintedDraftEditUrl(card.id, profile))
      if (matches.length === 1) return { external_identity: matches[0].id, canonical_url: candidates[0] }
      if (matches.length > 1) {
        throw capabilityError(
          'vinted_draft_identity_unconfirmed',
          `The wardrobe shows ${matches.length} drafts with this exact title: ${candidates.join(', ')}`,
          { candidates }
        )
      }
    }
    throw pendingSave('The wardrobe does not list the new draft yet')
  }

  function brandLabelOf(values) {
    return typeof values.brand === 'string' && values.brand !== profile.wardrobe.noBrandLabel ? values.brand : null
  }

  /** Re-reads every field this transaction set, from the saved draft's own edit page. */
  async function readPersisted(externalIdentity) {
    await openPage(vintedDraftEditUrl(externalIdentity, profile))
    await checkpoint()
    await waitForOne(inputQuery(controls.title), 'title', 'title field')
    const persisted = {
      external_identity: externalIdentity,
      is_draft: refCount(await driver.locate(byTestId(profile.draftEdit.deleteDraftTestId))) === 1,
      title: await inputValue(controls.title, 'title'),
      description: await inputValue(controls.description, 'description'),
      price: normalizedPrice(await inputValue(controls.price, 'price')),
      category: collapsed(await inputValue(controls.category, 'category')),
    }
    const mismatches = []
    const singles = { brand: controls.brand, size: controls.size, condition: controls.condition }
    for (const [field, value] of Object.entries(expected)) {
      let ok = true
      if (field in singles) ok = collapsed(await inputValue(singles[field], field)) === value
      else if (field === 'color' || field === 'material') {
        const testId = field === 'color' ? controls.color : controls.material
        ok = JSON.stringify(shownLabels(await inputValue(testId, field))) === JSON.stringify(value)
      } else if (field === 'package_size') {
        const { members } = await optionFamily('radio', optionPatterns.packageSize)
        const checked = members.filter(({ element }) => element.checked === true).map(({ element }) => element.id)
        ok = checked.length === 1 && checked[0] === value
      } else if (field === 'photo_count') {
        ok = refCount(await driver.locate(byCss(profile.draftEdit.photoDeleteSelector))) === value
      } else {
        ok = collapsed(await inputValue(optionIds.listInput(field), field)) === value
      }
      if (!ok) mismatches.push(field)
    }
    persisted.field_mismatches = mismatches
    return persisted
  }

  return Object.freeze({
    async savePreparedDraft({ prepared }) {
      metrics.startedAt = Date.now()
      metrics.completedAt = null
      metrics.verifiedAt = null
      metrics.steps = 0
      for (const name of Object.keys(metrics.phases)) delete metrics.phases[name]
      let externalWriteAttempted = false
      try {
        stage = 'check_existing_draft'
        notes = {}
        finalChecks = []
        expected = {}
        await measure('existing_draft_check_ms', () => refuseExistingDraft(prepared))
        stage = 'open_create_form'
        await measure('create_readiness_ms', () => openFreshForm())
        await populate(prepared)

        stage = 'save_draft'
        await closeAllDropdowns('save_draft')
        const save = await saveDraftControl()
        externalWriteAttempted = true
        pendingExpectations.set(prepared.foldListingId, { ...expected })
        try {
          await measure('save_ms', () => driver.clickAndWaitForNavigation(save))
        } catch {
          // Vinted's post-save navigation can outlast the driver's wait; the landing wait decides.
        }

        stage = 'await_save_landing'
        await measure('landing_ms', () => awaitWardrobeLanding())
        stage = 'resolve_draft_identity'
        await checkpoint()
        const identity = await measure('identity_ms', () => findSavedDraft(prepared, brandLabelOf(expected)))
        pendingExpectations.delete(prepared.foldListingId)
        metrics.completedAt = Date.now()
        return { outcome: 'saved', status: 'draft', ...identity, notes: { ...notes } }
      } catch (thrown) {
        // A host may throw a string or a frozen object; either way the stage and cause must survive.
        let error = thrown
        if (error === null || typeof error !== 'object' || !Object.isExtensible(error)) {
          error = new Error(withDetail('The browser host failed', thrown))
          if (typeof thrown?.code === 'string') error.code = thrown.code
        }
        error.stage = stage
        error.externalWriteAttempted = externalWriteAttempted
        error.notes = { ...notes }
        // What was entered, for whichever call (possibly a new capability) confirms this save.
        if (error.pendingConfirmation === true) error.expectedFields = { ...expected }
        throw error
      }
    },

    async readDraft({ external_identity: externalIdentity } = {}) {
      const persisted = await measure('persisted_verification_ms', () => readPersisted(externalIdentity))
      metrics.verifiedAt = Date.now()
      return persisted
    },

    /**
     * Finishes a save an earlier call could not confirm: reads the wardrobe for the draft — never
     * presses Save draft — and restores what that transaction entered, so verification is as full
     * as it would have been.
     */
    async confirmSavedDraft({ prepared, expectedFields }) {
      stage = 'confirm_saved_draft'
      try {
        if (memberId === null) throw capabilityError('vinted_member_id_required', 'The seller member id is needed', { blocking: true })
        // The report carries the entered values across calls and REPL resets; this instance's own
        // memory is only a fallback. Without either, verification reads title, description, price
        // and category alone.
        expected = { ...(expectedFields ?? pendingExpectations.get(prepared.foldListingId) ?? {}) }
        await openPage(vintedWardrobeUrl(memberId, profile))
        await checkpoint()
        const identity = await findSavedDraft(prepared, brandLabelOf(expected))
        pendingExpectations.delete(prepared.foldListingId)
        return { outcome: 'saved', status: 'draft', ...identity, notes: {} }
      } catch (error) {
        if (error !== null && typeof error === 'object' && Object.isExtensible(error)) {
          error.stage = stage
          error.externalWriteAttempted = true
        }
        throw error
      }
    },

    /** The seller's member id, supplied or learned from a landing; null until known. */
    memberId() {
      return memberId
    },

    metrics() {
      const since = (end) => (metrics.startedAt === null || end === null ? null : end - metrics.startedAt)
      return Object.freeze({
        elapsed_ms: since(metrics.completedAt),
        fully_verified_ms: since(metrics.verifiedAt),
        phase_ms: Object.freeze({ ...metrics.phases }),
        interaction_delay_ms: interactionDelayMs,
        visible_steps: metrics.steps,
      })
    },
  })
}
