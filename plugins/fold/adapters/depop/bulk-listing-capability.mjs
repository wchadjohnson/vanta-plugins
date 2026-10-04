import { byCss, byRole, refAt, refCount, refElement, requireBrowserDriver } from '../shared/browser-driver.mjs'
import { stableDraftEditUrls } from './browser-capability.mjs'
import { isLiveActionName } from './profile.mjs'

/**
 * Hands the resale platform's own bulk-listing importer a marketplace CSV and then watches the
 * platform's draft surfaces for the drafts it files. A sibling of the per-field draft capability,
 * not a branch inside it: the two share only the browser connection, the Layer C driver interface,
 * and draft-edit-URL discovery.
 *
 * Why a second capability at all. The per-field path drives one whole create form per listing, so
 * its cost and its failure surface both scale with the batch. This path performs one navigation and
 * one file delivery for a batch of any size, and the platform itself does the field mapping — which
 * removes the taxonomy-matching problem rather than automating around it. The platform also
 * guarantees imported rows arrive as private drafts.
 *
 * Import is asynchronous. The upload banner confirms only that the FILE was accepted; the platform
 * then creates drafts in the background and emails the seller when they are ready. It surfaces no
 * accepted/rejected count anywhere, so per-row outcome comes from polling the draft surfaces for
 * each SKU and from nothing else.
 *
 * What it deliberately does not do. It fills no field and selects no option. Inspection only
 * locates the upload trigger; upload activates that exact trigger inside the driver's file-chooser
 * intercept so Codex can deliver the CSV without surfacing an operating-system dialog. The
 * Claude-in-Chrome driver stamps the input directly and never clicks the trigger.
 */

const SNAPSHOT_POLL_MS = 150
const IMPORT_POLL_MS = 1000
const IMPORT_TIMEOUT_MS = 120_000
const SURFACE_POLL_MS = 250
const SURFACE_TIMEOUT_MS = 20_000
const DRAFT_VIEW_SETTLE_MS = 5000
/** Bounded wait for the upload alert to render before the run is abandoned. */
const NOTICE_ATTEMPTS = 20
const PHASES = Object.freeze(['surface', 'snapshot', 'upload', 'notice', 'correlation'])

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function bulkListingError(code, message) {
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

function normalizedDelay(value, name) {
  const delayMs = value ?? 0
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 1000) {
    throw new TypeError(`${name} must be an integer from 0 through 1000`)
  }
  return delayMs
}

function normalizedTimeout(value, name, fallback) {
  const timeout = value ?? fallback
  if (!Number.isInteger(timeout) || timeout < 0) {
    throw new TypeError(`${name} must be a non-negative integer`)
  }
  return timeout
}

/** Zero-interval polling (tests) never sleeps, so it gets a small fixed attempt cap instead. */
const ZERO_INTERVAL_ATTEMPTS = 20

/** Reads allowed inside `timeoutMs` at `intervalMs` apart, counting the first immediate read. */
function boundedAttempts(timeoutMs, intervalMs) {
  if (timeoutMs === 0) return 1
  if (intervalMs === 0) return Math.min(timeoutMs + 1, ZERO_INTERVAL_ATTEMPTS)
  return Math.ceil(timeoutMs / intervalMs) + 1
}

function sameOriginUrl(value, profile, label) {
  if (!nonEmptyString(value)) {
    throw bulkListingError('browser_url_missing', `${label} URL is missing`)
  }
  const url = new URL(value)
  if (url.origin !== profile.origin) {
    throw bulkListingError('browser_origin_mismatch', `${label} escaped the configured target origin`)
  }
  url.search = ''
  url.hash = ''
  return url
}

/**
 * The same shape as the per-field capability's gate: a live-sounding name is refused first, and only
 * a name on the allow-list may proceed. This path's allow-list is empty by construction — it
 * activates nothing at all.
 *
 * It was briefly not empty. When the draft views were believed to be reachable only by clicking a
 * tab toggle, three byte-exact toggle names were punched through this guard, one of which
 * (`Show Ready-to-post drafts`) `isLiveActionName` matches. The views turned out to be directly
 * URL-addressable, so the exception is gone and the guard has no hole. Do not reintroduce one: the
 * Ready-to-post view carries a real `Post` control, and navigation reaches it without ever asking
 * to click anything named like a live action.
 */
