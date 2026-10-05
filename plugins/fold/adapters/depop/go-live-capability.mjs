import { byCss, byRole, refAt, refCount, refElement, requireBrowserDriver } from '../shared/browser-driver.mjs'
import { withDetail } from '../shared/error-detail.mjs'
import { depopGoLiveDraftUrl, depopPublicProductUrl } from './profile.mjs'

const POLL_MS = 250
const POLL_ATTEMPTS = 40
const ACTIVE_READS = 4
const MANAGE_PATH = /^\/products\/[^/]+\/manage\/?$/

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

/** Active/Selling renders `SKU: <value>`; drafts render the bare value. Only a leading label goes. */
function stripSkuLabel(value) {
  return collapsed(value).replace(/^SKU:\s*/i, '')
}

function samePath(a, b) {
  const trim = (value) => (value.endsWith('/') ? value.slice(0, -1) : value)
  return trim(a) === trim(b)
}

/**
 * Takes one Depop draft live, on the seller's explicit request, from the exact draft URL Fold
 * recorded for it. The one Depop capability allowed to press Post — and only there:
 *
 * - The recorded URL must be exactly `https://www.depop.com/sellinghub/drafts/edit/{uuid}/` (see
 *   `depopGoLiveDraftUrl`); anything else is refused before the browser moves.
 * - The open page must be that same edit page (heading "Draft"), its SKU field must equal Fold's
 *   SKU exactly, and exactly one button must be named "Post" — cross-checked among the submit
 *   buttons, because Depop's "Delete" is a submit button too and must never be pressed.
 * - Post is pressed at most once per draft per capability, and never again after an unclear
 *   result: a later run reconciles through Active/Selling by SKU without clicking.
 *
 * Success is the listing found on Active/Selling under its exact SKU, its public page resolving at
 * `/products/{slug}/` (or the owner's `/manage/`), and the normalised `/products/{slug}/` returned
 * for `mark_live`. The success page's "View listing" link names the slug when present; the
 * Active/Selling row is the fallback and the proof either way.
 *
 * `goLive()` never throws for a listing outcome. It returns one of: `live` (with `public_url`),
 * `incomplete` (Depop's own validation blocked Post; nothing posted), `mismatch` (wrong URL, wrong
 * page or wrong SKU; nothing clicked), `unconfirmed` (pressed, result not proven; never pressed
 * again), `error` (nothing clicked).
 */
