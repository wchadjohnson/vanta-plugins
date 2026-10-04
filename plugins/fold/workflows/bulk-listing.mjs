/**
 * Shared workflow for handing a marketplace CSV to a resale platform's own bulk-listing page.
 *
 * The capability owns the browser; this owns ordering, the bounded wait, correlation and reporting.
 * It makes no Fold call: it returns one `{ listing_id, listing_url }` pair per correlated row so
 * the caller can record each one individually. A batch-level URL is never produced, and a row whose
 * SKU is not found is returned unresolved rather than attached to somebody else's draft.
 *
 * Upload has three mutually exclusive outcomes, and only one creates anything. Bad headers are
 * refused outright. Rows that fail the platform's own validation are also refused as a whole file,
 * with per-row per-field errors listed synchronously — better evidence than any amount of polling,
 * since those rows will never appear. Only an accepted file imports, asynchronously and
 * email-notified, publishing no per-row outcome of its own; for that case the per-row outcome is
 * per-SKU appearance in the draft surfaces, polled, bounded by a timeout, and reported as
 * still-pending rather than failed when the budget runs out.
 *
 * Correlation identifier. The CSV's SKU cell carries the piece code, and that is the only string
 * the platform can echo back. The sold-email reference token never reaches the CSV, so a batch that
 * supplies one as a SKU is refused outright — searching for it would quietly match nothing.
 *
 * Because a row is paired to a URL by the SKU read out of the draft itself, never by the draft
 * being new, an undercounted baseline snapshot cannot mis-pair anything. It can only add page-opens
 * and show up in `uncorrelated_draft_count`.
 *
 * The CSV's bytes are never read or transformed here. Producing a file the platform will accept,
 * including any template preamble the platform requires, belongs to the exporting product.
 */

const REFERENCE_TOKEN_SHAPE = /^FOLD-SOLD-/i
const PENDING_REASON =
  'no draft with this SKU appeared before the import timeout; the platform may still be processing'
const AMBIGUOUS_REASON = 'more than one imported draft carries this SKU'
const REJECTED_REASON = 'the platform rejected the uploaded file, so no draft was created'
const FILE_REJECTED_REASON =
  'the file was rejected as a whole, so no draft was created for this row; fix the flagged rows ' +
  'and re-upload the whole file'
const ROW_REJECTED_REASON =
  'the platform reported validation errors for this row; fix the listed fields and re-upload the ' +
  'whole file'
const PLATFORM_ERROR_REASON =
  'the platform failed while processing the file and created nothing for this row; it reports no ' +
  'detail, and it suggests uploading the file again'

/**
 * Maps a platform-reported row number back to a batch row.
 *
 * The platform numbers rows by position in the uploaded file, counting whatever preamble and header
 * lines precede the data. That offset is declared by whoever produced the file — `first_data_line`
 * — rather than computed here: finding it would mean counting lines in a CSV whose description
 * column may carry embedded newlines, so a physical-line count could be silently wrong for exactly
 * the listings most likely to have them, and a wrong offset attaches an error to the wrong listing.
 *
 * Note also that a single sample cannot distinguish "the platform counts physical lines" from "the
 * platform counts records and adds the same offset"; the range check below makes the difference
 * safe either way, and neither semantics is claimed.
 *
 * With no declaration, nothing is mapped: errors are reported verbatim and unattributed. This also
 * assumes `batch.rows` is in the same order as the file's data rows, which the producing side
 * guarantees and no page observation can confirm.
 */
function mapReportedRow(reportedRow, batch) {
  const firstDataLine = batch.first_data_line
  if (!Number.isInteger(firstDataLine) || firstDataLine < 1) return null
  const index = reportedRow - firstDataLine
  if (!Number.isInteger(index) || index < 0 || index >= batch.rows.length) return null
  return batch.rows[index]
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value
}