const ACTIVATABLE_ACTIONS = Object.freeze([])

function allowedAction(action) {
  if (action === null || typeof action !== 'object' || Array.isArray(action)) return false
  if (isLiveActionName(action.name)) return false
  return ACTIVATABLE_ACTIONS.some(
    (expected) => expected.role === action.role && expected.name === action.name
  )
}

export function createDepopBulkListingCapability(options = {}) {
  const tab = requiredObject(options.tab, 'tab')
  const profile = requiredObject(options.profile, 'profile')
  const bulkListing = requiredObject(profile.bulkListing, 'profile.bulkListing')
  const driver = requireBrowserDriver(tab.driver, 'tab.driver')
  const resolveCsvFile = requiredFunction(options.resolveCsvFile, 'resolveCsvFile')
  const beforeBulkWrite =
    options.beforeBulkWrite === undefined
      ? async () => {}
      : requiredFunction(options.beforeBulkWrite, 'beforeBulkWrite')
  const interactionDelayMs = normalizedDelay(options.interactionDelayMs, 'interactionDelayMs')
  const snapshotPollMs = normalizedTimeout(options.snapshotPollMs, 'snapshotPollMs', SNAPSHOT_POLL_MS)
  const draftViewSettleMs = normalizedTimeout(
    options.draftViewSettleMs,
    'draftViewSettleMs',
    DRAFT_VIEW_SETTLE_MS
  )
  const importPollMs = normalizedTimeout(options.importPollMs, 'importPollMs', IMPORT_POLL_MS)
  const importTimeoutMs = normalizedTimeout(
    options.importTimeoutMs,
    'importTimeoutMs',
    IMPORT_TIMEOUT_MS
  )
  const surfacePollMs = normalizedTimeout(options.surfacePollMs, 'surfacePollMs', SURFACE_POLL_MS)
  const surfaceTimeoutMs = normalizedTimeout(
    options.surfaceTimeoutMs,
    'surfaceTimeoutMs',
    SURFACE_TIMEOUT_MS
  )
  for (const method of ['goto', 'url']) requiredFunction(tab[method], `tab.${method}`)

  const metrics = {
    startedAt: null,
    completedAt: null,
    steps: 0,
    uploadAttempts: 0,
    uploads: 0,
    skuLookups: 0,
    pollRounds: 0,
    driverActions: Object.fromEntries([...PHASES, 'total'].map((name) => [name, 0])),
    navigations: Object.fromEntries([...PHASES, 'total'].map((name) => [name, 0])),
  }
  let phase = 'surface'

  function countDriverAction() {
    metrics.driverActions[phase] += 1
    metrics.driverActions.total += 1
  }

  async function pause() {
    metrics.steps += 1
    if (interactionDelayMs > 0) await delay(interactionDelayMs)
  }

  async function locate(query) {
    countDriverAction()
    return driver.locate(query)
  }

  /** The shim `stableDraftEditUrls` is given, so its reads land in this capability's accounting. */
  const countedDriver = { locate }

  async function goTo(url) {
    metrics.startedAt ??= Date.now()
    if ((await tab.url()) === url) return
    metrics.navigations[phase] += 1
    metrics.navigations.total += 1
    await tab.goto(url)
  }

  async function exactlyOne(query, code, label) {
    const located = await locate(query)
    if (refCount(located) !== 1) throw bulkListingError(code, `Expected exactly one ${label}`)
    return located
  }

  /**
   * Reads the observed post-upload alert. Its success variant has two text children, so the alert's
   * accessible name is their concatenation — matching is substring-against-each-observed-string,
   * never equality against the whole name.
   *
   * `{ found: false }` means no alert is on the surface yet, so the caller can wait for one.
   * `{ found: true, matched: null }` means an alert is present but says something nobody has
   * observed: a changed UI, which must fail closed rather than be read as success.
   */
  async function readUploadAlert() {
    const alerts = await locate(byRole(bulkListing.noticeRole))
    if (refCount(alerts) === 0) return { found: false, matched: null, text: null }
    // Order matters: the errors-found alert also contains the whole per-row list, so it is checked
    // before the accepted text to keep a substring match from straying across variants.
    const variants = [
      ['rejected', bulkListing.rejectedText],
      ['errors_found', bulkListing.errorsFoundText],
      ['platform_error', bulkListing.platformErrorText],
      ['accepted', bulkListing.acceptedText],
    ]
    for (let index = 0; index < refCount(alerts); index += 1) {
      const name = String(refElement(alerts, index).name ?? '')
      for (const [matched, texts] of variants) {
        for (const text of texts) {
          if (name.includes(text)) return { found: true, matched, text }
        }
      }
    }
    return { found: true, matched: null, text: String(refElement(alerts, 0).name ?? '') }
  }

  /**
   * Reads the per-row, per-field validation errors Depop lists under the errors-found alert.
   *
   * Each list item holds exactly two parts in DOM order — the `Row <N> - <Field>` label, then the
   * message. The split is positional, not role-distinguished, so anything other than exactly two
   * parts per item is malformed and reported as such rather than guessed at. Depop's own field
   * labels are inconsistent (`Brand` beside `Field_name.picture_Hero_url`); they pass through
   * verbatim, because flattening that would hide which field the seller has to fix.
   */
  async function readRowErrors() {
    const items = await locate(byCss(bulkListing.rowErrorItemSelector))
    const itemCount = refCount(items)
    if (itemCount === 0) return { entries: [], malformed: false, item_count: 0 }

    const parts = await locate(byCss(bulkListing.rowErrorPartSelector))
    const texts = []
    for (let index = 0; index < refCount(parts); index += 1) {
      texts.push(String(refElement(parts, index).name ?? '').trim())
    }
    if (texts.length !== itemCount * 2) {
      return { entries: [], malformed: true, item_count: itemCount }
    }

    const entries = []
    for (let index = 0; index < texts.length; index += 2) {
      const match = bulkListing.rowErrorLabel.exec(texts[index])
      if (match === null) return { entries: [], malformed: true, item_count: itemCount }
      entries.push({
        reported_row: Number(match[1]),
        field: match[2],
        message: texts[index + 1],
      })
    }
    return { entries, malformed: false, item_count: itemCount }
  }

  /**
   * True while a surface still shows Depop's loading placeholder. Best-effort: the placeholder's
   * element was never mapped, so this scans a candidate-role list. A miss is harmless on draft
   * views — correlation reads the SKU out of each draft rather than trusting novelty, so an
   * undercounted snapshot costs page-opens and can never mis-pair a row.
   */
  async function loadingPlaceholderVisible() {
    if (!nonEmptyString(bulkListing.loadingText)) return false
    for (const role of bulkListing.loadingRoles) {
      const located = await locate(byRole(role))
      for (let index = 0; index < refCount(located); index += 1) {
        if (String(refElement(located, index).name ?? '').includes(bulkListing.loadingText)) {
          return true
        }
      }
    }
    return false
  }

  async function draftTableSettled() {
    return !(await loadingPlaceholderVisible())
  }

  async function waitForDraftTableSettled() {
    const attempts = boundedAttempts(draftViewSettleMs, snapshotPollMs)
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (await draftTableSettled()) return true
      if (attempt < attempts - 1 && snapshotPollMs > 0) await delay(snapshotPollMs)
    }
    return false
  }

  function surfaceMessage(observed, waitedMs) {
    return (
      `Observed ${observed.triggerCount} upload trigger(s), ` +
      `${observed.inputCount} file input(s), loading placeholder ` +
      `${observed.loadingVisible ? 'visible' : 'absent'} after ${waitedMs}ms`
    )
  }

  /**
   * Opens one draft view by URL and confirms the browser actually landed on it.
   *
   * The check is strict equality against that view's own path, not merely "some drafts surface".
   * A redirect back to the default view would otherwise read one view twice while reporting that
   * all three were covered — a silent miss, which is the failure mode this whole design refuses.
   */
  async function openDraftView(view) {
    await goTo(view.url)
    const landed = sameOriginUrl(await tab.url(), profile, 'Draft view')
    if (landed.pathname !== view.path) {
      throw bulkListingError(
        'bulk_listing_view_not_addressable',
        `The ${view.id} draft view did not load at its own path`
      )
    }
    await pause()
  }

  async function readDraftSkuAt(url) {
    const canonical = sameOriginUrl(url, profile, 'Draft')
    if (!profile.draftPathPattern.test(canonical.pathname)) {
      throw bulkListingError('bulk_listing_draft_url_invalid', 'Draft URL is not a stable identity')
    }
    await goTo(canonical.toString())
    await exactlyOne(byRole('heading', 'Draft'), 'bulk_listing_draft_not_open', 'draft heading')
    const field = await exactlyOne(
      byRole(profile.fields.sku.role, profile.fields.sku.label),
      'bulk_listing_draft_sku_ambiguous',
      'draft SKU field'
    )
    const sku = String(refElement(field).value ?? '')
    metrics.skuLookups += 1
    await pause()
    return { listing_url: canonical.toString(), sku }
  }

  return Object.freeze({
    metrics() {
      return {
        interaction_delay_ms: interactionDelayMs,
        snapshot_poll_ms: snapshotPollMs,
        draft_view_settle_ms: draftViewSettleMs,
        surface_poll_ms: surfacePollMs,
        surface_timeout_ms: surfaceTimeoutMs,
        import_timeout_ms: importTimeoutMs,
        elapsed_ms:
          metrics.startedAt === null ? 0 : (metrics.completedAt ?? Date.now()) - metrics.startedAt,
        steps: metrics.steps,
        upload_attempts: metrics.uploadAttempts,
        uploads: metrics.uploads,
        sku_lookups: metrics.skuLookups,
        poll_rounds: metrics.pollRounds,
        driver_actions: { ...metrics.driverActions },
        navigations: { ...metrics.navigations },
      }
    },

    pollingPlan() {
      return { poll_interval_ms: importPollMs, timeout_ms: importTimeoutMs }
    },

    async waitBeforeNextPoll() {
      metrics.pollRounds += 1
      if (importPollMs > 0) await delay(importPollMs)
    },

    /** Opens the platform's own bulk-listing page. Nothing is written by navigating. */
    async navigate() {
      phase = 'surface'
      await goTo(sameOriginUrl(bulkListing.url, profile, 'Bulk listing').toString())
      await pause()
    },

    /**
     * Confirms the page identity before any data leaves the host. The path check is immediate:
     * a wrong URL is not a hydration state. On the right path, inspection polls until the rendered
     * surface exposes exactly one upload trigger and exactly one file control. A timeout with no
     * rendered surface is `bulk_listing_surface_loading`; a rendered-but-wrong shape keeps the
     * existing unrecognized/ambiguous codes with the observed counts.
     */
    async inspectBulkListingSurface() {
      phase = 'surface'
      const current = sameOriginUrl(await tab.url(), profile, 'Browser surface')
      if (current.pathname !== bulkListing.path) {
        throw bulkListingError(
          'bulk_listing_surface_unrecognized',
          'The browser is not on the bulk-listing page'
        )
      }
      const attempts = boundedAttempts(surfaceTimeoutMs, surfacePollMs)
      let observed = null
      let triggerSeen = false
      let surfaceSeen = false
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const trigger = await locate(byRole(bulkListing.trigger.role, bulkListing.trigger.name))
        const inputs = await locate(byRole(bulkListing.fileInput.role))
        const loadingVisible = await loadingPlaceholderVisible()
        observed = {
          triggerCount: refCount(trigger),
          inputCount: refCount(inputs),
          loadingVisible,
        }
        triggerSeen ||= observed.triggerCount > 0
        surfaceSeen ||= observed.triggerCount > 0 || observed.inputCount > 0
        // The trigger + file control pair is the page's identity. The loading placeholder is a
        // best-effort draft-list heuristic, so it only explains a timeout — it never vetoes a
        // surface that already shows exactly one of each.
        if (observed.triggerCount === 1 && observed.inputCount === 1) {
          await pause()
          return {
            url: current.toString(),
            accept: bulkListing.accept,
            multiple: bulkListing.multiple,
            trigger_activated: false,
          }
        }
        // Not yet the expected shape — still hydrating, or a transient extra node — so wait and
        // re-read; the verdict below is only reached once the whole budget is spent.
        if (attempt < attempts - 1 && surfacePollMs > 0) await delay(surfacePollMs)
      }
      const waitedMs = Math.max(0, attempts - 1) * surfacePollMs
      if (!triggerSeen && (observed?.loadingVisible === true || !surfaceSeen)) {
        throw bulkListingError(
          'bulk_listing_surface_loading',
          `Bulk-listing surface was still loading. ${surfaceMessage(observed, waitedMs)}`
        )
      }
      if (observed?.triggerCount !== 1) {
        throw bulkListingError(
          'bulk_listing_surface_unrecognized',
          `Expected exactly one upload trigger. ${surfaceMessage(observed, waitedMs)}`
        )
      }
      if (observed.inputCount !== 1) {
        throw bulkListingError(
          'bulk_listing_file_input_ambiguous',
          `The bulk-listing page does not expose exactly one file control. ` +
            surfaceMessage(observed, waitedMs)
        )
      }
      throw bulkListingError(
        'bulk_listing_surface_unrecognized',
        `Bulk-listing surface did not settle. ${surfaceMessage(observed, waitedMs)}`
      )
    },

    /**
     * Every stable draft identity currently visible, across every declared view. Each view is
     * opened by its own URL — a snapshot that only loaded the entry point would see the Incomplete
     * view alone and miss a Ready-to-post row — and the landed path is checked against that view's
     * own path so a redirect cannot pass as coverage. A view still rendering its loading
     * placeholder is polled for `draftViewSettleMs`; only after that bounded wait is it skipped
     * rather than read as an empty view.
     */
    async snapshotDraftUrls() {
      phase = 'snapshot'
      const urls = new Set()
      const pending = []
      for (const view of bulkListing.draftViews) {
        await openDraftView(view)
        if (!(await waitForDraftTableSettled())) {
          pending.push(view.id)
          continue
        }
        for (const url of await stableDraftEditUrls(countedDriver, profile, {
          pollMs: snapshotPollMs,
        })) {
          urls.add(url)
        }
        await pause()
      }
      return { urls: [...urls].sort(), pending_views: pending }
    },

    /**
     * Delivers exactly one marketplace CSV to the page's own file control. The platform's input
     * declares a single-file limit, so a request carrying more than one file is refused before
     * anything is delivered rather than being split or truncated. The file's bytes are never read
     * here: the host resolves a path, and what is inside it is the exporting product's contract.
     */
    async uploadCsv(request = {}) {
      phase = 'upload'
      await beforeBulkWrite()
      const files = await resolveCsvFile(request)
      if (!Array.isArray(files) || files.length === 0 || !files.every(nonEmptyString)) {
        throw bulkListingError(
          'bulk_listing_file_unresolved',
          'The host resolved no readable CSV file for this batch'
        )
      }
      if (files.length !== 1) {
        throw bulkListingError(
          'bulk_listing_single_file_required',
          'The bulk-listing control accepts exactly one file per upload'
        )
      }
      const rowCount = request.row_count
      if (Number.isInteger(rowCount) && rowCount > bulkListing.maxListings) {
        throw bulkListingError(
          'bulk_listing_too_many_rows',
          `The platform's template allows at most ${bulkListing.maxListings} listings per file; ` +
            `this batch has ${rowCount}`
        )
      }
      if (!files[0].toLowerCase().endsWith(bulkListing.accept)) {
        throw bulkListingError(
          'bulk_listing_file_type_refused',
          `The bulk-listing control accepts only ${bulkListing.accept} files`
        )
      }

      const input = await locate(byRole(bulkListing.fileInput.role))
      if (refCount(input) !== 1) {
        throw bulkListingError(
          'bulk_listing_file_input_ambiguous',
          'The bulk-listing page does not expose exactly one file control'
        )
      }
      const trigger = await exactlyOne(
        byRole(bulkListing.trigger.role, bulkListing.trigger.name),
        'bulk_listing_surface_unrecognized',
        'upload trigger'
      )
      countDriverAction()
      metrics.uploadAttempts += 1
      const delivered = await driver.uploadFiles(refAt(input, 0), files, { trigger })
      metrics.uploads += 1
      await pause()
      return { uploaded_file_count: 1, control_accepts_multiple: delivered?.multiple === true }
    },

    /**
     * Reads the post-upload alert and, on the errors-found variant, the per-row error list beneath
     * it. This is an expected, required step — the alert's role is observed, and it is waited for —
     * but it is deliberately not fatal: an absent or unrecognized alert degrades to
     * `accepted: null` and lets per-SKU polling decide, because refusing to run when the platform
     * redesigns a banner would be worse than reporting what correlation actually finds, and nothing
     * gets marked published either way.
     *
     * Four terminal outcomes, only one of which creates anything: headers-don't-match
     * (`notice: 'rejected'`, nothing imported, no detail), errors-found
     * (`notice: 'errors_found'`, nothing imported, `row_errors` listed synchronously per row and
     * field), platform-error (`notice: 'platform_error'`, nothing imported, no detail, and the
     * platform itself invites a retry), and accepted (`notice: 'accepted'`, asynchronous import
     * begins).
     *
     * Passing field validation and beginning an import are different events: the platform-error
     * state is what a file looks like when it clears validation and then fails during processing.
     * Only the accepted banner indicates the second.
     *
     * An accepted file is still not a promise that every row becomes a draft — the platform creates
     * drafts in the background and emails the seller. See the workflow's `pending_at_timeout`.
     */
    async confirmUploadAccepted() {
      phase = 'notice'
      let alert = await readUploadAlert()
      for (let attempt = 0; !alert.found && attempt < NOTICE_ATTEMPTS; attempt += 1) {
        if (snapshotPollMs > 0) await delay(snapshotPollMs)
        alert = await readUploadAlert()
      }
      await pause()

      if (alert.matched === 'rejected') {
        return { accepted: false, message: alert.text, notice: 'rejected', asynchronous: false }
      }
      if (alert.matched === 'errors_found') {
        const rowErrors = await readRowErrors()
        return {
          accepted: false,
          message: alert.text,
          notice: 'errors_found',
          asynchronous: false,
          row_errors: rowErrors.entries,
          row_errors_malformed: rowErrors.malformed,
        }
      }
      if (alert.matched === 'platform_error') {
        // Depop's own wording invites a retry, so the caller is told one is reasonable — but the
        // decision stays with the human: a generic error gives no way to know whether anything
        // landed, and re-uploading duplicates whatever did.
        return {
          accepted: false,
          message: alert.text,
          notice: 'platform_error',
          asynchronous: false,
          retry_suggested: true,
        }
      }
      if (alert.matched === 'accepted') {
        return { accepted: true, message: alert.text, notice: 'accepted', asynchronous: true }
      }
      // A diagnosis for the caller to surface, not a verdict on the upload.
      return {
        accepted: null,
        message: null,
        notice: alert.found ? 'unrecognized' : 'missing',
        observed_text: alert.found ? String(alert.text ?? '').slice(0, 200) : null,
        asynchronous: false,
      }
    },

    /** Opens one draft identity and reads the SKU the importer wrote into it. */
    async readDraftSku(url) {
      phase = 'correlation'
      return readDraftSkuAt(url)
    },

    /**
     * Refuses every action. The allow-list is empty because this path activates nothing at all, and
     * a live-sounding name is refused before the allow-list is even consulted. Exposed so a caller
     * can assert the refusal rather than having to trust that nothing is reachable.
     */
    async activate(action) {
      if (!allowedAction(action)) {
        throw bulkListingError(
          'browser_action_refused',
          'The bulk-listing path activates no browser control'
        )
      }
      throw bulkListingError('browser_action_refused', 'No bulk-listing action is activatable')
    },

    complete() {
      metrics.completedAt = Date.now()
    },
  })
}
