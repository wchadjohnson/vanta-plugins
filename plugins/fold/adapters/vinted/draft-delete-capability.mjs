import { byCss, byTestId, refCount, refElement, requireBrowserDriver } from '../shared/browser-driver.mjs'
import { withDetail } from '../shared/error-detail.mjs'
import { vintedDeleteDraftId, vintedDraftEditUrl } from './profile.mjs'

const POLL_MS = 250
const POLL_ATTEMPTS = 40

function requiredObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`)
  }
  return value
}

function collapsed(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function deleteError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function nonNegativeInteger(value, fallback, name) {
  const resolved = value ?? fallback
  if (!Number.isInteger(resolved) || resolved < 0) throw new TypeError(`${name} must be a non-negative integer`)
  return resolved
}

/**
 * Deletes one drafted Vinted sibling — after a sale or the seller's Delist all — at the exact draft
 * URL Fold recorded. Kept apart from both the draft path and the path that makes drafts live: it presses only "Delete
 * draft", by test id, and refuses Upload and Save draft by test id.
 *
 * - The recorded URL must be exactly `https://www.vinted.com/items/{id}/edit`; anything else is
 *   refused before the browser moves.
 * - The page must be that edit page with the draft upload form (Save draft and Delete draft each
 *   present once). Vinted's "Sorry, something went wrong" page with no form is `already_deleted`.
 * - Delete draft has no confirmation, so it is pressed at most once per draft; the result is then
 *   proven by the page leaving the edit URL and the edit URL showing the deleted page.
 *
 * - Before anything is pressed, and before a gone draft is confirmed, `/items/{id}` must NOT resolve
 *   to a live public page: a posted draft is `went_live` (nothing clicked), never deleted as a draft.
 *
 * `deleteDraft()` never throws for a listing outcome: `deleted`, `already_deleted`, `went_live`,
 * `mismatch` (nothing clicked), `unconfirmed` (pressed once, not proven, never pressed again),
 * `error` (nothing clicked).
 */
