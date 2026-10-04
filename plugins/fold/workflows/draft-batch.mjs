import {
  confirmAndVerifyDraft,
  planCandidates,
  planPublicationBatch,
  saveAndVerifyDraft,
} from './lifecycle.mjs'

/**
 * Private drafts for every ready listing on a marketplace with no bulk path (Vinted US: no CSV
 * import, no public listing API), driven in host-sized steps.
 *
 * A host runs code in calls with a time limit (Codex: about a minute), and one form transaction can
 * take a good share of that. So the batch is a report that the host carries between calls:
 *
 * 1. `runDraftBatch({ adapter, readyListings })` — `readyListings` is the `list_ready_listings`
 *    result the host fetched through its Fold connector. One draft is created (`maxDrafts`, default
 *    1) and the report is returned.
 * 2. For every entry in `report.to_record` the host calls Fold's `mark_published` through its own
 *    connector, then folds the answer in with `recordDraftResult(report, listingId, foldResult)`.
 *    This workflow never calls Fold: like the Depop bulk path, it returns what to record.
 * 3. While `report.next` is `'continue'`, call `runDraftBatch` again with `resumeFrom: report`.
 *
 * Duplicate prevention: a listing the report has already reached is never drafted again. Before a
 * listing's form is opened its item is written as `in_progress` and handed to `persist`, so a host
 * call that dies mid-transaction (a timeout resets the REPL) leaves a durable trace: on resume that
 * listing is `needs_manual_check`, never re-created, because Save draft may already have been
 * pressed. Fold's own ledger covers the rest: a recorded listing leaves `list_ready_listings`.
 */
export const DRAFT_BATCH_OUTCOMES = Object.freeze({
  inProgress: 'in_progress',
  draftVerified: 'draft_verified',
  recorded: 'recorded',
  draftUnrecorded: 'draft_unrecorded',
  rejected: 'rejected',
  failed: 'failed',
  ambiguous: 'ambiguous',
  blocked: 'blocked',
  needsManualCheck: 'needs_manual_check',
  existingDraft: 'existing_draft',
  awaitingConfirmation: 'awaiting_save_confirmation',
})

/** Calls that may look for a pressed-but-unconfirmed save before it is handed to the seller. */
const MAX_CONFIRM_ATTEMPTS = 3

/**
 * Stamped on every report. A report from another version of this workflow — or any other file a
 * host happens to have at the same path — is refused rather than resumed: resuming carries its
 * items forward, so a stale report would silently skip every listing it already names.
 */
export const DRAFT_BATCH_REPORT_VERSION = 'fold-draft-batch/2'

const O = DRAFT_BATCH_OUTCOMES
/** Outcomes that stop the run: the marketplace may hold state nobody has accounted for. */
const STOPPING = new Set([O.ambiguous, O.blocked, O.needsManualCheck])
const AWAITING_RECORD = new Set([O.draftVerified, O.draftUnrecorded])

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

/** Recomputes what is left to do: record first, then stop or continue. */
function summarize(report) {
  report.to_record = report.items
    .filter((item) => AWAITING_RECORD.has(item.outcome))
    .map((item) => ({ listing_id: item.listing_id, listing_url: item.draft_url }))
  const stopped = report.items.some((item) => STOPPING.has(item.outcome))
  const awaiting = report.items.some((item) => item.outcome === O.awaitingConfirmation)
  if (report.to_record.length > 0) report.next = 'record'
  else if (stopped) report.next = 'stop'
  else if (awaiting) report.next = 'confirm'
  else if (report.pending_listings.length > 0) report.next = 'continue'
  else report.next = 'done'
  report.outcome = { done: 'completed', stop: 'stopped' }[report.next] ?? 'in_progress'
  return report
}

/** Seller-facing notes an adapter attached, e.g. Vinted's request for authenticity photos. */
function noteFields(notes) {
  const fields = {}
  if (typeof notes?.authenticity_hint === 'string') fields.authenticity_hint = notes.authenticity_hint
  if (
    notes?.brand_id_fallback !== null &&
    typeof notes?.brand_id_fallback === 'object' &&
    typeof notes.brand_id_fallback.brand_id === 'string' &&
    ['name_match', 'custom'].includes(notes.brand_id_fallback.selected)
  ) {
    fields.brand_id_fallback = {
      brand_id: notes.brand_id_fallback.brand_id,
      selected: notes.brand_id_fallback.selected,
    }
  }
  return fields
}