export function createDepopGoLiveCapability(options = {}) {
  const tab = requiredObject(options.tab, 'tab')
  const profile = requiredObject(options.profile, 'profile')
  if (profile.kind !== 'depop' || !profile.goLive) throw new TypeError('profile must be the authenticated Depop profile')
  const driver = requireBrowserDriver(tab.driver, 'tab.driver')
  for (const method of ['goto', 'url']) {
    if (typeof tab[method] !== 'function') throw new TypeError(`tab.${method} must be a function`)
  }
  const pollMs = nonNegativeInteger(options.pollMs, POLL_MS, 'pollMs')
  const pollAttempts = nonNegativeInteger(options.pollAttempts, POLL_ATTEMPTS, 'pollAttempts')
  const activeReads = nonNegativeInteger(options.activeReads, ACTIVE_READS, 'activeReads')
  const { goLive } = profile
  const pressed = new Set()

  async function waitUntil(predicate, attempts = pollAttempts) {
    for (let attempt = 0; attempt <= attempts; attempt += 1) {
      if (await predicate()) return true
      if (attempt < attempts && pollMs > 0) await delay(pollMs)
    }
    return false
  }

  async function count(query) {
    return refCount(await driver.locate(query))
  }

  async function currentUrl() {
    return new URL(await tab.url())
  }

  async function onPath(path) {
    const url = await currentUrl()
    return url.origin === profile.origin && samePath(url.pathname, path)
  }

  async function onDraftPage(draftPath) {
    if (!(await onPath(draftPath))) return false
    return (
      (await count(byRole(goLive.draftHeading.role, goLive.draftHeading.name))) === 1 &&
      (await count(byRole(profile.fields.sku.role, profile.fields.sku.label))) === 1 &&
      (await count(byRole(goLive.postAction.role, goLive.postAction.name))) === 1
    )
  }

  /**
   * The narrow go-live allowance: Post, exactly, on exactly this draft's edit page, once. This is
   * the only place this capability clicks anything.
   */
  async function pressPost(draftPath, attempt) {
    if (pressed.has(draftPath)) throw goLiveError('depop_go_live_already_pressed', 'Post was already pressed for this draft')
    if (!(await onPath(draftPath))) throw goLiveError('depop_go_live_page_mismatch', "The open page is not this listing's draft")
    const located = await driver.locate(byRole(goLive.postAction.role, goLive.postAction.name))
    if (refCount(located) !== 1) {
      throw goLiveError('depop_go_live_control_missing', `Expected one Post button, found ${refCount(located)}`)
    }
    const element = refElement(located)
    if (collapsed(element.name) !== goLive.postAction.name || goLive.neverClick.includes(collapsed(element.name))) {
      throw goLiveError('depop_go_live_control_mismatch', `The located button reads "${collapsed(element.name).slice(0, 60)}", not "Post"`)
    }
    // Delete is a submit button too: exactly one submit button may carry the name Post.
    const submits = await driver.locate(byCss(goLive.submitSelector))
    const postSubmits = Array.from({ length: refCount(submits) }, (_, index) => collapsed(refElement(submits, index).name))
      .filter((name) => name === goLive.postAction.name)
    if (postSubmits.length !== 1) {
      throw goLiveError('depop_go_live_control_mismatch', `Expected one submit button named Post, found ${postSubmits.length}`)
    }
    pressed.add(draftPath)
    attempt.clicked = true
    await driver.click(refAt(located, 0))
  }

  /** Depop's own required-field errors on the edit page, with the invalid fields' labels if readable. */
  async function requiredErrors() {
    const nodes = await driver.locate(byCss(goLive.requiredErrorSelector))
    let errors = 0
    for (let index = 0; index < refCount(nodes); index += 1) {
      if (collapsed(refElement(nodes, index).name) === goLive.requiredErrorText) errors += 1
    }
    if (errors === 0) return null
    const invalid = await driver.locate(byCss(goLive.invalidFieldSelector))
    const fields = []
    for (let index = 0; index < refCount(invalid); index += 1) {
      const name = collapsed(refElement(invalid, index).name)
      if (name !== '' && !fields.includes(name)) fields.push(name)
    }
    return { errors, fields }
  }

  /** The "View listing" link's public URL on the success page, else null. */
  async function successLinkUrl() {
    let found = null
    await waitUntil(async () => {
      const links = await driver.locate(byRole(goLive.viewListingLink.role, goLive.viewListingLink.name))
      if (refCount(links) !== 1) return false
      found = depopPublicProductUrl(refElement(links).href ?? '', profile)
      return found !== null
    }, Math.min(pollAttempts, 8))
    return found
  }

  /**
   * One read of Active/Selling: each row's SKU paired positionally with its `/manage/` link. A
   * shape where the counts disagree is refused rather than guessed at.
   */
  async function activeRows() {
    const skuNodes = await driver.locate(byCss(goLive.activeRowSkuSelector))
    const links = await driver.locate(byRole('link'))
    const manage = []
    for (let index = 0; index < refCount(links); index += 1) {
      const href = refElement(links, index).href
      if (typeof href !== 'string') continue
      let url
      try {
        url = new URL(href, profile.origin)
      } catch {
        continue
      }
      if (url.origin === profile.origin && MANAGE_PATH.test(url.pathname)) manage.push(url.pathname)
    }
    // Rows hydrate in pieces: unequal counts mean "not ready yet". The caller keeps polling and
    // refuses only if the shape still disagrees once its poll ends.
    if (refCount(skuNodes) !== manage.length) return { mismatch: `${refCount(skuNodes)} SKUs with ${manage.length} listing links` }
    return manage.map((path, index) => ({
      sku: stripSkuLabel(refElement(skuNodes, index).name ?? refElement(skuNodes, index).value),
      public_url: depopPublicProductUrl(path, profile),
    }))
  }

  /** The public URL Active/Selling shows for exactly this SKU, else null. Read-only, bounded. */
  async function activeListingFor(sku) {
    const activeUrl = new URL(goLive.activePath, profile.origin).toString()
    for (let read = 0; read < Math.max(1, activeReads); read += 1) {
      await tab.goto(activeUrl)
      let rows = []
      let mismatch = null
      await waitUntil(async () => {
        if (!(await onPath(goLive.activePath))) return false
        const read = await activeRows()
        if (!Array.isArray(read)) {
          mismatch = read.mismatch
          rows = []
          return false
        }
        mismatch = null
        rows = read
        return rows.length > 0
      }, Math.min(pollAttempts, 8))
      if (mismatch !== null) {
        throw goLiveError('depop_go_live_active_shape_unrecognized', `Active/Selling still paired ${mismatch} after waiting`)
      }
      const matches = rows.filter((row) => row.sku === sku)
      if (matches.length > 1) {
        throw goLiveError('depop_go_live_sku_ambiguous', `Active/Selling lists ${matches.length} listings with this SKU`)
      }
      if (matches.length === 1 && matches[0].public_url !== null) return matches[0].public_url
      if (read + 1 < activeReads && pollMs > 0) await delay(pollMs)
    }
    return null
  }

  /** Whether the public URL resolves at its own path (or the owner's `/manage/` view of it). */
  async function publicPageResolves(publicUrl) {
    await tab.goto(publicUrl)
    return await waitUntil(async () => depopPublicProductUrl((await currentUrl()).toString(), profile) === publicUrl)
  }

  async function provenLive(sku, expected) {
    const publicUrl = await activeListingFor(sku)
    if (publicUrl === null) return { ok: false, reason: 'not found on Active/Selling under its SKU' }
    if (expected !== null && publicUrl !== expected) {
      return { ok: false, reason: 'Active/Selling names a different listing than the success page' }
    }
    if (!(await publicPageResolves(publicUrl))) return { ok: false, reason: 'its public page did not resolve' }
    return { ok: true, public_url: publicUrl }
  }

  /** A listing pressed in an earlier call: read-only proof only, never another press. */
  async function reconcileOnce({ listing_id: listingId, sku, draft_url: draftUrl } = {}) {
    const base = { listing_id: listingId, sku: sku ?? null, draft_url: draftUrl ?? null }
    if (typeof sku !== 'string' || sku.trim() === '') {
      return { ...base, outcome: 'unconfirmed', failure_code: 'depop_go_live_previously_pressed', message: 'Post was pressed in an earlier call and Fold gave no SKU to look it up; check it on Depop by hand.' }
    }
    try {
      const proof = await provenLive(sku, null)
      if (proof.ok) {
        return { ...base, outcome: 'live', public_url: proof.public_url, reconciled: true, message: 'Live on Depop (Post was pressed in an earlier call); nothing was pressed now.' }
      }
      return {
        ...base,
        outcome: 'unconfirmed',
        failure_code: 'depop_go_live_previously_pressed',
        message: `Post was pressed in an earlier call and the listing is ${proof.reason}; it will not be pressed again. Check it on Depop by hand.`,
      }
    } catch (error) {
      return { ...base, outcome: 'unconfirmed', failure_code: 'depop_go_live_reconcile_failed', message: withDetail('Post was pressed in an earlier call and its result still cannot be read; it will not be pressed again. Check it on Depop by hand', error) }
    }
  }

  async function goLiveOnce({ listing_id: listingId, sku, draft_url: draftUrl } = {}, attempt) {
    const base = { listing_id: listingId, sku: sku ?? null, draft_url: draftUrl ?? null }
    const draft = depopGoLiveDraftUrl(draftUrl, profile)
    if (draft === null) {
      return {
        ...base,
        outcome: 'mismatch',
        failure_code: 'depop_go_live_draft_url_refused',
        message: 'Fold recorded no Depop draft edit URL for this listing, so nothing was opened or clicked.',
      }
    }
    if (typeof sku !== 'string' || sku.trim() === '') {
      return {
        ...base,
        outcome: 'mismatch',
        failure_code: 'depop_go_live_sku_missing',
        message: "Fold gave no SKU to confirm the draft's identity, so nothing was opened or clicked.",
      }
    }
    const draftPath = new URL(draft).pathname
    try {
      await tab.goto(draft)
      if (!(await waitUntil(() => onDraftPage(draftPath)))) {
        // The draft is consumed once posted: an earlier run or the seller may already have posted it.
        const proof = await provenLive(sku, null)
        if (proof.ok) {
          return { ...base, outcome: 'live', public_url: proof.public_url, reconciled: true, message: 'Already live on Depop; nothing was clicked.' }
        }
        return {
          ...base,
          outcome: 'mismatch',
          failure_code: 'depop_go_live_draft_missing',
          message: `The draft page did not open and the listing is ${proof.reason}, so nothing was clicked.`,
        }
      }
      const field = await driver.locate(byRole(profile.fields.sku.role, profile.fields.sku.label))
      const shown = String(refElement(field).value ?? '')
      if (shown !== sku) {
        return {
          ...base,
          outcome: 'mismatch',
          failure_code: 'depop_go_live_sku_mismatch',
          message: "The draft's SKU does not match Fold's, so nothing was clicked.",
        }
      }

      await pressPost(draftPath, attempt)
      const left = await waitUntil(async () => !(await onPath(draftPath)))
      if (!left) {
        const blocked = await requiredErrors()
        if (blocked !== null) {
          return {
            ...base,
            outcome: 'incomplete',
            ...(blocked.fields.length > 0 ? { fields: blocked.fields } : {}),
            failure_code: 'depop_go_live_incomplete',
            message:
              `Depop needs ${blocked.errors === 1 ? 'a required field' : `${blocked.errors} required fields`} ` +
              `filled before posting${blocked.fields.length > 0 ? ` (${blocked.fields.join(', ')})` : ''}; nothing was posted.`,
          }
        }
        return {
          ...base,
          outcome: 'unconfirmed',
          failure_code: 'depop_go_live_no_navigation',
          message: 'Post was pressed once but Depop stayed on the draft page; it was not pressed again. Check the draft on Depop.',
        }
      }
      const landed = await currentUrl()
      const onSuccess = landed.origin === profile.origin && goLive.successPathPattern.test(landed.pathname)
      const expected = onSuccess ? await successLinkUrl() : null
      const proof = await provenLive(sku, expected)
      if (!proof.ok) {
        return {
          ...base,
          outcome: 'unconfirmed',
          failure_code: 'depop_go_live_unverified',
          message: `Post was pressed once but the listing is ${proof.reason}; it was not pressed again.`,
        }
      }
      return {
        ...base,
        outcome: 'live',
        public_url: proof.public_url,
        ...(expected === null ? { located_by: 'sku' } : {}),
        message: 'Live on Depop.',
      }
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'depop_go_live_browser_failed'
      if (attempt.clicked) {
        return {
          ...base,
          outcome: 'unconfirmed',
          failure_code: code,
          message: withDetail('Post may have been pressed but its result could not be read; it was not pressed again', error),
        }
      }
      const refused = ['depop_go_live_page_mismatch', 'depop_go_live_control_missing', 'depop_go_live_control_mismatch', 'depop_go_live_sku_ambiguous'].includes(code)
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
     * looks for read-only proof on Active/Selling. `pressed` says whether this call pressed.
     */
    async goLive(args = {}) {
      const attempt = { clicked: false }
      const result = args.reconcileOnly === true ? await reconcileOnce(args) : await goLiveOnce(args, attempt)
      return { ...result, pressed: attempt.clicked }
    },
  })
}
