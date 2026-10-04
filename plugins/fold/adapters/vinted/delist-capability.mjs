import { byId, byTestId, refCount, refElement, requireBrowserDriver } from '../shared/browser-driver.mjs'
import { withDetail } from '../shared/error-detail.mjs'
import { vintedDraftEditUrl, vintedWardrobeMemberId, vintedWardrobeUrl } from './profile.mjs'

const POLL_MS = 150
const POLL_ATTEMPTS = 40
const STABLE_READS = 3

function delistError(code, message, extra = {}) {
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

function collapsed(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Deletes one sold piece's Vinted sibling — a draft or a listing the seller published — once the
 * calling agent holds the seller's consolidated approval. The one Vinted capability that clicks a
 * destructive control; the draft capability never does.
 *
 * The sibling is found by the item id in the URL Fold recorded (`/items/{id}/edit` for a draft this
 * plugin created, `/items/{id}-{slug}` once published), and what the page shows decides the path:
 *
 * - published: `/items/{id}` with the owner's Delete -> its "Delete item" dialog -> "Confirm and
 *   delete";
 * - draft: `/items/{id}/edit` with "Delete draft", which deletes at once (no dialog), so it is
 *   clicked only when that page's own URL carries this item id, it is a draft (the control exists
 *   exactly once) and its title equals Fold's listing title exactly.
 *
 * Success is the item gone from the seller's wardrobe. A sibling already absent from the wardrobe
 * with neither page offering a control is `not_found`. Anything else fails closed with a code.
 * Only those three controls are ever clicked: Mark as sold, Mark as reserved, Hide, Bump, Edit
 * listing, Save draft and Upload are refused by test id.
 */
export function createVintedDelistCapability(options = {}) {
  const tab = requiredObject(options.tab, 'tab')
  const profile = requiredObject(options.profile, 'profile')
  if (profile.kind !== 'vinted') throw new TypeError('profile must be a Vinted target profile')
  const driver = requireBrowserDriver(tab.driver, 'tab.driver')
  for (const method of ['goto', 'url']) {
    if (typeof tab[method] !== 'function') throw new TypeError(`tab.${method} must be a function`)
  }
  const pollMs = options.pollMs ?? POLL_MS
  const memberId = options.memberId === undefined || options.memberId === null ? null : String(options.memberId)
  if (memberId !== null && !/^\d+$/.test(memberId)) {
    throw delistError('vinted_member_id_invalid', "memberId must be the number in the seller's wardrobe URL")
  }
  const { delist } = profile
  const allowedClicks = new Set([delist.publishedDelete.testId, delist.publishedConfirm.testId, delist.draftDelete.testId])

  async function waitUntil(predicate) {
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
      if (await predicate()) return true
      if (pollMs > 0) await delay(pollMs)
    }
    return false
  }

  async function count(query) {
    return refCount(await driver.locate(query))
  }

  async function open(url) {
    if (typeof tab.openFresh === 'function') await tab.openFresh(url)
    else await tab.goto(url)
  }

  async function currentPath() {
    return new URL(await tab.url()).pathname
  }

  /** The only way this capability clicks: one exact control, from the allowed three, by test id. */
  async function clickExact(control) {
    if (!allowedClicks.has(control.testId)) {
      throw delistError('vinted_delist_control_refused', `Refusing to click ${control.testId}`)
    }
    const located = await driver.locate(byTestId(control.testId))
    if (refCount(located) !== 1) {
      throw delistError('vinted_delist_control_missing', `Expected one ${control.name} control, found ${refCount(located)}`)
    }
    const element = refElement(located)
    if (element.testId !== control.testId || collapsed(element.name) !== control.name) {
      throw delistError(
        'vinted_delist_control_mismatch',
        `The ${control.testId} control reads "${collapsed(element.name)}", not "${control.name}"`
      )
    }
    await driver.click(located)
  }

  /** The item id in a URL Fold recorded for a Vinted listing, else a refusal. */
  function itemIdOf(listingUrl) {
    let url
    try {
      url = new URL(listingUrl)
    } catch {
      throw delistError('vinted_delist_url_missing', 'Fold recorded no Vinted URL for this sibling')
    }
    const id = url.origin === profile.origin ? delist.itemUrlPattern.exec(url.pathname)?.[1] : undefined
    if (id === undefined) {
      throw delistError('vinted_delist_url_unrecognized', `${url.origin}${url.pathname} is not a Vinted item URL`)
    }
    return id
  }

  /** Whether the seller's wardrobe still lists this item, once its cards have settled. */
  async function wardrobeLists(itemId) {
    if (memberId === null) {
      throw delistError('vinted_member_id_required', "The seller's Vinted member id is needed to confirm the deletion")
    }
    if (vintedWardrobeMemberId(await tab.url(), profile) !== memberId) await open(vintedWardrobeUrl(memberId, profile))
    await waitUntil(async () => (await count(byTestId('closet-seller-filters-draft'))) > 0)
    let previous = null
    let stable = 0
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
      const present = (await count(byTestId(`product-item-id-${itemId}`))) > 0
      stable = present === previous ? stable + 1 : 1
      previous = present
      if (stable >= STABLE_READS) return present
      if (pollMs > 0) await delay(pollMs)
    }
    return previous === true
  }

  async function confirmGone(itemId, kind) {
    const landed = await waitUntil(async () => vintedWardrobeMemberId(await tab.url(), profile) !== null)
    if (!landed) {
      throw delistError('vinted_delist_unconfirmed', `Vinted did not return to the wardrobe after deleting the ${kind}`)
    }
    for (let check = 0; check < 3; check += 1) {
      if (check > 0) await open(vintedWardrobeUrl(memberId, profile))
      if (!(await wardrobeLists(itemId))) return
    }
    throw delistError('vinted_delist_unconfirmed', `The wardrobe still lists item ${itemId} after deleting the ${kind}`)
  }

  async function deletePublished(itemId) {
    await clickExact(delist.publishedDelete)
    const dialogOpen = await waitUntil(async () => (await count(byTestId(delist.publishedDialog))) === 1)
    if (!dialogOpen) throw delistError('vinted_delist_dialog_missing', 'Delete did not open its confirmation dialog')
    const dialog = refElement(await driver.locate(byTestId(delist.publishedDialog)))
    if (dialog.role !== 'dialog' || !collapsed(dialog.name).includes(delist.publishedDialogText)) {
      throw delistError(
        'vinted_delist_dialog_unrecognized',
        `The confirmation dialog reads "${collapsed(dialog.name).slice(0, 120)}"`
      )
    }
    await clickExact(delist.publishedConfirm)
    await confirmGone(itemId, 'listing')
    return { status: 'deleted', kind: 'published', dialog_text: collapsed(dialog.name).slice(0, 200) }
  }

  /** Delete draft has no confirmation, so every identity check comes first. */
  async function deleteDraft(itemId, title) {
    const path = await currentPath()
    if (profile.draftEditPathPattern.exec(path)?.[1] !== itemId) {
      throw delistError('vinted_delist_draft_identity_unconfirmed', `The open page is ${path}, not item ${itemId}'s draft`)
    }
    if ((await count(byTestId(delist.draftDelete.testId))) !== 1) {
      throw delistError('vinted_delist_draft_identity_unconfirmed', 'The page offers no single Delete draft control')
    }
    const titles = await driver.locate(byId('title'))
    const shown = refCount(titles) === 1 ? String(refElement(titles).value ?? '') : null
    if (shown !== title) {
      throw delistError(
        'vinted_delist_draft_identity_unconfirmed',
        `The draft's title is "${collapsed(shown).slice(0, 120)}", not Fold's listing title`
      )
    }
    await clickExact(delist.draftDelete)
    await confirmGone(itemId, 'draft')
    return { status: 'deleted', kind: 'draft' }
  }

  return Object.freeze({
    /** Nothing to open up front: every sibling is reached by its own URL. */
    async navigate() {},

    async delistSibling({ listing_url: listingUrl, title } = {}) {
      if (typeof title !== 'string' || title.trim() === '') {
        throw delistError('vinted_delist_title_missing', "Fold's listing title is needed to confirm a draft's identity")
      }
      const itemId = itemIdOf(listingUrl)
      if (memberId === null) {
        throw delistError(
          'vinted_member_id_required',
          "The seller's Vinted member id is needed to confirm a deletion, so nothing was deleted"
        )
      }
      try {
        await open(new URL(`/items/${itemId}`, profile.origin).toString())
        if (await waitUntil(async () => (await count(byTestId(delist.publishedDelete.testId))) === 1)) {
          return { item_id: itemId, ...(await deletePublished(itemId)) }
        }
        await open(vintedDraftEditUrl(itemId, profile))
        const isDraft = await waitUntil(async () => (await count(byTestId(delist.draftDelete.testId))) === 1)
        if (isDraft) return { item_id: itemId, ...(await deleteDraft(itemId, title)) }
        if (!(await wardrobeLists(itemId))) {
          return {
            item_id: itemId,
            status: 'not_found',
            reason: 'Neither the listing nor the draft page offers it and the wardrobe no longer lists it',
          }
        }
        throw delistError(
          'vinted_delist_page_unrecognized',
          `Item ${itemId} is in the wardrobe but neither its page nor its edit page offers a delete control`
        )
      } catch (error) {
        if (typeof error?.code === 'string' && error.code.startsWith('vinted_')) throw error
        throw delistError('vinted_delist_browser_failed', withDetail(`Deleting item ${itemId} failed`, error))
      }
    },
  })
}