function failedItem(failed) {
  const saveOutcome = failed.save_outcome
  let outcome = O.failed
  if (saveOutcome === 'blocked_precondition') outcome = O.blocked
  else if (saveOutcome === 'existing_draft') outcome = O.existingDraft
  else if (saveOutcome === 'awaiting_save_confirmation') outcome = O.awaitingConfirmation
  else if (saveOutcome === 'ambiguous_save' || saveOutcome === 'draft_saved') outcome = O.ambiguous
  const item = {
    listing_id: failed.listing_id,
    outcome,
    failure_code: failed.failure_code ?? 'draft_failed',
    reason: failed.reason,
  }
  if (typeof failed.canonical_url === 'string') item.draft_url = failed.canonical_url
  if (Array.isArray(failed.candidates)) item.candidates = [...failed.candidates]
  // A pressed-but-unconfirmed save keeps what was entered (labels and ids, nothing secret), so the
  // call that confirms it — even after a REPL reset — verifies every field.
  if (outcome === O.awaitingConfirmation && failed.expected_fields) item.expected_fields = failed.expected_fields
  Object.assign(item, noteFields(failed.notes))
  return item
}

function resumedReport(resumeFrom, platform) {
  assertObject(resumeFrom, 'resumeFrom')
  if (resumeFrom.report_version !== DRAFT_BATCH_REPORT_VERSION) {
    throw new TypeError(
      `resumeFrom is not a ${DRAFT_BATCH_REPORT_VERSION} report (it may be left over from an ` +
        'earlier run or plugin version); start a fresh run without resumeFrom'
    )
  }
  if (resumeFrom.platform !== platform || !Array.isArray(resumeFrom.items)) {
    throw new TypeError(`resumeFrom must be a ${platform} draft-batch report`)
  }
  const report = clone(resumeFrom)
  for (const item of report.items) {
    // A transaction that never reported back may have pressed Save draft.
    if (item.outcome === O.inProgress) {
      item.outcome = O.needsManualCheck
      item.reason =
        'The call creating this draft ended before it reported back, so a draft may exist; check ' +
        'the marketplace drafts before running this listing again'
    }
  }
  return report
}

/**
 * Creates up to `maxDrafts` drafts and returns the updated report. Never calls Fold. `persist`, when
 * given, receives the report (a plain JSON value) every time it changes — including just before a
 * form transaction starts — so the host can keep it outside a REPL that may reset.
 */