export function createVintedDraftDeleteCapability(options = {}) {
  const tab = requiredObject(options.tab, 'tab')
  const profile = requiredObject(options.profile, 'profile')
  if (profile.kind !== 'vinted' || !profile.draftDelete) throw new TypeError('profile must be a Vinted target profile')
  const driver = requireBrowserDriver(tab.driver, 'tab.driver')
  for (const method of ['goto', 'url']) {
    if (typeof tab[method] !== 'function') throw new TypeError(`tab.${method} must be a function`)
  }
  const pollMs = nonNegativeInteger(options.pollMs, POLL_MS, 'pollMs')
  const pollAttempts = nonNegativeInteger(options.pollAttempts, POLL_ATTEMPTS, 'pollAttempts')
  const { draftDelete } = profile
  const pressed = new Set()

  async function waitUntil(predicate) {
    for (let attempt = 0; attempt <= pollAttempts; attempt += 1) {
      const value = await predicate()
      if (value) return value
      if (attempt < pollAttempts && pollMs > 0) await delay(pollMs)
    }
    return null
  }

  async function count(query) {
    return refCount(await driver.locate(query))
  }

  async function onEditPath(id) {
    const url = new URL(await tab.url())
    return url.origin === profile.origin && draftDelete.draftPathPattern.exec(url.pathname)?.[1] === id
  }

  async function formCount() {
    let total = 0
    for (const testId of draftDelete.formTestIds) total += await count(byTestId(testId))
    return total
  }

  async function goneShown() {
    const nodes = await driver.locate(byCss(draftDelete.goneTextSelector))
    for (let index = 0; index < refCount(nodes); index += 1) {
      if (collapsed(refElement(nodes, index).name) === draftDelete.goneText) return true
    }
    return false
  }

  /** What item `id`'s edit page shows: 'draft', 'gone', or null while neither is rendered. */
  async function pageState(id) {
    if (!(await onEditPath(id))) return 'elsewhere'
    let draft = true
    for (const testId of draftDelete.formTestIds) {
      if ((await count(byTestId(testId))) !== 1) draft = false
    }
    if (draft) return 'draft'
    if ((await formCount()) === 0 && (await goneShown())) return 'gone'
    if ((await formCount()) === 0) {
      const save = await driver.locate(byTestId(draftDelete.liveEditForm.testId))
      if (refCount(save) === 1 && collapsed(refElement(save).name) === draftDelete.liveEditForm.name) return 'live_form'
    }
    return null
  }

  /** The only click this capability makes: Delete draft, by test id, on item `id`'s edit page, once. */
  async function pressDeleteDraft(id, attempt) {
    if (pressed.has(id)) throw deleteError('vinted_draft_delete_already_pressed', `Delete draft was already pressed for item ${id}`)
    if (!(await onEditPath(id))) throw deleteError('vinted_draft_delete_page_mismatch', `The open page is not item ${id}'s draft`)
    const located = await driver.locate(byTestId(draftDelete.deleteControl.testId))
    if (refCount(located) !== 1) {
      throw deleteError('vinted_draft_delete_control_missing', `Expected one Delete draft control, found ${refCount(located)}`)
    }
    const element = refElement(located)
    if (element.testId !== draftDelete.deleteControl.testId || draftDelete.neverClick.includes(element.testId)) {
      throw deleteError('vinted_draft_delete_control_mismatch', 'The located control is not Delete draft')
    }
    pressed.add(id)
    attempt.clicked = true
    await driver.click(located)
  }

  /** The canonical public URL when item `id`'s own page shows it live to its owner, else null. */
  async function liveAt(id) {
    await tab.goto(new URL(draftDelete.itemPath(id), profile.origin).toString())
    const publicPath = draftDelete.publicPathPattern(id)
    const found = await waitUntil(async () => {
      const url = new URL(await tab.url())
      if (url.origin !== profile.origin || !publicPath.test(url.pathname)) return null
      if ((await count(byTestId(draftDelete.liveMarkerTestId))) !== 1) return null
      return new URL(url.pathname, profile.origin).toString()
    })
    return found ?? null
  }

  async function editPageState(editUrl, id) {
    await tab.goto(editUrl)
    return await waitUntil(async () => {
      const value = await pageState(id)
      return value === 'draft' || value === 'gone' || value === 'live_form' ? value : null
    })
  }

  async function deleteOnce({ listing_id: listingId, draft_url: draftUrl, reconcileOnly = false } = {}, attempt) {
    const base = { listing_id: listingId, draft_url: draftUrl ?? null }
    const id = vintedDeleteDraftId(draftUrl, profile)
    if (id === null) {
      return {
        ...base,
        outcome: 'mismatch',
        failure_code: 'vinted_draft_delete_url_refused',
        message: 'Fold recorded no Vinted draft edit URL for this listing, so nothing was opened or clicked.',
      }
    }
    const editUrl = vintedDraftEditUrl(id, profile)
    try {
      // A posted draft is not a draft any more: never delete-as-draft, never confirm it gone.
      const publicUrl = await liveAt(id)
      if (publicUrl !== null) {
        return {
          ...base,
          outcome: 'went_live',
          public_url: publicUrl,
          message: 'This copy is live on Vinted, not a draft; nothing was clicked here.',
        }
      }
      const state = await editPageState(editUrl, id)
      if (state === 'live_form') {
        return {
          ...base,
          outcome: 'went_live',
          public_url: null,
          message: "Item's edit page shows a live listing's form (Save, no draft controls); it is not a draft, so nothing was clicked here.",
        }
      }
      if (state === 'gone') {
        return { ...base, outcome: 'already_deleted', message: 'The Vinted draft was already deleted and the item is not live; nothing was clicked.' }
      }
      if (state !== 'draft') {
        return {
          ...base,
          outcome: 'mismatch',
          failure_code: 'vinted_draft_delete_page_unrecognized',
          message: `Item ${id}'s edit page showed neither the draft form nor Vinted's deleted page, so nothing was clicked.`,
        }
      }
      if (reconcileOnly) {
        return {
          ...base,
          outcome: 'unconfirmed',
          failure_code: 'vinted_draft_delete_previously_pressed',
          message: 'Delete draft was pressed in an earlier call and the draft is still there; it will not be pressed again. Delete it on Vinted by hand.',
        }
      }

      await pressDeleteDraft(id, attempt)
      const left = await waitUntil(async () => !(await onEditPath(id)))
      if (!left) {
        return {
          ...base,
          outcome: 'unconfirmed',
          failure_code: 'vinted_draft_delete_no_navigation',
          message: 'Delete draft was pressed once but Vinted stayed on the draft; it was not pressed again. Check the draft on Vinted.',
        }
      }
      if ((await editPageState(editUrl, id)) !== 'gone') {
        return {
          ...base,
          outcome: 'unconfirmed',
          failure_code: 'vinted_draft_delete_unverified',
          message: "Delete draft was pressed once but the draft's page does not show it deleted; it was not pressed again.",
        }
      }
      // The gone page also follows a post made elsewhere meanwhile: re-check the item's own page.
      const postedUrl = await liveAt(id)
      if (postedUrl !== null) {
        return {
          ...base,
          outcome: 'went_live',
          public_url: postedUrl,
          message: 'The draft is gone but the item is live on Vinted: it was posted, not deleted. Nothing was pressed again.',
        }
      }
      return { ...base, outcome: 'deleted', message: 'Draft deleted on Vinted.' }
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'vinted_draft_delete_browser_failed'
      if (attempt.clicked) {
        return {
          ...base,
          outcome: 'unconfirmed',
          failure_code: code,
          message: withDetail('Delete draft may have been pressed but its result could not be read; it was not pressed again', error),
        }
      }
      const refused = ['vinted_draft_delete_page_mismatch', 'vinted_draft_delete_control_missing', 'vinted_draft_delete_control_mismatch'].includes(code)
      return { ...base, outcome: refused ? 'mismatch' : 'error', failure_code: code, message: withDetail('Nothing was clicked', error) }
    }
  }

  return Object.freeze({
    /**
     * `reconcileOnly: true` (pressed in an earlier call) never presses: it only reads whether the
     * draft is gone. `pressed` says whether this call pressed Delete draft.
     */
    async deleteDraft(args = {}) {
      const attempt = { clicked: false }
      const result = await deleteOnce(args, attempt)
      return { ...result, pressed: attempt.clicked }
    },
  })
}