function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`)
  return value
}

function batchError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function nullableString(value) {
  return nonEmptyString(value) ? value : null
}

function normalizedAwaitingConfirmation(entries) {
  const awaiting = []
  let malformed = 0
  if (!Array.isArray(entries)) return { awaiting, malformed_count: 0 }
  for (const entry of entries) {
    if (
      entry !== null &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      nonEmptyString(entry.listing_id) &&
      nonEmptyString(entry.sku) &&
      typeof entry.delivered === 'boolean'
    ) {
      awaiting.push({
        listing_id: entry.listing_id,
        sku: entry.sku,
        delivered: entry.delivered,
        submitted_at: nonEmptyString(entry.submitted_at) ? entry.submitted_at : null,
      })
    } else {
      malformed += 1
    }
  }
  return { awaiting, malformed_count: malformed }
}

/** The lease fields Fold's export carries (vanta-fold#367), validated; malformed rows are counted, not trusted. */
export function normalizedExportLease(payload = {}) {
  const normalized = normalizedAwaitingConfirmation(payload.awaiting_confirmation)
  return {
    submission_id: nullableString(payload.submission_id),
    lease_expires_at: nullableString(payload.lease_expires_at),
    awaiting_confirmation: normalized.awaiting,
    awaiting_confirmation_malformed_count: normalized.malformed_count,
  }
}

/**
 * Checks everything that can be known before a byte leaves the host. Correlation soundness rests on
 * SKU uniqueness inside one file, which holds because each exported file covers one marketplace.
 */
export function validateCsvImportBatch(batch) {
  assertObject(batch, 'batch')
  if (!nonEmptyString(batch.marketplace)) {
    throw batchError('bulk_listing_marketplace_missing', 'The batch names no marketplace')
  }
  if (!Array.isArray(batch.rows) || batch.rows.length === 0) {
    throw batchError('bulk_listing_rows_missing', 'The batch carries no rows')
  }

  const seenSkus = new Set()
  const seenListings = new Set()
  for (const row of batch.rows) {
    assertObject(row, 'batch row')
    if (!nonEmptyString(row.listing_id)) {
      throw batchError('bulk_listing_listing_id_missing', 'A batch row has no listing id')
    }
    if (!nonEmptyString(row.sku)) {
      throw batchError('bulk_listing_sku_missing', `Row ${row.listing_id} has no SKU to correlate on`)
    }
    if (REFERENCE_TOKEN_SHAPE.test(row.sku)) {
      throw batchError(
        'bulk_listing_sku_is_reference_token',
        `Row ${row.listing_id} supplied a sold-email reference token as its SKU; the CSV carries ` +
          'the piece code instead'
      )
    }
    if (seenSkus.has(row.sku)) {
      throw batchError(
        'bulk_listing_duplicate_sku',
        'Two rows share one SKU, so imported drafts could not be told apart'
      )
    }
    if (seenListings.has(row.listing_id)) {
      throw batchError('bulk_listing_duplicate_listing', 'Two rows name the same listing')
    }
    seenSkus.add(row.sku)
    seenListings.add(row.listing_id)
  }

  return batch
}

function assertCapability(capability) {
  assertObject(capability, 'capability')
  for (const method of [
    'navigate',
    'inspectBulkListingSurface',
    'snapshotDraftUrls',
    'uploadCsv',
    'confirmUploadAccepted',
    'readDraftSku',
    'pollingPlan',
    'waitBeforeNextPoll',
  ]) {
    if (typeof capability[method] !== 'function') {
      throw new TypeError(`capability.${method} must be a function`)
    }
  }
  return capability
}

/**
 * Proves the bulk-listing page usable before anything is exported. Fold leases rows the moment it
 * exports them, so exporting before the page is usable can leave a listing held with nothing
 * uploaded. Browser failures come back as `surface_unavailable` with their stable code; only
 * programmer misuse throws.
 */
export async function prepareBulkListingSurface({ capability } = {}) {
  assertCapability(capability)
  try {
    await capability.navigate()
    const surface = await capability.inspectBulkListingSurface()
    return { outcome: 'surface_ready', surface }
  } catch (error) {
    if (error instanceof TypeError) throw error
    return {
      outcome: 'surface_unavailable',
      failure_code: typeof error?.code === 'string' ? error.code : 'bulk_listing_surface_unavailable',
      reason: error instanceof Error ? error.message : String(error),
      browser_metrics: capability.metrics?.() ?? null,
    }
  }
}

function failure(batch, error, extra = {}) {
  return {
    outcome: 'import_failed',
    marketplace: typeof batch?.marketplace === 'string' ? batch.marketplace : null,
    row_count: Array.isArray(batch?.rows) ? batch.rows.length : 0,
    failure_code: typeof error?.code === 'string' ? error.code : 'bulk_listing_failed',
    reason: error instanceof Error ? error.message : String(error),
    imported: [],
    unresolved: [],
    ...extra,
  }
}

/**
 * Waits, boundedly, for the platform to file the drafts it accepted, reading the SKU out of each
 * newly seen draft exactly once. Caching by URL is what keeps the cost one page-open per imported
 * draft however many polling rounds the wait takes.
 */
async function correlateBySku(capability, before, wantedSkus, now) {
  const { timeout_ms: timeoutMs } = capability.pollingPlan()
  const deadline = now() + timeoutMs
  const urlsBySku = new Map()
  const ambiguousSkus = new Set()
  const readUrls = new Set()
  let pendingViews = []
  let rounds = 0

  for (;;) {
    rounds += 1
    const snapshot = await capability.snapshotDraftUrls()
    pendingViews = snapshot.pending_views ?? []
    for (const url of snapshot.urls) {
      if (before.has(url) || readUrls.has(url)) continue
      readUrls.add(url)
      const observed = await capability.readDraftSku(url)
      const sku = observed?.sku
      if (!nonEmptyString(sku)) continue
      if (urlsBySku.has(sku)) ambiguousSkus.add(sku)
      else urlsBySku.set(sku, observed.listing_url)
    }

    if ([...wantedSkus].every((sku) => urlsBySku.has(sku))) break
    if (now() >= deadline) break
    await capability.waitBeforeNextPoll()
  }

  return { urlsBySku, ambiguousSkus, newDraftCount: readUrls.size, pendingViews, rounds }
}

const RECONCILE_UNMATCHED_REASON =
  'no draft with this SKU was found inside the reconciliation read budget'

function awaitingRows(entries) {
  return Array.isArray(entries)
    ? entries.filter(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        nonEmptyString(entry.listing_id) &&
        nonEmptyString(entry.sku) &&
        typeof entry.delivered === 'boolean'
    )
    : []
}

/**
 * Next-run reconciliation for rows an earlier courier delivered but never matched to a draft
 * (`awaiting_confirmation` entries with `delivered: true` on Fold's export). Each is looked for by
 * SKU across every draft view, with the same rules as `importCsvBatch`'s correlation: one URL per
 * SKU, two drafts carrying one SKU is ambiguous, nothing is ever guessed. Rows still leased and
 * undelivered (`delivered: false`) belong to an export in flight and are never touched.
 *
 * Bounded by `maxDraftReads` page-opens. `knownUrls` (url -> sku) lets drafts this run already read
 * count without being reopened. Browser errors never throw: what was matched before the error is
 * still returned, with `outcome: 'reconcile_failed'`.
 */
export async function reconcileDeliveredRows({
  capability,
  awaiting,
  maxDraftReads = 60,
  knownUrls = new Map(),
} = {}) {
  assertCapability(capability)
  if (!Number.isInteger(maxDraftReads) || maxDraftReads < 0) {
    throw new TypeError('maxDraftReads must be a non-negative integer')
  }
  if (!(knownUrls instanceof Map)) throw new TypeError('knownUrls must be a Map')
  const rows = awaitingRows(awaiting)
  const wanted = new Map(rows.filter((row) => row.delivered).map((row) => [row.sku, row]))
  const urlsBySku = new Map()
  const ambiguousSkus = new Set()
  const readUrls = new Set()
  const pendingViews = new Set()
  let draftReads = 0
  let failure = null

  function remember(url, sku) {
    if (!wanted.has(sku)) return
    if (urlsBySku.has(sku) && urlsBySku.get(sku) !== url) ambiguousSkus.add(sku)
    else urlsBySku.set(sku, url)
  }

  if (wanted.size > 0) {
    try {
      // One snapshot pass, then one more only if it surfaced a URL not yet read: a draft list does
      // not change while it is being read, so a third pass would only spend the budget.
      for (;;) {
        const snapshot = await capability.snapshotDraftUrls()
        for (const view of snapshot.pending_views ?? []) pendingViews.add(view)
        let sawNewUrl = false
        for (const url of snapshot.urls ?? []) {
          if (knownUrls.has(url)) {
            remember(url, knownUrls.get(url))
            continue
          }
          if (readUrls.has(url) || draftReads >= maxDraftReads) continue
          sawNewUrl = true
          readUrls.add(url)
          draftReads += 1
          const observed = await capability.readDraftSku(url)
          if (nonEmptyString(observed?.sku)) {
            remember(nonEmptyString(observed.listing_url) ? observed.listing_url : url, observed.sku)
          }
        }
        const settled = [...wanted.keys()].every((sku) => urlsBySku.has(sku))
        if (settled || draftReads >= maxDraftReads || !sawNewUrl) break
      }
    } catch (error) {
      failure = {
        failure_code: typeof error?.code === 'string' ? error.code : 'bulk_listing_reconcile_failed',
        reason: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const matched = []
  const ambiguous = []
  const unmatched = []
  for (const row of wanted.values()) {
    if (ambiguousSkus.has(row.sku)) ambiguous.push({ listing_id: row.listing_id, sku: row.sku })
    else if (urlsBySku.has(row.sku)) {
      matched.push({ listing_id: row.listing_id, sku: row.sku, listing_url: urlsBySku.get(row.sku) })
    } else {
      unmatched.push({ listing_id: row.listing_id, sku: row.sku, reason: RECONCILE_UNMATCHED_REASON })
    }
  }
  return {
    outcome: failure === null ? 'reconciled' : 'reconcile_failed',
    matched,
    ambiguous,
    unmatched,
    held_undelivered: rows
      .filter((row) => !row.delivered)
      .map((row) => ({ listing_id: row.listing_id, sku: row.sku })),
    draft_reads: draftReads,
    pending_views: [...pendingViews],
    ...(failure ?? {}),
  }
}

/**
 * What to tell Fold's `report_csv_upload` about one `importCsvBatch` result. `uploaded: false`
 * releases the export's lease so the rows are offered again; `uploaded: true` keeps them held
 * awaiting confirmation until a later run matches their drafts.
 *
 * Definitive refusals (bad headers, row errors) are `false`. Accepted uploads are `true`. For any
 * other outcome, an upload attempt or confirmed upload in browser metrics is treated as delivered:
 * the driver may have handed the file to the page before a timeout, tab detach, or other exception.
 * Unknown delivery keeps the lease held because duplicate drafts are worse than a listing awaiting
 * confirmation. Only failures with no delivery attempt release the lease, with the failure code as
 * the note.
 */
export function uploadOutcomeForReport(importResult) {
  const notice = importResult?.upload_confirmation?.notice
  const failureCode = typeof importResult?.failure_code === 'string' ? importResult.failure_code : null
  if (notice === 'rejected') return { uploaded: false, note: 'bulk_listing_file_rejected' }
  if (notice === 'errors_found') return { uploaded: false, note: 'bulk_listing_file_has_row_errors' }
  if (notice === 'accepted') return { uploaded: true, note: null }
  const attempts = importResult?.browser_metrics?.upload_attempts
  if (Number.isInteger(attempts) && attempts > 0) return { uploaded: true, note: null }
  const uploads = importResult?.browser_metrics?.uploads
  if (Number.isInteger(uploads) && uploads > 0) return { uploaded: true, note: null }
  return { uploaded: false, note: failureCode ?? 'bulk_listing_upload_not_delivered' }
}

/**
 * Builds the report for a whole-file refusal — errors-found or a generic platform error. Every row
 * is not-imported unless the single bounded snapshot pass unexpectedly finds it, and rows the
 * platform named carry its verbatim messages. The snapshot costs one look regardless of batch size
 * and is what makes "drop already-imported rows before re-uploading" actionable at all.
 */
async function reportRejectedFile({
  capability,
  batch,
  before,
  upload,
  outcome,
  failureCode,
  cleanRowStatus,
  cleanRowReason,
}) {
  const rows = batch.rows
  const errorsByRow = new Map()
  const platformRowErrors = []
  for (const entry of upload.row_errors ?? []) {
    const row = mapReportedRow(entry.reported_row, batch)
    platformRowErrors.push({
      reported_row: entry.reported_row,
      field: entry.field,
      message: entry.message,
      listing_id: row?.listing_id ?? null,
      sku: row?.sku ?? null,
    })
    if (row === undefined || row === null) continue
    if (!errorsByRow.has(row.sku)) errorsByRow.set(row.sku, [])
    errorsByRow.get(row.sku).push({ field: entry.field, message: entry.message })
  }

  // One look, not the polling budget.
  const snapshot = await capability.snapshotDraftUrls()
  const urlsBySku = new Map()
  for (const url of snapshot.urls) {
    if (before.has(url)) continue
    const observed = await capability.readDraftSku(url)
    if (nonEmptyString(observed?.sku) && !urlsBySku.has(observed.sku)) {
      urlsBySku.set(observed.sku, observed.listing_url)
    }
  }

  const imported = []
  const unresolved = []
  for (const row of rows) {
    const listingUrl = urlsBySku.get(row.sku)
    if (listingUrl !== undefined) {
      imported.push({ listing_id: row.listing_id, sku: row.sku, listing_url: listingUrl })
      continue
    }
    const platformErrors = errorsByRow.get(row.sku) ?? []
    unresolved.push({
      listing_id: row.listing_id,
      sku: row.sku,
      status: platformErrors.length > 0 ? 'rejected' : cleanRowStatus,
      reason: platformErrors.length > 0 ? ROW_REJECTED_REASON : cleanRowReason,
      platform_errors: platformErrors,
    })
  }

  capability.complete?.()
  return {
    outcome,
    marketplace: batch.marketplace,
    row_count: rows.length,
    failure_code: failureCode,
    reason: upload.message ?? 'The platform refused the uploaded file',
    // The platform's own wording invites a retry only on the generic-error path. Even there it is a
    // suggestion for the human: a retry cannot know whether anything landed, and re-uploading
    // duplicates whatever did. Nothing here ever retries by itself.
    retry_suggested: upload.retry_suggested === true,
    imported,
    unresolved,
    upload_confirmation: upload,
    platform_row_errors: platformRowErrors,
    // True when the platform listed errors this workflow could not attribute to a batch row —
    // either because the batch declared no `first_data_line`, or because a reported row number fell
    // outside it. The messages are still reported; they are simply not pinned to a listing.
    platform_row_errors_unmapped: platformRowErrors.some((entry) => entry.listing_id === null),
    row_errors_malformed: upload.row_errors_malformed === true,
    new_draft_count: urlsBySku.size,
    uncorrelated_draft_count: urlsBySku.size - imported.length,
    platform_reported: { row_error_count: platformRowErrors.length },
    pending_views: snapshot.pending_views ?? [],
    poll_rounds: 0,
    truncated: batch.truncated === true,
    browser_metrics: capability.metrics?.() ?? null,
  }
}

export async function importCsvBatch({ capability, batch, now = Date.now } = {}) {
  try {
    assertCapability(capability)
    validateCsvImportBatch(batch)
  } catch (error) {
    return failure(batch, error)
  }

  const rows = batch.rows
  try {
    const baseline = await capability.snapshotDraftUrls()
    const before = new Set(baseline.urls)

    await capability.navigate()
    await capability.inspectBulkListingSurface()
    await capability.uploadCsv({ marketplace: batch.marketplace, row_count: rows.length })

    const upload = await capability.confirmUploadAccepted()

    // A file whose headers do not match never parsed, so nothing can have been created from it and
    // there is nothing to look for.
    if (upload.notice === 'rejected') {
      capability.complete?.()
      return failure(
        batch,
        batchError(
          'bulk_listing_file_rejected',
          upload.message ?? 'The platform rejected the uploaded file'
        ),
        {
          upload_confirmation: upload,
          unresolved: rows.map((row) => ({
            listing_id: row.listing_id,
            sku: row.sku,
            status: 'not_imported',
            reason: REJECTED_REASON,
            platform_errors: [],
          })),
          platform_row_errors: [],
          browser_metrics: capability.metrics?.() ?? null,
        }
      )
    }

    // Errors-found is a whole-file rejection: the platform lists the offending rows and fields and
    // creates nothing, so the seller's next action is to fix those rows and re-upload the whole
    // file. One bounded snapshot pass still runs — not the polling budget — so that a row which
    // somehow did import is reported rather than silently left behind, which is also what makes
    // "drop already-imported rows before re-uploading" actionable.
    if (upload.notice === 'errors_found') {
      return await reportRejectedFile({
        capability,
        batch,
        before,
        upload,
        outcome: 'import_rejected',
        failureCode: 'bulk_listing_file_has_row_errors',
        cleanRowStatus: 'rejected_with_file',
        cleanRowReason: FILE_REJECTED_REASON,
      })
    }

    // A generic platform error: field validation passed, then the platform failed while processing
    // and created nothing, with no per-row detail. Passing validation and beginning an import are
    // therefore different events, and only the accepted banner indicates the second. The same
    // single snapshot pass applies, for the same reason.
    if (upload.notice === 'platform_error') {
      return await reportRejectedFile({
        capability,
        batch,
        before,
        upload,
        outcome: 'import_failed',
        failureCode: 'bulk_listing_platform_error',
        cleanRowStatus: 'not_imported_platform_error',
        cleanRowReason: PLATFORM_ERROR_REASON,
      })
    }

    const correlation = await correlateBySku(
      capability,
      before,
      new Set(rows.map((row) => row.sku)),
      now
    )

    const imported = []
    const unresolved = []
    for (const row of rows) {
      if (correlation.ambiguousSkus.has(row.sku)) {
        unresolved.push({
          listing_id: row.listing_id,
          sku: row.sku,
          status: 'ambiguous',
          reason: AMBIGUOUS_REASON,
        })
        continue
      }
      const listingUrl = correlation.urlsBySku.get(row.sku)
      if (listingUrl === undefined) {
        // Still pending, never failed: the platform may not have filed this row yet.
        unresolved.push({
          listing_id: row.listing_id,
          sku: row.sku,
          status: 'pending_at_timeout',
          reason: PENDING_REASON,
        })
        continue
      }
      imported.push({ listing_id: row.listing_id, sku: row.sku, listing_url: listingUrl })
    }

    capability.complete?.()
    return {
      outcome:
        unresolved.length === 0
          ? 'import_correlated'
          : imported.length === 0
            ? 'import_unresolved'
            : 'import_partially_correlated',
      marketplace: batch.marketplace,
      row_count: rows.length,
      imported,
      unresolved,
      upload_confirmation: upload,
      new_draft_count: correlation.newDraftCount,
      uncorrelated_draft_count: correlation.newDraftCount - imported.length,
      // The platform publishes per-row detail only on the errors-found path; an accepted upload
      // reports nothing per row, so there is nothing to carry here.
      platform_reported: null,
      platform_row_errors: [],
      pending_views: correlation.pendingViews,
      poll_rounds: correlation.rounds,
      truncated: batch.truncated === true,
      browser_metrics: capability.metrics?.() ?? null,
    }
  } catch (error) {
    capability.complete?.()
    return { ...failure(batch, error), browser_metrics: capability.metrics?.() ?? null }
  }
}

/**
 * Derives the file's first data line from the bytes Fold produced, by positively identifying each
 * boilerplate line rather than counting records.
 *
 * Why this is safe where a record count would not be: the template's header block — the
 * `Template version:` preamble, the column header, and the per-column instruction row — is
 * boilerplate that carries no embedded newlines, so counting lines *within it* is exact. Data rows,
 * where a quoted description may contain a newline, are never counted. The scan stops before them.
 *
 * It also catches the defect that caused a silently-eaten first row: if the line where the
 * instruction row belongs contains one of the batch's own SKUs, then the instruction row is absent
 * and the marketplace will consume that data row as the instruction row. That fails closed rather
 * than producing an offset that is quietly one row out.
 */
export function deriveFirstDataLine(csv, skus = []) {
  if (typeof csv !== 'string' || csv === '') {
    throw batchError('bulk_listing_csv_empty', 'The export returned no CSV bytes')
  }
  const lines = csv.split(/\r?\n/, 8)
  if (!/^Template version:/.test(lines[0] ?? '')) {
    throw batchError(
      'bulk_listing_csv_shape_unrecognized',
      'The exported CSV does not begin with the marketplace template preamble'
    )
  }
  const headerIndex = lines.findIndex((line, index) => index > 0 && /(^|,)SKU(,|$)/.test(line))
  if (headerIndex === -1) {
    throw batchError(
      'bulk_listing_csv_shape_unrecognized',
      'The exported CSV has no recognizable column header row'
    )
  }
  const instructionLine = lines[headerIndex + 1]
  if (instructionLine === undefined) {
    throw batchError(
      'bulk_listing_csv_shape_unrecognized',
      'The exported CSV ends before the template instruction row'
    )
  }
  if (skus.some((sku) => nonEmptyString(sku) && instructionLine.includes(sku))) {
    throw batchError(
      'bulk_listing_csv_instruction_row_missing',
      'The exported CSV places listing data where the template instruction row belongs, so the ' +
        'marketplace would consume the first listing as that row'
    )
  }
  // Header at `headerIndex`, instruction row after it, data after that — 1-based.
  return headerIndex + 3
}

/**
 * Fetches the marketplace CSV from Fold and shapes it into a batch the browser workflow can run.
 *
 * Fold is reached only through the host-supplied handle, exactly as every other workflow here does:
 * this implements no Fold client and knows nothing of Fold's eligibility rules. The bytes are
 * likewise written by a host callback, because the host is what can place a file where the browser
 * driver is allowed to read it.
 *
 * A refusal from the tool is passed through verbatim — it is written for the seller and is
 * actionable — and an empty export is a normal outcome, not an error.
 */
export async function exportDepopCsvBatch({ fold, materializeCsv, marketplace = 'depop' } = {}) {
  assertObject(fold, 'fold')
  assertFunction(fold.exportDepopCsv, 'fold.exportDepopCsv')
  assertFunction(materializeCsv, 'materializeCsv')

  const response = await fold.exportDepopCsv()
  assertObject(response, 'export_depop_csv result')
  if (response.isError === true) {
    return {
      outcome: 'export_refused',
      marketplace,
      reason: toolText(response) ?? 'Fold refused the export and gave no reason',
      ...normalizedExportLease(),
    }
  }
  const payload = assertObject(
    response.structuredContent ?? response,
    'export_depop_csv structured content'
  )

  const lease = normalizedExportLease(payload)
  const listings = Array.isArray(payload.listings) ? payload.listings : []
  const includedCount = Number.isInteger(payload.included_count)
    ? payload.included_count
    : listings.length
  if (includedCount === 0 || listings.length === 0) {
    return {
      outcome: 'export_empty',
      marketplace,
      included_count: 0,
      message: toolText(response) ?? payload.message ?? null,
      ...lease,
    }
  }

  const rows = listings.map((listing) => {
    assertObject(listing, 'exported listing')
    return {
      listing_id: listing.listing_id,
      sku: listing.sku,
      title: listing.title ?? null,
      item_id: listing.item_id ?? null,
    }
  })

  // Order matters: correlation attributes a reported row number by position, so the batch must be
  // in the order the serializer wrote. Fold returns them that way.
  const batch = {
    marketplace,
    rows,
    truncated: payload.truncated === true,
    max_listings: Number.isInteger(payload.max_listings) ? payload.max_listings : null,
    first_data_line: deriveFirstDataLine(payload.csv, rows.map((row) => row.sku)),
  }
  validateCsvImportBatch(batch)

  // Both keys carry the same untouched string: a live agent wrote its callback against `csv` while
  // this passed `bytes`, and the file it wrote was empty. Tolerating either name is cheaper than
  // another failed upload, and nothing here reads or changes the bytes.
  const csvPath = await materializeCsv({
    csv: payload.csv,
    bytes: payload.csv,
    filename: nonEmptyString(payload.filename) ? payload.filename : 'depop-bulk-listing.csv',
  })
  if (!nonEmptyString(csvPath)) {
    throw batchError('bulk_listing_csv_not_materialized', 'The host wrote no readable CSV file')
  }

  return {
    outcome: 'export_ready',
    marketplace,
    batch,
    csv_path: csvPath,
    included_count: includedCount,
    truncated: batch.truncated,
    max_listings: batch.max_listings,
    blanked_cells: Array.isArray(payload.blanked_cells) ? payload.blanked_cells : [],
    message: toolText(response) ?? payload.message ?? null,
    ...lease,
  }
}

/**
 * The text a tool result carries for the reader. Refusals and empty-export explanations are written
 * for the seller, so they are surfaced as-is rather than reworded.
 */
function toolText(response) {
  const parts = Array.isArray(response?.content) ? response.content : []
  const text = parts
    .filter((part) => part?.type === 'text' && nonEmptyString(part.text))
    .map((part) => part.text.trim())
    .join('\n')
  return nonEmptyString(text) ? text : null
}

/**
 * The short factual statement the agent makes before running the upload.
 *
 * **This is informational and must never become an approval gate.** Greenlighting in Fold is the
 * seller's approval; a second confirmation would double-gate a decision already made and would
 * train sellers to click through prompts. Reintroducing a blocking prompt here reverses an explicit
 * product decision, it does not tighten anything — and every refusal and fail-closed path in this
 * workflow stays exactly as it is regardless.
 */
export function summarizeBulkListingPlan(exportResult) {
  assertObject(exportResult, 'export result')
  const count = exportResult.included_count ?? 0
  const marketplace = exportResult.marketplace ?? 'the marketplace'
  const lines = [
    `Uploading ${count} greenlit listing${count === 1 ? '' : 's'} to ${marketplace} as drafts.`,
    'They will be saved as drafts and never posted publicly.',
  ]
  if (exportResult.truncated === true) {
    lines.push(
      `This export was capped at ${exportResult.max_listings ?? 'the export limit'} listings, so ` +
        'it is not the complete set.'
    )
  }
  if ((exportResult.blanked_cells ?? []).length > 0) {
    lines.push(
      `${exportResult.blanked_cells.length} cell(s) were left blank because Fold had no value for ` +
        'them.'
    )
  }
  return { text: lines.join(' '), is_approval_gate: false }
}
