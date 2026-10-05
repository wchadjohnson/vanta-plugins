import { byCss, byRole, byTestId, refAt, refCount, refElement, requireBrowserDriver } from '../shared/browser-driver.mjs'
import { withDetail } from '../shared/error-detail.mjs'
import { depopDeleteDraftUrl } from './profile.mjs'

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

function samePath(a, b) {
  const trim = (value) => (value.endsWith('/') ? value.slice(0, -1) : value)
  return trim(a) === trim(b)
}

/**
 * Deletes one drafted Depop sibling — after a sale or the seller's Delist all — at the exact draft
 * URL Fold recorded. Kept apart from both the draft path and the path that makes drafts live: it presses only the draft's
 * "Delete" (`data-testid="buttonLink"`) and then "Delete draft" inside Depop's "Delete draft"
 * dialog, matched by test id and exact text, and refuses Post, Update draft, Close and Cancel.
 *
 * - The recorded URL must be exactly `https://www.depop.com/sellinghub/drafts/edit/{uuid}/`.
 * - The page must be that draft (heading "Draft") and its SKU field must equal Fold's SKU exactly.
 *   Depop's "There was a problem getting the draft details" page is `already_deleted`.
 * - Each control is pressed at most once per draft; the result is proven by the page leaving the
 *   edit URL and the edit URL then showing Depop's missing-draft page.
 *
 * - A gone draft looks exactly like a posted (consumed) one, so it is confirmed `already_deleted`
 *   only when Active/Selling does not list its SKU; listed there it is `went_live`.
 *
 * `deleteDraft()` never throws for a listing outcome: `deleted`, `already_deleted`, `went_live`,
 * `mismatch` (nothing clicked), `unconfirmed` (a control was pressed, deletion not proven, nothing
 * pressed again), `error` (nothing clicked).
 */
