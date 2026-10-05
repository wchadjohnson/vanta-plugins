import { byTestId, refCount, refElement, requireBrowserDriver } from '../shared/browser-driver.mjs'
import { withDetail } from '../shared/error-detail.mjs'
import { vintedDraftEditUrl, vintedGoLiveDraftId } from './profile.mjs'

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

function goLiveError(code, message) {
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
 * Takes one Vinted draft live, on the seller's explicit request, from the exact draft URL Fold
 * recorded for it. The one Vinted capability allowed to press Upload — and only there:
 *
 * - The recorded URL must be exactly `https://www.vinted.com/items/{id}/edit` (see
 *   `vintedGoLiveDraftId`); anything else is refused before the browser moves.
 * - The open page must be that same edit page, still a draft (Save draft and Delete draft both
 *   present), with exactly one Upload control whose test id and name are both exact.
 * - Upload is pressed at most once per draft per capability, and never again after an unclear
 *   result: a later run reconciles from the item page without clicking.
 *
 * Success is the item's own page, `/items/{id}` resolving to the canonical `/items/{id}-{slug}`
 * with the owner's live markers. A draft that is already live (an earlier run's click, or the
 * seller posted it) is reconciled the same way with no click at all.
 *
 * `goLive()` never throws for a listing outcome. It returns one of:
 * `live` (with `public_url`), `mismatch` (wrong URL or wrong page; nothing clicked), `unconfirmed`
 * (clicked, but the result could not be proven; never clicked again), `error` (nothing clicked).
 */
