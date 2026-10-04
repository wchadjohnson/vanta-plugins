import {
  byCss,
  byId,
  byRole,
  refAt,
  refCount,
  refElement,
  requireBrowserDriver,
} from '../shared/browser-driver.mjs'

/**
 * Drives Depop's own Active/Selling page to delete one sold piece's still-live sibling listings,
 * once the calling agent has one consolidated seller approval covering every sibling it will act
 * on. A sibling of `bulk-listing-capability.mjs`, not a branch inside it: this shares only the
 * browser connection and the Layer C driver interface, and it is the one Depop capability in this
 * repository that deliberately activates a destructive, unconditionally irreversible control.
 *
 * Why Active/Selling and not a stored `external_url`. Posting a draft changes its URL entirely
 * (`/sellinghub/drafts/edit/{id}/` -> `/products/{slug}/manage/`), so a `external_url` captured at
 * import time can go stale the moment the seller posts it. This capability therefore always
 * relocates the sibling by searching the Active/Selling page for its exact SKU rather than
 * trusting a stored URL as a navigation target — `external_url` still matters elsewhere (the
 * seller-facing approval message), just never here.
 *
 * What is, and is not, live-verified. Live-captured against a real account 2026-09-14 (Manage
 * dropdown control names, Active/Selling URL), again 2026-09-19 (row/SKU pairing, Delete's own
 * confirmation dialog role/text/control), and again 2026-10-03 (Active/Selling's zero-listing empty
 * text after the owner manually deleted SKU FLD-0055). The non-empty facts this capability depends
 * on have now been observed on a real account with exactly one active listing. Two real corrections
 * came out of the second pass: the Manage button's accessible name is "Manage listings" (an
 * aria-label override), not its visible text "Manage", and the confirmation dialog's role is
 * `dialog`, not `alertdialog` — both would have made this capability silently fail closed
 * (`delist_manage_control_missing` / `delist_confirm_dialog_missing`) against a real page even
 * though the elements were present. See the `delist` profile fields in `profile.mjs` for the exact
 * captured values, and `confirmDelete()` below for how a still-wrong guess fails closed rather than
 * clicking blind. Not yet exercised: multiple simultaneous rows on a real account (the capturing
 * account had exactly one listing), so the positional SKU/Manage pairing below is verified for n=1
 * and reasoned, not observed, for n>1.
 *
 * Drafts (captured live 2026-10-04). A sibling that is still a draft is not on Active/Selling, so
 * when Active/Selling has no row for the SKU, the Incomplete and then Ready-to-post drafts views
 * are searched the same way (exact SKU, positional pairing with the row checkboxes, more than one
 * match fails closed). A draft is deleted by ticking exactly its own row checkbox (id == the
 * draft's uuid), proving that is the only ticked box and the toolbar reads "1 selected", pressing
 * the toolbar Delete, reading the "Are you sure?" dialog's text, and pressing Confirm; it counts as
 * deleted once its SKU is gone from the table. "Select All", the toolbar "Edit" and Ready-to-post's
 * "Post" are never clicked. See `DELIST_DRAFTS` in `profile.mjs`.
 */

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function delistError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * Validates one bounded-inference decision naming which real, currently-observed control to target
 * next — never trusted to skip the exact-match gate, only to say which exact string to re-try it
 * with (see `resolveControlCandidates` below). Mirrors the confidence/reason discipline the
 * Depop category picker already uses in `adapter.mjs`'s `resolveCategoryChoice`, applied here to
 * control identification instead of taxonomy.
 */
function validateControlDecision(decision) {
  if (decision === null || typeof decision !== 'object' || Array.isArray(decision)) {
    throw delistError('delist_control_decision_invalid', 'Control inference decision must be an object')
  }
  if (!nonEmptyString(decision.chosenName)) {
    throw delistError(
      'delist_control_decision_invalid',
      'Control inference decision must name one real, currently-observed control'
    )
  }
  if (!['high', 'medium'].includes(decision.confidence)) {
    throw delistError(
      'delist_control_inference_confidence_insufficient',
      'Control inference confidence must be medium or high'
    )
  }
  if (!nonEmptyString(decision.reason) || decision.reason.length > 500) {
    throw delistError(
      'delist_control_inference_reason_invalid',
      'Control inference must include a concise reason'
    )
  }
  return decision
}

function requiredObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`)
  }
  return value
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizedDelay(value) {
  const delayMs = value ?? 0
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 1000) {
    throw new TypeError('interactionDelayMs must be an integer from 0 through 1000')
  }
  return delayMs
}

function normalizedRange(value, name, fallback, min, max) {
  const delayMs = value ?? fallback
  if (!Number.isInteger(delayMs) || delayMs < min || delayMs > max) {
    throw new TypeError(`${name} must be an integer from ${min} through ${max}`)
  }
  return delayMs
}

function normalizedDescriptorText(value) {
  return String(value ?? '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function sameOriginUrl(value, profile, label) {
  if (!nonEmptyString(value)) throw delistError('browser_url_missing', `${label} URL is missing`)
  const url = new URL(value)
  if (url.origin !== profile.origin) {
    throw delistError('browser_origin_mismatch', `${label} escaped the configured target origin`)
  }
  url.search = ''
  url.hash = ''
  return url
}

export function createDepopDelistCapability(options = {}) {
  const tab = requiredObject(options.tab, 'tab')
  const profile = requiredObject(options.profile, 'profile')
  const delist = requiredObject(profile.delist, 'profile.delist')
  const driver = requireBrowserDriver(tab.driver, 'tab.driver')
  const interactionDelayMs = normalizedDelay(options.interactionDelayMs)
  const activePageSettleMs = normalizedRange(
    options.activePageSettleMs,
    'activePageSettleMs',
    5000,
    0,
    30000
  )
  const activePagePollMs = normalizedRange(
    options.activePagePollMs,
    'activePagePollMs',
    250,
    1,
    1000
  )
  for (const method of ['goto', 'url']) {
    if (typeof tab[method] !== 'function') throw new TypeError(`tab.${method} must be a function`)
  }

  const metrics = { startedAt: null, completedAt: null, steps: 0, driverActions: 0 }
  let phase = 'surface'
  // The real accessible name Manage most recently resolved to for the current row (known or
  // inferred) — see `resolveControlCandidates`'s `excludeNames` for why this exists.
  let resolvedManageName = null

  async function pause() {
    metrics.steps += 1
    if (interactionDelayMs > 0) await delay(interactionDelayMs)
  }

  async function locate(query) {
    metrics.driverActions += 1
    return driver.locate(query)
  }

  async function goTo(url) {
    metrics.startedAt ??= Date.now()
    if ((await tab.url()) === url) return
    await tab.goto(url)
  }

  async function activePageEmptyStateConfirmed() {
    const emptyState = await locate(byCss(delist.emptyState.selector))
    const expected = normalizedDescriptorText(delist.emptyState.text)
    for (let index = 0; index < refCount(emptyState); index += 1) {
      const element = refElement(emptyState, index)
      if (normalizedDescriptorText(element.name ?? element.value) === expected) return true
    }
    return false
  }

  async function locatedSiblingRow(sku, skuNodes, manageDecision) {
    const manageButtons = await resolveControlCandidates({
      role: delist.manageAction.role,
      expectedName: delist.manageAction.name,
      intent: delist.intents.manageAction,
      code: 'delist_manage_control_inference_required',
      missingCode: 'delist_manage_control_missing',
      override: manageDecision,
    })
    if (refCount(skuNodes) !== refCount(manageButtons)) {
      throw delistError(
        'delist_row_shape_unrecognized',
        'Active/Selling row structure did not pair one SKU with one Manage control'
      )
    }
    if (refCount(manageButtons) > 0) resolvedManageName = refElement(manageButtons, 0).name
    const matches = []
    for (let index = 0; index < refCount(skuNodes); index += 1) {
      const node = refElement(skuNodes, index)
      const raw = String(node.value ?? node.name ?? '').trim()
      const text = raw.replace(/^SKU:\s*/i, '').trim()
      if (text === sku) matches.push(index)
    }
    await pause()
    if (matches.length === 0) return { found: false }
    if (matches.length > 1) {
      throw delistError(
        'delist_sku_ambiguous',
        `More than one Active/Selling row matches SKU ${sku}`
      )
    }
    return { found: true, manageAction: refAt(manageButtons, matches[0]) }
  }

  /**
   * Resolves one named control by its known exact accessible name, falling back to bounded,
   * evidence-gated inference only when that exact name currently matches nothing live — the same
   * condition a Depop rename produces (see `profile.mjs`'s "Manage listings" vs "Manage" history).
   *
   * The known name is always tried first, so an unchanged Depop page behaves identically to before
   * this existed — no added latency, no added risk. On a genuine miss with no `override` supplied,
   * every real control of that `role` currently on the page is enumerated and returned to the
   * caller as `error.candidates`, alongside `error.intent` (what the control must actually do,
   * from `profile.mjs`'s `DELIST_INTENTS` — never Depop's current wording). Zero real candidates
   * means there is nothing to infer from, so that refuses with `missingCode` instead of asking a
   * model to invent one, the same choice Depop's category picker makes in `adapter.mjs`.
   *
   * An `override` decision is never trusted directly: `decision.chosenName` is re-queried through
   * this exact same `byRole` path and must resolve on its own before the caller can act on it.
   * Inference only ever picks which real string to target next; it can never make a query match
   * something that is not actually there right now.
   *
   * `excludeNames` filters known-irrelevant real controls out of the candidate list. Layer C has
   * no scoped/descendant query — `byRole(role)` is page-wide, not "inside this dialog" or "inside
   * this row" — so a page-wide `role: 'button'` enumeration while a dialog is open would also
   * return every row's Manage button, which shares that same role. Manage's own currently-resolved
   * name is the one collision this can name and exclude with certainty; it cannot rule out other
   * unrelated page chrome (nav, per-row Edit, etc.) sharing the same role, which is a real
   * limitation of this fallback until Layer C gains a scoped query — a wrong choice among genuinely
   * unrelated candidates still only ever fails closed at the re-query below, never mis-clicks.
   */
  async function resolveControlCandidates({
    role,
    expectedName,
    intent,
    code,
    missingCode,
    override,
    extra,
    excludeNames = [],
  }) {
    if (expectedName !== null) {
      const known = await locate(byRole(role, expectedName))
      if (refCount(known) > 0) return known
    }
    if (override !== undefined) {
      const decision = validateControlDecision(override)
      return locate(byRole(role, decision.chosenName))
    }
    const observed = await locate(byRole(role))
    const candidates = [...new Set(
      Array.from({ length: refCount(observed) }, (_, index) => refElement(observed, index).name)
        .filter(nonEmptyString)
    )].filter((name) => !excludeNames.includes(name))
    if (candidates.length === 0) {
      const error = delistError(
        missingCode,
        `No live ${role} control of this kind is present to infer from`
      )
      if (extra) Object.assign(error, extra)
      throw error
    }
    const error = delistError(
      code,
      `The known control was not found live; Depop may have renamed it — choose among the real ` +
        'observed controls'
    )
    error.intent = intent
    error.candidates = candidates
    if (extra) Object.assign(error, extra)
    throw error
  }

  const drafts = delist.drafts

  function stripSkuLabel(value) {
    return String(value ?? '').trim().replace(/^SKU:\s*/i, '').trim()
  }

  /** Every click on a drafts view goes through here: never Select All, Edit or Post. */
  async function clickDraftControl(located, expectedName) {
    const element = refElement(located)
    const name = normalizedDescriptorText(element.name)
    if (drafts.neverClick.includes(name) || drafts.neverClick.includes(normalizedDescriptorText(element.value))) {
      throw delistError('delist_draft_control_refused', `Refusing the drafts view's "${name}" control`)
    }
    if (expectedName !== undefined && name !== expectedName) {
      throw delistError('delist_draft_control_mismatch', `Expected "${expectedName}", found "${name}"`)
    }
    metrics.driverActions += 1
    await driver.click(located)
    await pause()
  }

  /** A drafts table read three times running with the same result. */
  async function settled(read) {
    let previous = null
    let stable = 0
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const current = await read()
      const signature = JSON.stringify(current)
      stable = signature === previous ? stable + 1 : 1
      previous = signature
      if (stable >= 3) return current
      await delay(activePagePollMs)
    }
    throw delistError('delist_drafts_page_unrecognized', 'The drafts table did not settle')
  }

  /** One drafts view's rows: SKU text paired positionally with each row's checkbox (uuid). */
  async function draftRows() {
    const skuNodes = await locate(byCss(delist.rowSkuSelector))
    const boxes = await locate(byCss(drafts.rowCheckboxSelector))
    if (refCount(skuNodes) !== refCount(boxes)) {
      throw delistError(
        'delist_draft_row_shape_unrecognized',
        `The drafts table paired ${refCount(skuNodes)} SKU cells with ${refCount(boxes)} row checkboxes`
      )
    }
    return Array.from({ length: refCount(skuNodes) }, (_, index) => ({
      sku: stripSkuLabel(refElement(skuNodes, index).name ?? refElement(skuNodes, index).value),
      uuid: refElement(boxes, index).id ?? null,
      checked: refElement(boxes, index).checked === true,
    }))
  }

  async function openDraftView(view) {
    await goTo(sameOriginUrl(view.url, profile, 'Drafts view').toString())
    const current = sameOriginUrl(await tab.url(), profile, 'Drafts view')
    const tabShown = async () => refCount(await locate(byRole('button', view.tabLabel))) > 0
    const deadline = Date.now() + activePageSettleMs
    while (current.pathname !== view.path || !(await tabShown())) {
      if (Date.now() >= deadline) {
        throw delistError('delist_drafts_page_unrecognized', `The ${view.id} drafts view did not render`)
      }
      await delay(activePagePollMs)
    }
  }

  return Object.freeze({
    /**
     * Searches the drafts views, in order, for one exact SKU — after Active/Selling had no row for
     * it. Stops at the first view with a match; more than one match in a view fails closed.
     */
    async findDraftSibling(sku) {
      phase = 'locate_draft'
      if (!nonEmptyString(sku)) throw new TypeError('sku must be a non-empty string')
      for (const view of drafts.views) {
        await openDraftView(view)
        const rows = await settled(draftRows)
        const matches = rows.filter((row) => row.sku === sku)
        if (matches.length > 1) {
          throw delistError('delist_sku_ambiguous', `More than one ${view.id} draft carries SKU ${sku}`)
        }
        if (matches.length === 1) {
          if (!nonEmptyString(matches[0].uuid)) {
            throw delistError('delist_draft_row_shape_unrecognized', `The ${view.id} draft row has no uuid`)
          }
          return { found: true, surface: view.id, uuid: matches[0].uuid }
        }
      }
      return { found: false }
    },

    /** Deletes the one draft `findDraftSibling` found, with every check before each click. */
    async deleteDraftRow({ surface, uuid, sku } = {}) {
      phase = 'delete_draft'
      const view = drafts.views.find((entry) => entry.id === surface)
      if (view === undefined || !nonEmptyString(uuid) || !nonEmptyString(sku)) {
        throw new TypeError('deleteDraftRow needs the surface, uuid and sku findDraftSibling returned')
      }
      const current = sameOriginUrl(await tab.url(), profile, 'Drafts view')
      if (current.pathname !== view.path) await openDraftView(view)
      const rows = await draftRows()
      const row = rows.find((entry) => entry.uuid === uuid)
      if (row === undefined || row.sku !== sku) {
        throw delistError('delist_draft_identity_unconfirmed', `Draft ${uuid} no longer carries SKU ${sku}`)
      }
      if (rows.some((entry) => entry.checked)) {
        throw delistError('delist_draft_selection_unexpected', 'A draft was already ticked before this one')
      }
      const box = await locate(byId(uuid))
      // An id query reports only an explicit role on some hosts; a native checkbox still reports
      // its checked state, which no other element does.
      const boxElement = refCount(box) === 1 ? refElement(box) : null
      if (
        boxElement === null ||
        !['checkbox', ''].includes(boxElement.role) ||
        typeof boxElement.checked !== 'boolean'
      ) {
        throw delistError('delist_draft_checkbox_missing', `Expected one checkbox for draft ${uuid}`)
      }
      await clickDraftControl(box)

      const ticked = (await draftRows()).filter((entry) => entry.checked).map((entry) => entry.uuid)
      if (ticked.length !== 1 || ticked[0] !== uuid) {
        throw delistError('delist_draft_selection_unexpected', `Ticked drafts are [${ticked.join(', ')}], not [${uuid}]`)
      }
      const counters = await locate(byCss(drafts.selectionTextSelector))
      const oneSelected = Array.from({ length: refCount(counters) }, (_, index) =>
        normalizedDescriptorText(refElement(counters, index).name)
      ).includes(drafts.selectedText(1))
      if (!oneSelected) {
        throw delistError('delist_draft_selection_unexpected', `The toolbar does not read "${drafts.selectedText(1)}"`)
      }

      const deleteButton = await locate(byRole(drafts.deleteAction.role, drafts.deleteAction.name))
      if (refCount(deleteButton) !== 1) {
        throw delistError('delist_delete_control_missing', 'Expected exactly one drafts Delete control')
      }
      await clickDraftControl(deleteButton, drafts.deleteAction.name)

      const dialog = await locate(byRole(drafts.dialog.role, drafts.dialog.name))
      if (refCount(dialog) !== 1) {
        throw delistError('delist_confirm_dialog_missing', 'Depop did not show the draft delete confirmation')
      }
      const dialogText = normalizedDescriptorText(await driver.readText(dialog))
      if (!dialogText.includes(drafts.dialogText)) {
        const error = delistError(
          'delist_confirm_dialog_content_unexpected',
          'The confirmation dialog does not read as a permanent draft delete'
        )
        error.observed_dialog_text = dialogText
        throw error
      }
      const confirm = await locate(byRole(drafts.confirmAction.role, drafts.confirmAction.name))
      if (refCount(confirm) !== 1) {
        throw delistError('delist_confirm_control_missing', 'Expected exactly one Confirm control')
      }
      await clickDraftControl(confirm, drafts.confirmAction.name)

      const deadline = Date.now() + Math.max(activePageSettleMs, 1)
      for (;;) {
        const remaining = (await draftRows()).filter((entry) => entry.sku === sku)
        if (remaining.length === 0) break
        if (Date.now() >= deadline) {
          throw delistError('delist_draft_still_listed', `SKU ${sku} is still in the ${view.id} drafts after Confirm`)
        }
        await delay(activePagePollMs)
      }
      metrics.completedAt = Date.now()
      return { deleted: true, surface: view.id, uuid, dialog_text: dialogText }
    },

    metrics() {
      return {
        interaction_delay_ms: interactionDelayMs,
        elapsed_ms:
          metrics.startedAt === null ? 0 : (metrics.completedAt ?? Date.now()) - metrics.startedAt,
        steps: metrics.steps,
        driver_actions: metrics.driverActions,
      }
    },

    /** Opens Depop's own Active/Selling page. Nothing is written by navigating. */
    async navigate() {
      phase = 'surface'
      await goTo(sameOriginUrl(delist.url, profile, 'Active/Selling').toString())
      const current = sameOriginUrl(await tab.url(), profile, 'Active/Selling')
      if (current.pathname !== delist.path) {
        throw delistError(
          'delist_surface_unrecognized',
          'The browser is not on the Active/Selling page'
        )
      }
      await pause()
    },

    /**
     * Pairs the page's SKU-bearing nodes with its Manage controls positionally, but only after the
     * Active/Selling page has proved it actually rendered listing rows. That preserves the same
     * discipline `bulk-listing-capability.mjs` uses for the row-error label/message split, and for
     * the same reason: neither half is safely locatable by role alone, so a mismatch in the two
     * counts is reported and refused (`delist_row_shape_unrecognized`) rather than guessed at.
     *
     * When the SKU query returns zero nodes, this does not look for Manage controls at all: it
     * waits boundedly for either rows to appear or Depop's own captured empty-state text to appear.
     * Rows with no exact SKU match, or a confirmed zero-row empty state, are "nothing to do." Zero
     * rows without that positive empty-state confirmation is `delist_active_page_unrecognized`, a
     * failure, because the page may simply not have loaded and Fold must not record a delete that
     * did not happen.
     *
     * A row is never located by nearest-match or fuzzy SKU comparison.
     *
     * The node's own text is `"SKU: <value>"`, a label-plus-value pair, not the bare value —
     * observed live 2026-09-19. Only the leading `SKU:` label (case-insensitive, whitespace after
     * it collapsed) is stripped before comparing; a value that happens to contain "SKU:" elsewhere
     * in it is compared unchanged, since that label only ever appears once, at the start.
     *
     * The Manage lookup itself falls back to bounded inference (see `resolveControlCandidates`)
     * when Depop's captured name matches nothing live — pass `manageDecision` to supply the
     * resolved choice on a retry. Row/SKU identity matching is never subject to this: it stays
     * byte-exact regardless.
     */
    async findSiblingRow(sku, { manageDecision } = {}) {
      phase = 'locate'
      if (!nonEmptyString(sku)) throw new TypeError('sku must be a non-empty string')
      const deadline = Date.now() + activePageSettleMs
      while (true) {
        const skuNodes = await locate(byCss(delist.rowSkuSelector))
        if (refCount(skuNodes) > 0) return locatedSiblingRow(sku, skuNodes, manageDecision)
        if (await activePageEmptyStateConfirmed()) {
          await pause()
          return { found: false }
        }
        if (activePageSettleMs === 0 || Date.now() >= deadline) {
          throw delistError(
            'delist_active_page_unrecognized',
            "Neither listing rows nor Depop's empty state were observed on Active/Selling, " +
              'so the page cannot be confirmed empty and nothing can be concluded'
          )
        }
        await delay(Math.min(activePagePollMs, Math.max(0, deadline - Date.now())))
      }
    },

    /** Opens one row's own Manage dropdown. Never clicks Boost, Discount, Copy, or Mark as sold. */
    async openManageMenu(manageAction) {
      phase = 'manage'
      if (manageAction === null || typeof manageAction !== 'object') {
        throw new TypeError('manageAction must be the ref findSiblingRow() returned')
      }
      metrics.driverActions += 1
      await driver.click(manageAction)
      await pause()
    },

    /**
     * Clicks only Delete inside the open Manage dropdown. Never Mark as sold or Unboost.
     *
     * Falls back to bounded inference (see `resolveControlCandidates`) when Depop's captured name
     * matches nothing live in the open menu — pass `deleteDecision` to supply the resolved choice
     * on a retry. Unlike Confirm below, this needs no `excludeNames`: Delete's role is `menuitem`,
     * which Manage's `button` role can never collide with in a page-wide enumeration.
     */
    async activateDelete({ deleteDecision } = {}) {
      phase = 'delete'
      const deleteItem = await resolveControlCandidates({
        role: delist.deleteAction.role,
        expectedName: delist.deleteAction.name,
        intent: delist.intents.deleteAction,
        code: 'delist_delete_control_inference_required',
        missingCode: 'delist_delete_control_missing',
        override: deleteDecision,
      })
      if (refCount(deleteItem) !== 1) {
        throw delistError('delist_delete_control_missing', 'Expected exactly one Delete control')
      }
      metrics.driverActions += 1
      await driver.click(refAt(deleteItem, 0))
      await pause()
    },

    /** Reads the confirmation dialog's own text without acting on it. Never assumed present. */
    async readConfirmationDialog() {
      const dialog = await locate(byRole(delist.confirmDialogRole))
      if (refCount(dialog) === 0) return { found: false, text: null }
      return { found: true, text: String(refElement(dialog, 0).name ?? '') }
    },

    /**
     * Confirms Delete's "Are you sure?" dialog — the one truly irreversible step in this
     * capability, with no discoverable undo once it succeeds. Two independent checks must agree
     * before that click happens, and either alone refusing is enough to stop it:
     *
     * 1. Content gate, always enforced, never subject to inference: the dialog's own observed text
     *    must read as a permanent-delete confirmation (`delist.confirmContentPattern` — see
     *    `profile.mjs`). This runs before the confirm control is even looked for, so a dialog that
     *    does not say what a delete confirmation should say refuses regardless of how confident any
     *    control-name match is.
     * 2. Control gate: the confirm control must resolve to exactly one real element, by its known
     *    captured name or — when that name is `null` (never captured) or matches nothing live — by
     *    a bounded inference decision passed as `confirmDecision`, itself re-verified the same way
     *    every other resolved control is (see `resolveControlCandidates`).
     */
    async confirmDelete({ confirmDecision } = {}) {
      phase = 'confirm'
      const dialog = await locate(byRole(delist.confirmDialogRole))
      if (refCount(dialog) === 0) {
        throw delistError(
          'delist_confirm_dialog_missing',
          'Depop did not show a delete confirmation dialog'
        )
      }
      const observedText = String(refElement(dialog, 0).name ?? '')
      const pattern = delist.confirmContentPattern
      if (!pattern.action.test(observedText) || !pattern.permanence.test(observedText)) {
        const error = delistError(
          'delist_confirm_dialog_content_unexpected',
          'The confirmation dialog text does not read as a permanent-delete confirmation'
        )
        error.observed_dialog_text = observedText
        throw error
      }

      const confirmControl = await resolveControlCandidates({
        role: delist.confirmAction.role,
        expectedName: delist.confirmAction.name,
        intent: delist.intents.confirmAction,
        code: 'delist_confirm_control_inference_required',
        missingCode: 'delist_confirm_control_missing',
        override: confirmDecision,
        extra: { observed_dialog_text: observedText },
        excludeNames: resolvedManageName !== null ? [resolvedManageName] : [],
      })
      if (refCount(confirmControl) !== 1) {
        throw delistError(
          'delist_confirm_control_missing',
          'Delete confirmation control did not resolve to exactly one element'
        )
      }
      metrics.driverActions += 1
      await driver.clickAndWaitForNavigation(refAt(confirmControl, 0))
      metrics.completedAt = Date.now()
      return { confirmed: true, dialog_text: observedText }
    },

    complete() {
      metrics.completedAt = Date.now()
    },
  })
}