export function createDepopDraftDeleteCapability(options = {}) {
  const tab = requiredObject(options.tab, 'tab')
  const profile = requiredObject(options.profile, 'profile')
  if (profile.kind !== 'depop' || !profile.draftDelete) throw new TypeError('profile must be the authenticated Depop profile')
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

  async function onPath(path) {
    const url = new URL(await tab.url())
    return url.origin === profile.origin && samePath(url.pathname, path)
  }

  async function goneShown() {
    const nodes = await driver.locate(byCss(draftDelete.goneTextSelector))
    for (let index = 0; index < refCount(nodes); index += 1) {
      if (collapsed(refElement(nodes, index).name) === draftDelete.goneText) return true
    }
    return false
  }

  /** 'draft', 'gone', or null while the edit page shows neither. */
  async function pageState(path) {
    if (!(await onPath(path))) return null
    if (await goneShown()) return 'gone'
    const draft =
      (await count(byRole(draftDelete.draftHeading.role, draftDelete.draftHeading.name))) === 1 &&
      (await count(byRole(profile.fields.sku.role, profile.fields.sku.label))) === 1 &&
      (await count(byTestId(draftDelete.deleteControl.testId))) === 1
    return draft ? 'draft' : null
  }

  /**
   * The only click site in this capability: one of exactly two controls — the draft's Delete or
   * the dialog's "Delete draft" — each by exact test id or name, each at most once per draft.
   */
  async function pressExact(key, located, expectedName, attempt) {
    if (pressed.has(key)) throw deleteError('depop_draft_delete_already_pressed', 'That control was already pressed for this draft')
    if (refCount(located) !== 1) {
      throw deleteError('depop_draft_delete_control_missing', `Expected one "${expectedName}" control, found ${refCount(located)}`)
    }
    const name = collapsed(refElement(located).name)
    if (name !== expectedName || draftDelete.neverClick.includes(name)) {
      throw deleteError('depop_draft_delete_control_mismatch', `The located control reads "${name.slice(0, 60)}", not "${expectedName}"`)
    }
    pressed.add(key)
    attempt.clicked = true
    await driver.click(refAt(located, 0))
  }

  /**
   * Whether Active/Selling lists exactly this SKU: 'listed', 'absent', or 'unknown' when the page
   * neither showed rows nor Depop's own empty state. A posted draft is consumed and its edit URL
   * then reads exactly like a deleted one, so a gone draft is only confirmed once this is 'absent'.
   * Read-only: nothing on Active/Selling is ever clicked from here.
   */
  async function activeListing(sku) {
    await tab.goto(profile.delist.url)
    const seen = await waitUntil(async () => {
      if (!(await onPath(profile.delist.path))) return null
      const nodes = await driver.locate(byCss(profile.delist.rowSkuSelector))
      if (refCount(nodes) > 0) {
        for (let index = 0; index < refCount(nodes); index += 1) {
          const element = refElement(nodes, index)
          if (collapsed(element.name ?? element.value).replace(/^SKU:\s*/i, '') === sku) return 'listed'
        }
        return 'absent'
      }
      const empty = await driver.locate(byCss(profile.delist.emptyState.selector))
      for (let index = 0; index < refCount(empty); index += 1) {
        if (collapsed(refElement(empty, index).name) === profile.delist.emptyState.text) return 'absent'
      }
      return null
    })
    return seen ?? 'unknown'
  }

  /** A gone draft becomes already_deleted only when its SKU is not live on Active/Selling. */
  async function goneOutcome(base, sku) {
    const active = await activeListing(sku)
    if (active === 'listed') {
      return {
        ...base,
        outcome: 'went_live',
        message: 'This draft was posted: its SKU is live on Active/Selling, so it is not confirmed gone.',
      }
    }
    if (active === 'unknown') {
      return {
        ...base,
        outcome: 'error',
        failure_code: 'depop_draft_delete_active_unreadable',
        message: 'The draft is gone but Active/Selling could not be read to rule out that it was posted; left open.',
      }
    }
    return { ...base, outcome: 'already_deleted', message: 'The Depop draft was already deleted and its SKU is not live; nothing was clicked.' }
  }

  async function deleteOnce({ listing_id: listingId, sku, draft_url: draftUrl, reconcileOnly = false } = {}, attempt) {
    const base = { listing_id: listingId, sku: sku ?? null, draft_url: draftUrl ?? null }
    const draft = depopDeleteDraftUrl(draftUrl, profile)
    if (draft === null) {
      return {
        ...base,
        outcome: 'mismatch',
        failure_code: 'depop_draft_delete_url_refused',
        message: 'Fold recorded no Depop draft edit URL for this listing, so nothing was opened or clicked.',
      }
    }
    if (typeof sku !== 'string' || sku.trim() === '') {
      return {
        ...base,
        outcome: 'mismatch',
        failure_code: 'depop_draft_delete_sku_missing',
        message: "Fold gave no SKU to confirm the draft's identity, so nothing was opened or clicked.",
      }
    }
    const path = new URL(draft).pathname
    try {
      await tab.goto(draft)
      const state = await waitUntil(() => pageState(path))
      if (state === 'gone') return await goneOutcome(base, sku)
      if (state !== 'draft') {
        return {
          ...base,
          outcome: 'mismatch',
          failure_code: 'depop_draft_delete_page_unrecognized',
          message: "The draft page showed neither the draft nor Depop's missing-draft page, so nothing was clicked.",
        }
      }
      const field = await driver.locate(byRole(profile.fields.sku.role, profile.fields.sku.label))
      if (String(refElement(field).value ?? '') !== sku) {
        return {
          ...base,
          outcome: 'mismatch',
          failure_code: 'depop_draft_delete_sku_mismatch',
          message: "The draft's SKU does not match Fold's, so nothing was clicked.",
        }
      }
      if (reconcileOnly) {
        return {
          ...base,
          outcome: 'unconfirmed',
          failure_code: 'depop_draft_delete_previously_pressed',
          message: 'A delete was pressed in an earlier call and the draft is still there; nothing will be pressed again. Delete it on Depop by hand.',
        }
      }

      await pressExact(`${path}:delete`, await driver.locate(byTestId(draftDelete.deleteControl.testId)), draftDelete.deleteControl.name, attempt)
      const dialog = await waitUntil(async () => (await count(byRole(draftDelete.dialog.role, draftDelete.dialog.name))) === 1)
      if (!dialog) {
        return {
          ...base,
          outcome: 'unconfirmed',
          failure_code: 'depop_draft_delete_dialog_missing',
          message: 'Delete was pressed once but Depop showed no "Delete draft" dialog; nothing was pressed again. Check the draft on Depop.',
        }
      }
      await pressExact(`${path}:confirm`, await driver.locate(byRole(draftDelete.confirmAction.role, draftDelete.confirmAction.name)), draftDelete.confirmAction.name, attempt)
      const left = await waitUntil(async () => !(await onPath(path)))
      if (!left) {
        return {
          ...base,
          outcome: 'unconfirmed',
          failure_code: 'depop_draft_delete_no_navigation',
          message: '"Delete draft" was pressed once but Depop stayed on the draft; nothing was pressed again.',
        }
      }
      await tab.goto(draft)
      if ((await waitUntil(() => pageState(path))) !== 'gone') {
        return {
          ...base,
          outcome: 'unconfirmed',
          failure_code: 'depop_draft_delete_unverified',
          message: "\"Delete draft\" was pressed once but the draft's page does not show it deleted; nothing was pressed again.",
        }
      }
      // The gone page also follows a post made elsewhere meanwhile: deleted only once the SKU is
      // proven absent from Active/Selling (read-only).
      const active = await activeListing(sku)
      if (active === 'listed') {
        return {
          ...base,
          outcome: 'went_live',
          message: 'The draft is gone but its SKU is live on Active/Selling: it was posted, not deleted. Nothing was pressed again.',
        }
      }
      if (active === 'unknown') {
        return {
          ...base,
          outcome: 'unconfirmed',
          failure_code: 'depop_draft_delete_active_unreadable',
          message: 'The draft is gone but Active/Selling could not be read to rule out a post; left open, nothing pressed again.',
        }
      }
      return { ...base, outcome: 'deleted', message: 'Draft deleted on Depop.' }
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'depop_draft_delete_browser_failed'
      if (attempt.clicked) {
        return {
          ...base,
          outcome: 'unconfirmed',
          failure_code: code,
          message: withDetail('A delete control was pressed but the result could not be read; nothing was pressed again', error),
        }
      }
      const refused = ['depop_draft_delete_control_missing', 'depop_draft_delete_control_mismatch'].includes(code)
      return { ...base, outcome: refused ? 'mismatch' : 'error', failure_code: code, message: withDetail('Nothing was clicked', error) }
    }
  }

  return Object.freeze({
    /**
     * `reconcileOnly: true` (pressed in an earlier call) never presses: it only reads whether the
     * draft is gone. `pressed` says whether this call pressed anything.
     */
    async deleteDraft(args = {}) {
      const attempt = { clicked: false }
      const result = await deleteOnce(args, attempt)
      return { ...result, pressed: attempt.clicked }
    },

    /** Read-only Active/Selling lookup for a SKU: 'listed' | 'absent' | 'unknown'. */
    activeListing,
  })
}