export function createVintedGoLiveCapability(options = {}) {
  const tab = requiredObject(options.tab, 'tab')
  const profile = requiredObject(options.profile, 'profile')
  if (profile.kind !== 'vinted' || !profile.goLive) throw new TypeError('profile must be a Vinted target profile')
  const driver = requireBrowserDriver(tab.driver, 'tab.driver')
  for (const method of ['goto', 'url']) {
    if (typeof tab[method] !== 'function') throw new TypeError(`tab.${method} must be a function`)
  }
  const pollMs = nonNegativeInteger(options.pollMs, POLL_MS, 'pollMs')
  const pollAttempts = nonNegativeInteger(options.pollAttempts, POLL_ATTEMPTS, 'pollAttempts')
  const { goLive } = profile
  const pressed = new Set()

  async function waitUntil(predicate) {
    for (let attempt = 0; attempt <= pollAttempts; attempt += 1) {
      if (await predicate()) return true
      if (attempt < pollAttempts && pollMs > 0) await delay(pollMs)
    }
    return false
  }

  async function count(testId) {
    return refCount(await driver.locate(byTestId(testId)))
  }

  async function currentUrl() {
    return new URL(await tab.url())
  }

  async function open(url) {
    if (typeof tab.openFresh === 'function') await tab.openFresh(url)
    else await tab.goto(url)
  }

  /** Whether the open page is item `id`'s draft edit page, its draft controls rendered. */
  async function onDraftPage(id) {
    const url = await currentUrl()
    if (url.origin !== profile.origin || goLive.draftPathPattern.exec(url.pathname)?.[1] !== id) return false
    for (const testId of [goLive.publish.testId, ...goLive.draftOnlyTestIds]) {
      if ((await count(testId)) !== 1) return false
    }
    return true
  }

  /**
   * The narrow go-live allowance: Upload, exactly, on exactly this draft's edit page, once. This is
   * the only place this capability clicks anything.
   */
  async function pressUpload(id, attempt) {
    if (pressed.has(id)) throw goLiveError('vinted_go_live_already_pressed', `Upload was already pressed for item ${id}`)
    const url = await currentUrl()
    if (url.origin !== profile.origin || goLive.draftPathPattern.exec(url.pathname)?.[1] !== id) {
      throw goLiveError('vinted_go_live_page_mismatch', `The open page is ${url.pathname}, not item ${id}'s draft`)
    }
    const located = await driver.locate(byTestId(goLive.publish.testId))
    if (refCount(located) !== 1) {
      throw goLiveError('vinted_go_live_control_missing', `Expected one Upload control, found ${refCount(located)}`)
    }
    const element = refElement(located)
    if (
      element.testId !== goLive.publish.testId ||
      collapsed(element.name) !== goLive.publish.name ||
      goLive.neverClick.includes(element.testId)
    ) {
      throw goLiveError(
        'vinted_go_live_control_mismatch',
        `The ${goLive.publish.testId} control reads "${collapsed(element.name).slice(0, 60)}", not "${goLive.publish.name}"`
      )
    }
    pressed.add(id)
    attempt.clicked = true
    await driver.click(located)
  }

  /** The canonical public URL once item `id`'s own page shows it live to its owner, else null. */
  async function verifyLive(id) {
    await open(new URL(goLive.itemPath(id), profile.origin).toString())
    const publicPath = goLive.publicPathPattern(id)
    let canonical = null
    const live = await waitUntil(async () => {
      const url = await currentUrl()
      if (url.origin !== profile.origin || !publicPath.test(url.pathname)) return false
      for (const testId of goLive.liveMarkerTestIds) {
        if ((await count(testId)) !== 1) return false
      }
      canonical = new URL(url.pathname, profile.origin).toString()
      return true
    })
    return live ? canonical : null
  }

  /** A listing pressed in an earlier call: read-only proof only, never another press. */
  async function reconcileOnce({ listing_id: listingId, draft_url: draftUrl } = {}) {
    const base = { listing_id: listingId, draft_url: draftUrl ?? null }
    const id = vintedGoLiveDraftId(draftUrl, profile)
    if (id === null) {
      return { ...base, outcome: 'mismatch', failure_code: 'vinted_go_live_draft_url_refused', message: 'Fold recorded no Vinted draft edit URL for this listing; nothing was opened.' }
    }
    try {
      const publicUrl = await verifyLive(id)
      if (publicUrl !== null) {
        return { ...base, outcome: 'live', public_url: publicUrl, reconciled: true, message: 'Live on Vinted (Upload was pressed in an earlier call); nothing was pressed now.' }
      }
    } catch (error) {
      return { ...base, outcome: 'unconfirmed', failure_code: 'vinted_go_live_reconcile_failed', message: withDetail('Upload was pressed in an earlier call and its result still cannot be read; it will not be pressed again. Check it on Vinted by hand', error) }
    }
    return {
      ...base,
      outcome: 'unconfirmed',
      failure_code: 'vinted_go_live_previously_pressed',
      message: 'Upload was pressed in an earlier call and the item still is not shown live; it will not be pressed again. Check it on Vinted by hand.',
    }
  }

  async function goLiveOnce({ listing_id: listingId, draft_url: draftUrl } = {}, attempt) {
    const base = { listing_id: listingId, draft_url: draftUrl ?? null }
    const id = vintedGoLiveDraftId(draftUrl, profile)
    if (id === null) {
      return {
        ...base,
        outcome: 'mismatch',
        failure_code: 'vinted_go_live_draft_url_refused',
        message: 'Fold recorded no Vinted draft edit URL for this listing, so nothing was opened or clicked.',
      }
    }
    try {
      await open(vintedDraftEditUrl(id, profile))
      const isDraft = await waitUntil(() => onDraftPage(id))
      if (!isDraft) {
        // Not a draft any more: an earlier run's Upload or the seller may already have posted it.
        // That is settled from the item's own page, read-only.
        const landed = await currentUrl()
        const onEditPage =
          landed.origin === profile.origin && goLive.draftPathPattern.exec(landed.pathname)?.[1] === id
        const publicUrl = await verifyLive(id)
        if (publicUrl !== null) {
          return { ...base, outcome: 'live', public_url: publicUrl, reconciled: true, message: 'Already live on Vinted; nothing was clicked.' }
        }
        return {
          ...base,
          outcome: 'mismatch',
          failure_code: onEditPage ? 'vinted_go_live_not_a_draft' : 'vinted_go_live_draft_missing',
          message: onEditPage
            ? `Item ${id}'s edit page is not a draft with one Upload control, so nothing was clicked.`
            : `Item ${id}'s draft page did not open and the item is not live, so nothing was clicked.`,
        }
      }

      await pressUpload(id, attempt)
      const left = await waitUntil(async () => {
        const url = await currentUrl()
        return !(url.origin === profile.origin && goLive.draftPathPattern.test(url.pathname))
      })
      if (!left) {
        return {
          ...base,
          outcome: 'unconfirmed',
          failure_code: 'vinted_go_live_no_navigation',
          message: 'Upload was pressed once but Vinted stayed on the edit page; it was not pressed again. Check the draft on Vinted.',
        }
      }
      const publicUrl = await verifyLive(id)
      if (publicUrl === null) {
        return {
          ...base,
          outcome: 'unconfirmed',
          failure_code: 'vinted_go_live_unverified',
          message: "Upload was pressed once but the item's public page did not show it live; it was not pressed again.",
        }
      }
      return { ...base, outcome: 'live', public_url: publicUrl, message: 'Live on Vinted.' }
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'vinted_go_live_browser_failed'
      if (attempt.clicked) {
        return {
          ...base,
          outcome: 'unconfirmed',
          failure_code: code,
          message: withDetail('Upload may have been pressed but its result could not be read; it was not pressed again', error),
        }
      }
      const refused = ['vinted_go_live_page_mismatch', 'vinted_go_live_control_missing', 'vinted_go_live_control_mismatch'].includes(code)
      return {
        ...base,
        outcome: refused ? 'mismatch' : 'error',
        failure_code: code,
        message: withDetail('Nothing was clicked', error),
      }
    }
  }

  return Object.freeze({
    /**
     * `reconcileOnly: true` (a listing pressed in an earlier call) never presses anything: it only
     * looks for read-only proof that the item is live. `pressed` says whether this call pressed.
     */
    async goLive(args = {}) {
      const attempt = { clicked: false }
      const result = args.reconcileOnly === true ? await reconcileOnce(args) : await goLiveOnce(args, attempt)
      return { ...result, pressed: attempt.clicked }
    },
  })
}