export async function runDraftBatch({
  adapter,
  readyListings,
  resumeFrom,
  maxDrafts = 1,
  persist = async () => {},
  resolveInference,
} = {}) {
  assertObject(adapter, 'adapter')
  assertObject(readyListings, 'readyListings (the list_ready_listings result)')
  if (!Number.isInteger(maxDrafts) || maxDrafts < 1) {
    throw new TypeError('maxDrafts must be a positive integer')
  }
  if (typeof persist !== 'function') throw new TypeError('persist must be a function')

  const plan = await planPublicationBatch(readyListings, adapter)
  const report =
    resumeFrom === undefined || resumeFrom === null
      ? {
        report_version: DRAFT_BATCH_REPORT_VERSION,
        platform: plan.platform,
        started_at: new Date().toISOString(),
        items: [],
        pending_listings: [],
      }
      : resumedReport(resumeFrom, plan.platform)
  const reached = new Set(report.items.map((item) => item.listing_id))
  for (const rejected of plan.rejected_candidates) {
    if (rejected.listing_id !== null && reached.has(rejected.listing_id)) continue
    report.items.push({ listing_id: rejected.listing_id, outcome: O.rejected, reason: rejected.reason })
    if (rejected.listing_id !== null) reached.add(rejected.listing_id)
  }
  const pending = planCandidates(plan).filter((listing) => !reached.has(listing.listing_id))
  report.pending_listings = pending.map((listing) => listing.listing_id)
  summarize(report)
  await persist(clone(report))

  // `maxDrafts` counts transactions attempted, failed ones included, so a call does a bounded amount
  // of browser work however its items turn out.
  // A save pressed in an earlier call but not yet seen in the wardrobe is resolved first, by
  // looking — never by saving again. It is this call's one transaction.
  const awaiting = report.items.find((item) => item.outcome === O.awaitingConfirmation)
  if (awaiting !== undefined) {
    const listingId = awaiting.listing_id
    const expectedFields = awaiting.expected_fields
    const listing = planCandidates(plan).find((candidate) => candidate.listing_id === listingId)
    const attempts = (awaiting.confirm_attempts ?? 0) + 1
    const result =
      listing === undefined ? null : await confirmAndVerifyDraft({ adapter, listing, expectedFields })
    for (const key of Object.keys(awaiting)) delete awaiting[key]
    if (result?.outcome === 'draft_verified') {
      Object.assign(
        awaiting,
        { listing_id: listingId, outcome: O.draftVerified, draft_url: result.canonical_url },
        noteFields(result.notes)
      )
    } else {
      const failed = result === null
        ? {
          failure_code: 'listing_no_longer_ready',
          save_outcome: 'ambiguous_save',
          reason: 'The listing left the ready set before its save was confirmed',
        }
        : result.failed_listing
      Object.assign(awaiting, failedItem({ ...failed, listing_id: listingId }))
      if (awaiting.outcome === O.awaitingConfirmation) {
        awaiting.confirm_attempts = attempts
        if (expectedFields) awaiting.expected_fields = expectedFields
        if (attempts >= MAX_CONFIRM_ATTEMPTS) {
          awaiting.outcome = O.ambiguous
          awaiting.reason = `Save draft was pressed but the draft never appeared in the wardrobe: ${awaiting.reason}`
        }
      }
    }
    summarize(report)
    await persist(clone(report))
    return report
  }

  let drafted = 0
  for (const listing of pending) {
    if (drafted >= maxDrafts || report.next !== 'continue') break
    const item = { listing_id: listing.listing_id, outcome: O.inProgress }
    report.items.push(item)
    report.pending_listings = report.pending_listings.filter((id) => id !== listing.listing_id)
    await persist(clone(report))

    const draft = await saveAndVerifyDraft({ adapter, listing, resolveInference })
    drafted += 1
    if (draft.outcome === 'draft_verified') {
      Object.assign(item, { outcome: O.draftVerified, draft_url: draft.canonical_url }, noteFields(draft.notes))
      if (draft.external_identity !== null) item.external_identity = draft.external_identity
    } else {
      for (const key of Object.keys(item)) delete item[key]
      Object.assign(item, failedItem(draft.failed_listing))
    }
    summarize(report)
    await persist(clone(report))
  }
  return report
}

/**
 * Folds one `mark_published` answer into the report and returns the new report. `published` and
 * `already_published` record the draft; anything else — a refusal, or the error the host's call
 * threw — leaves it `draft_unrecorded`: still in `to_record`, and never drafted again.
 */
export function recordDraftResult(report, listingId, foldResult) {
  assertObject(report, 'report')
  const next = clone(report)
  const item = next.items.find((entry) => entry.listing_id === listingId)
  if (item === undefined || !AWAITING_RECORD.has(item.outcome)) {
    throw new Error(`Listing ${listingId} has no verified draft awaiting recording`)
  }
  const outcome = foldResult?.outcome
  if (outcome === 'published' || outcome === 'already_published') {
    item.outcome = O.recorded
    item.fold_outcome = outcome
    delete item.reason
  } else {
    item.outcome = O.draftUnrecorded
    item.reason =
      foldResult instanceof Error
        ? `Fold could not record the draft: ${foldResult.message}`
        : `Fold refused the draft: ${outcome ?? 'unknown'}`
  }
  return summarize(next)
}

/**
 * Records a draft that already exists on the marketplace instead of creating another — for a
 * listing reported `existing_draft`, `ambiguous` or `needs_manual_check`, once the seller has
 * confirmed which draft is this listing's. `draftUrl` must be one of the item's own `candidates`
 * when it has any. The item moves to `draft_verified` and into `to_record`.
 */
export function acceptExistingDraft(report, listingId, draftUrl) {
  assertObject(report, 'report')
  const next = clone(report)
  const item = next.items.find((entry) => entry.listing_id === listingId)
  if (
    item === undefined ||
    ![O.existingDraft, O.ambiguous, O.needsManualCheck, O.awaitingConfirmation].includes(item.outcome)
  ) {
    throw new Error(`Listing ${listingId} has no existing or uncertain draft to accept`)
  }
  if (Array.isArray(item.candidates) && !item.candidates.includes(draftUrl)) {
    throw new Error(`${draftUrl} is not one of the drafts found for listing ${listingId}`)
  }
  item.outcome = O.draftVerified
  item.draft_url = draftUrl
  item.accepted_existing = true
  delete item.reason
  delete item.failure_code
  return summarize(next)
}
