import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createAuthenticatedDepopTargetProfile } from '../adapters/depop/profile.mjs'
import { createDepopBulkListingCapabilityForProvider } from '../adapters/depop/provider-capabilities.mjs'
import { createVintedAdapter } from '../adapters/vinted/adapter.mjs'
import { createAuthenticatedVintedTargetProfile } from '../adapters/vinted/profile.mjs'
import { createVintedBrowserCapabilityForProvider } from '../adapters/vinted/provider-capabilities.mjs'
import {
  exportDepopCsvBatch,
  importCsvBatch as runImportCsvBatch,
  normalizedExportLease,
  prepareBulkListingSurface,
  reconcileDeliveredRows,
  summarizeBulkListingPlan,
  uploadOutcomeForReport,
} from './bulk-listing.mjs'
import { recordDraftResult, runDraftBatch } from './draft-batch.mjs'
import { createPhotoFileResolver } from './photo-files.mjs'

/**
 * The one entry point an agent calls to turn greenlit Fold listings into private marketplace
 * drafts. Everything an agent would otherwise have to hand-wire — which module exports what, the
 * export/materialize/upload/record order, the per-marketplace filter, report persistence — lives
 * here, so the skill can say "call `postDrafts`" and nothing else.
 *
 * Fold is reached only through the host's `callTool(name, args)`, invoked with Fold's own MCP tool
 * names verbatim (`list_ready_listings`, `export_depop_csv`, `report_csv_upload`,
 * `mark_published`). postDrafts records drafts itself (it calls `mark_published`), so a report
 * never hands the agent a `to_record` list to forget.
 *
 * Depop (one call does the whole batch, `next` is always `'done'`):
 *   provider probe → bulk page proven usable → `export_depop_csv` → CSV written to a temp file →
 *   one upload + bounded SKU correlation → `report_csv_upload` exactly once → reconciliation of
 *   rows earlier runs delivered but never matched → `mark_published` per correlated draft.
 *   A surface failure makes no Fold call at all, so nothing is leased. Any failure after export and
 *   before import starts reports `uploaded: false` (note = failure code), releasing the lease. If
 *   the import throws or browser metrics show a file may have been delivered, the report holds the
 *   lease with `uploaded: true`: a duplicate draft is worse than a listing held for confirmation.
 *   Uploads are never retried.
 *
 * Vinted (one draft transaction per call, sized to a host's ~60 s call limit):
 *   `list_ready_listings` → keep only `platform === 'vinted'` → resume the persisted draft-batch
 *   report → one draft → `mark_published` → report persisted at `report_path`. Call again with
 *   `resumeFrom: report.report_path` while `next` is `'continue'` or `'confirm'`.
 *
 * @typedef {object} PostDraftsListing
 * @property {string} listing_id
 * @property {string} [sku]
 * @property {'recorded'|'draft_unrecorded'|'pending'|'awaiting_confirmation'|'ambiguous'|
 *   'not_imported'|'rejected'|'failed'|'blocked'|'needs_manual_check'|'existing_draft'|
 *   'awaiting_save_confirmation'} outcome
 * @property {string} [listing_url] the per-listing draft URL
 * @property {string} [fold_outcome] `mark_published`'s answer
 * @property {string} [failure_code]
 * @property {string} [reason]
 * @property {boolean} [reconciled] matched from an earlier run's delivered upload
 *
 * @typedef {object} PostDraftsReport
 * @property {'fold-post-drafts/1'} report_version
 * @property {'depop'|'vinted'} marketplace
 * @property {string} outcome Depop: `browser_unavailable` | `surface_unavailable` |
 *   `export_failed` | `export_refused` | `export_empty` | `upload_not_delivered` |
 *   `upload_outcome_unknown` | an `importCsvBatch` outcome. Vinted: `browser_unavailable` |
 *   `listing_failed` | `nothing_ready` | `completed` | `stopped` | `in_progress`.
 * @property {'done'|'continue'|'confirm'|'stop'} next
 * @property {string} summary_text plain language, for the seller
 * @property {PostDraftsListing[]} listings
 * @property {string[]} recorded listing ids recorded in Fold this call
 * @property {string[]} pending not yet settled (Depop pending/awaiting confirmation, Vinted queued)
 * @property {string[]} failed not drafted, or drafted but not recorded
 * @property {string[]} needs_attention ambiguous / manual check / existing draft — seller decides
 * @property {string} [failure_code]
 * @property {string} [reason]
 * @property {object} [export] export summary (counts, truncated, blanked_cells, lease)
 * @property {object} [upload_report] `report_csv_upload` answer, or `{ skipped }`
 * @property {object} [reconciliation] `reconcileDeliveredRows` result
 * @property {object} [import] raw `importCsvBatch` result
 * @property {object} [draft_batch] raw Vinted draft-batch report
 * @property {{listing_id: string, platform: string}[]} [other_marketplace_listings]
 * @property {string} [report_path] Vinted: pass back as `resumeFrom`
 * @property {string} [resume_hint]
 * @property {object[]} [fold_errors] Fold calls that failed, never retried
 */

export const POST_DRAFTS_REPORT_VERSION = 'fold-post-drafts/1'
export const FOLD_TOOL_NAMES = Object.freeze([
  'list_ready_listings',
  'export_depop_csv',
  'report_csv_upload',
  'mark_published',
])

/**
 * A Fold call relayed by a model round trip (see `createFoldToolBridge`) can take minutes, so the
 * per-call bound is generous; it exists so a lost answer ends the run instead of hanging it.
 */
const TOOL_TIMEOUT_MS = 600_000
const MARKETPLACES = new Set(['depop', 'vinted'])
const RECORDED = new Set(['published', 'already_published'])

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function errorCode(error, fallback) {
  return typeof error?.code === 'string' ? error.code : fallback
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function toolText(result) {
  const parts = Array.isArray(result?.content) ? result.content : []
  const text = parts
    .filter((part) => part?.type === 'text' && nonEmptyString(part.text))
    .map((part) => part.text.trim())
    .join('\n')
  return nonEmptyString(text) ? text : null
}

/**
 * Reads one MCP CallToolResult. `structuredContent` is preferred; a host that only forwards text
 * gets the first text part that parses as a JSON object; a host that already unwrapped the result
 * (a plain object with neither key) is taken as the structured content itself.
 */
function structuredFrom(result) {
  if (isPlainObject(result?.structuredContent)) return result.structuredContent
  for (const part of Array.isArray(result?.content) ? result.content : []) {
    if (part?.type !== 'text' || !nonEmptyString(part.text)) continue
    try {
      const parsed = JSON.parse(part.text)
      if (isPlainObject(parsed)) return parsed
    } catch {
      // Prose, not JSON: keep looking.
    }
  }
  if (isPlainObject(result) && !('content' in result) && !('structuredContent' in result)) return result
  return null
}

function withTimeout(promise, timeoutMs, name, onTimeout = () => {}) {
  let timer
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Fold ${name} did not answer within ${timeoutMs} ms`)
      error.code = 'fold_tool_timeout'
      reject(error)
      onTimeout()
    }, timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** One Fold call, never thrown: `{ ok, data, text }` or `{ ok: false, failure_code, reason }`. */
async function callFold(context, name, args) {
  let result
  const controller = new AbortController()
  try {
    result = await withTimeout(
      Promise.resolve().then(() => context.callTool(name, args, { signal: controller.signal })),
      context.toolTimeoutMs,
      name,
      () => controller.abort()
    )
  } catch (error) {
    const failed = { ok: false, tool: name, failure_code: errorCode(error, 'fold_tool_failed'), reason: errorMessage(error) }
    context.foldErrors.push(failed)
    return failed
  }
  if (result?.isError === true) {
    const refused = {
      ok: false,
      tool: name,
      failure_code: 'fold_tool_refused',
      reason: toolText(result) ?? `Fold refused ${name} and gave no reason`,
    }
    context.foldErrors.push(refused)
    return refused
  }
  const data = structuredFrom(result)
  if (data === null) {
    const unreadable = {
      ok: false,
      tool: name,
      failure_code: 'fold_tool_result_unreadable',
      reason: `Fold answered ${name} with no structured content`,
    }
    context.foldErrors.push(unreadable)
    return unreadable
  }
  return { ok: true, data, text: toolText(result) }
}

/** Records one draft URL in Fold; a refusal or error is reported, never retried. */
async function markPublished(context, listingId, listingUrl) {
  const answer = await callFold(context, 'mark_published', { listing_id: listingId, listing_url: listingUrl })
  if (!answer.ok) return { recorded: false, fold_outcome: null, reason: answer.reason, failure_code: answer.failure_code }
  const outcome = answer.data.outcome
  return RECORDED.has(outcome)
    ? { recorded: true, fold_outcome: outcome }
    : {
      recorded: false,
      fold_outcome: typeof outcome === 'string' ? outcome : null,
      reason: answer.text ?? `Fold refused the draft: ${outcome ?? 'unknown'}`,
      failure_code: 'fold_mark_published_refused',
    }
}

function safeCsvFilename(filename) {
  const base = path.basename(nonEmptyString(filename) ? filename : 'depop-bulk-listing.csv')
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '')
  return cleaned.toLowerCase().endsWith('.csv') ? cleaned : `${cleaned || 'depop-bulk-listing'}.csv`
}

/** Writes the export's bytes exactly as Fold produced them into a fresh temp folder. */
export async function materializeCsvToTempFile({ bytes, filename }) {
  if (typeof bytes !== 'string' || bytes === '') {
    const error = new Error('The export returned no CSV bytes to write')
    error.code = 'bulk_listing_csv_empty'
    throw error
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fold-depop-csv-'))
  const file = path.join(directory, safeCsvFilename(filename))
  await writeFile(file, bytes, { mode: 0o600 })
  return file
}

function tally(report) {
  const groups = {
    recorded: new Set(['recorded']),
    pending: new Set(['pending', 'awaiting_confirmation', 'awaiting_save_confirmation']),
    failed: new Set(['not_imported', 'draft_unrecorded', 'rejected', 'failed', 'blocked']),
    needs_attention: new Set(['ambiguous', 'needs_manual_check', 'existing_draft']),
  }
  for (const [key, outcomes] of Object.entries(groups)) {
    report[key] = report.listings.filter((entry) => outcomes.has(entry.outcome)).map((entry) => entry.listing_id)
  }
  return report
}

function baseReport(marketplace) {
  return {
    report_version: POST_DRAFTS_REPORT_VERSION,
    marketplace,
    outcome: null,
    next: 'done',
    summary_text: '',
    listings: [],
  }
}

function finish(report, context) {
  if (context.foldErrors.length > 0) report.fold_errors = context.foldErrors
  tally(report)
  report.summary_text = summaryText(report)
  return report
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

function summaryText(report) {
  const where = report.marketplace === 'depop' ? 'Depop' : 'Vinted'
  const lines = []
  if (report.listings.length === 0) {
    if (report.outcome === 'surface_unavailable' || report.outcome === 'browser_unavailable') {
      lines.push(`The ${where} page was not usable (${report.failure_code}), so nothing was exported or uploaded.`)
    } else if (report.outcome === 'export_refused' || report.outcome === 'export_failed' || report.outcome === 'listing_failed') {
      lines.push(`Fold did not hand over the listings: ${report.reason}`)
    } else {
      lines.push(`Nothing greenlit is waiting for ${where}.`)
    }
  }
  if (report.recorded.length > 0) lines.push(`${plural(report.recorded.length, 'draft')} saved on ${where} and recorded in Fold.`)
  if (report.pending.length > 0) {
    lines.push(
      report.marketplace === 'depop'
        ? report.outcome === 'upload_outcome_unknown'
          ? `${plural(report.pending.length, 'listing')} held because the Depop upload outcome is unknown; not recorded and not re-uploaded.`
          : `${plural(report.pending.length, 'listing')} not yet seen as a Depop draft: Depop may still be importing it or may have silently rejected it, and nothing on the page tells those apart. Not recorded and not re-uploaded.`
        : `${plural(report.pending.length, 'listing')} still to draft.`
    )
  }
  if (report.failed.length > 0) lines.push(`${plural(report.failed.length, 'listing')} not drafted or not recorded; see each reason.`)
  if (report.needs_attention.length > 0) lines.push(`${plural(report.needs_attention.length, 'listing')} need the seller to check their ${where} drafts.`)
  lines.push('Drafts only: nothing was posted publicly.')
  return lines.join(' ')
}

/** The plan summary is informational; it must never stand between an upload and its Fold report. */
function planTextOrNull(exportResult) {
  try {
    return summarizeBulkListingPlan(exportResult).text
  } catch {
    return null
  }
}

function depopRowOutcome(row, failureCode) {
  const entry = { listing_id: row.listing_id, sku: row.sku }
  if (row.status === 'pending_at_timeout') return { ...entry, outcome: 'pending', reason: row.reason }
  if (row.status === 'ambiguous') return { ...entry, outcome: 'ambiguous', reason: row.reason }
  return {
    ...entry,
    outcome: 'not_imported',
    failure_code: failureCode ?? row.status,
    reason: row.reason,
    ...(Array.isArray(row.platform_errors) && row.platform_errors.length > 0 ? { platform_errors: row.platform_errors } : {}),
  }
}

function dedupeByListingId(rows) {
  const seen = new Set()
  const deduped = []
  for (const row of rows) {
    if (seen.has(row.listing_id)) continue
    seen.add(row.listing_id)
    deduped.push(row)
  }
  return deduped
}

async function cleanupMaterializedCsvDirectory(report, context, csvPath) {
  if (!context.cleanupDefaultCsvDirectory || !nonEmptyString(csvPath)) return
  try {
    await rm(path.dirname(csvPath), { recursive: true })
  } catch (error) {
    report.cleanup_error = {
      path: path.dirname(csvPath),
      failure_code: errorCode(error, 'bulk_listing_csv_cleanup_failed'),
      reason: errorMessage(error),
    }
  }
}

async function postDepopDrafts(context) {
  const report = baseReport('depop')
  let csvPath = null
  let capability
  try {
    capability = await createDepopBulkListingCapabilityForProvider({
      ...context.capabilityOptions,
      ...context.browser,
      profile: context.profile ?? createAuthenticatedDepopTargetProfile(),
      // Only ever the file this run materialized; before that there is nothing to deliver.
      resolveCsvFile: async () => (csvPath === null ? [] : [csvPath]),
    })
  } catch (error) {
    if (error instanceof TypeError) throw error
    return finish(Object.assign(report, {
      outcome: 'browser_unavailable',
      failure_code: errorCode(error, 'browser_provider_unavailable'),
      reason: errorMessage(error),
    }), context)
  }

  // The page first: Fold leases what it exports, so nothing is exported onto an unusable page.
  const surface = await prepareBulkListingSurface({ capability })
  if (surface.outcome !== 'surface_ready') {
    return finish(Object.assign(report, {
      outcome: 'surface_unavailable',
      failure_code: surface.failure_code,
      reason: surface.reason,
      browser_metrics: surface.browser_metrics,
    }), context)
  }

  const exported = await callFold(context, 'export_depop_csv', {})
  if (!exported.ok) {
    return finish(Object.assign(report, {
      outcome: exported.failure_code === 'fold_tool_refused' ? 'export_refused' : 'export_failed',
      failure_code: exported.failure_code,
      reason: exported.reason,
    }), context)
  }
  const lease = normalizedExportLease(exported.data)

  let exportResult = null
  let importResult = null
  let notDelivered = null
  let uploadUnknown = null
  try {
    exportResult = await exportDepopCsvBatch({
      fold: { exportDepopCsv: async () => ({ structuredContent: exported.data, content: [] }) },
      materializeCsv: context.materializeCsv,
    })
  } catch (error) {
    // Export/materialization happens before any import attempt, so no file was delivered.
    notDelivered = { failure_code: errorCode(error, 'bulk_listing_upload_not_delivered'), reason: errorMessage(error) }
  }
  if (notDelivered === null && exportResult?.outcome === 'export_ready') {
    csvPath = exportResult.csv_path
    try {
      importResult = await context.importCsvBatch({ capability, batch: exportResult.batch, now: context.now })
    } catch (error) {
      uploadUnknown = {
        failure_code: errorCode(error, 'bulk_listing_upload_outcome_unknown'),
        reason: errorMessage(error),
      }
    }
  }

  report.export = {
    outcome: exportResult?.outcome ?? 'export_unusable',
    included_count: exportResult?.included_count ?? null,
    truncated: exportResult?.truncated === true,
    max_listings: exportResult?.max_listings ?? null,
    blanked_cells: exportResult?.blanked_cells ?? (Array.isArray(exported.data.blanked_cells) ? exported.data.blanked_cells : []),
    message: exportResult?.message ?? exported.text ?? null,
    plan_text: exportResult?.outcome === 'export_ready' ? planTextOrNull(exportResult) : null,
    submission_id: lease.submission_id,
    lease_expires_at: lease.lease_expires_at,
    awaiting_confirmation: lease.awaiting_confirmation,
    awaiting_confirmation_malformed_count: lease.awaiting_confirmation_malformed_count,
  }
  if (importResult !== null) report.import = importResult

  // Exactly one report per submission, whatever happened above.
  if (nonEmptyString(lease.submission_id)) {
    const delivery = importResult !== null
      ? uploadOutcomeForReport(importResult)
      : uploadUnknown !== null
        ? { uploaded: true, note: uploadUnknown.failure_code }
        : { uploaded: false, note: notDelivered?.failure_code ?? exportResult?.outcome ?? 'bulk_listing_upload_not_delivered' }
    const args = { submission_id: lease.submission_id, uploaded: delivery.uploaded }
    if (delivery.note !== null) args.note = delivery.note
    const answer = await callFold(context, 'report_csv_upload', args)
    report.upload_report = answer.ok
      ? { ...args, ...answer.data }
      : { ...args, outcome: 'report_failed', failure_code: answer.failure_code, reason: answer.reason }
  } else {
    report.upload_report = { skipped: 'no_submission_id' }
  }
  await cleanupMaterializedCsvDirectory(report, context, csvPath)

  const toRecord = []
  if (importResult !== null) {
    for (const row of importResult.imported) toRecord.push({ ...row, reconciled: false })
    for (const row of importResult.unresolved ?? []) report.listings.push(depopRowOutcome(row, importResult.failure_code))
    if (importResult.imported.length === 0 && (importResult.unresolved ?? []).length === 0) {
      // A file that may have reached Depop is unknown, not failed: the same verdict that keeps the
      // Fold lease held reports these rows pending rather than not_imported.
      const mayHaveLanded = uploadOutcomeForReport(importResult).uploaded
      for (const row of exportResult.batch.rows) {
        report.listings.push({
          listing_id: row.listing_id,
          sku: row.sku,
          outcome: mayHaveLanded ? 'pending' : 'not_imported',
          failure_code: importResult.failure_code,
          reason: importResult.reason,
        })
      }
    }
  } else if (uploadUnknown !== null) {
    for (const row of exportResult.batch.rows) {
      report.listings.push({
        listing_id: row.listing_id,
        sku: row.sku,
        outcome: 'pending',
        failure_code: uploadUnknown.failure_code,
        reason: uploadUnknown.reason,
      })
    }
  } else if (notDelivered !== null) {
    for (const listing of Array.isArray(exported.data.listings) ? exported.data.listings : []) {
      if (!nonEmptyString(listing?.listing_id)) continue
      report.listings.push({
        listing_id: listing.listing_id,
        ...(nonEmptyString(listing.sku) ? { sku: listing.sku } : {}),
        outcome: 'not_imported',
        failure_code: notDelivered.failure_code,
        reason: notDelivered.reason,
      })
    }
  }

  // This run's own export is authoritative for its rows: an earlier run's held copy of the same
  // listing is neither reported nor recorded a second time.
  const currentBatchListingIds = new Set([
    ...(exportResult?.batch?.rows ?? []).map((row) => row.listing_id),
    ...(Array.isArray(exported.data.listings) ? exported.data.listings : [])
      .map((listing) => listing?.listing_id)
      .filter(nonEmptyString),
  ])
  if (lease.awaiting_confirmation.some((row) => row.delivered)) {
    const knownUrls = new Map((importResult?.imported ?? []).map((row) => [row.listing_url, row.sku]))
    const reconciliation = await reconcileDeliveredRows({
      capability,
      awaiting: lease.awaiting_confirmation,
      maxDraftReads: context.maxReconcileReads,
      knownUrls,
    })
    reconciliation.matched = reconciliation.matched.filter((row) => !currentBatchListingIds.has(row.listing_id))
    reconciliation.ambiguous = reconciliation.ambiguous.filter((row) => !currentBatchListingIds.has(row.listing_id))
    reconciliation.unmatched = reconciliation.unmatched.filter((row) => !currentBatchListingIds.has(row.listing_id))
    report.reconciliation = reconciliation
    for (const row of reconciliation.matched) toRecord.push({ ...row, reconciled: true })
    for (const row of reconciliation.ambiguous) {
      report.listings.push({ ...row, outcome: 'ambiguous', reconciled: true, reason: 'more than one draft carries this SKU' })
    }
    for (const row of reconciliation.unmatched) report.listings.push({ ...row, outcome: 'awaiting_confirmation', reconciled: true })
  }

  const uniqueToRecord = dedupeByListingId(toRecord)
  const answers = await Promise.all(uniqueToRecord.map((row) => markPublished(context, row.listing_id, row.listing_url)))
  uniqueToRecord.forEach((row, index) => {
    const answer = answers[index]
    report.listings.push({
      listing_id: row.listing_id,
      sku: row.sku,
      outcome: answer.recorded ? 'recorded' : 'draft_unrecorded',
      listing_url: row.listing_url,
      fold_outcome: answer.fold_outcome,
      ...(row.reconciled ? { reconciled: true } : {}),
      ...(answer.recorded ? {} : { failure_code: answer.failure_code, reason: answer.reason }),
    })
  })

  if (notDelivered !== null) {
    Object.assign(report, { outcome: 'upload_not_delivered', ...notDelivered })
  } else if (uploadUnknown !== null) {
    Object.assign(report, { outcome: 'upload_outcome_unknown', ...uploadUnknown })
  } else if (importResult !== null) {
    report.outcome = importResult.outcome
    if (nonEmptyString(importResult.failure_code)) {
      report.failure_code = importResult.failure_code
      report.reason = importResult.reason
    }
  } else {
    report.outcome = exportResult.outcome
  }
  return finish(report, context)
}

function vintedItemOutcome(item) {
  const entry = { listing_id: item.listing_id, outcome: item.outcome }
  for (const key of ['failure_code', 'reason', 'fold_outcome', 'authenticity_hint', 'brand_id_fallback', 'candidates']) {
    if (item[key] !== undefined) entry[key] = item[key]
  }
  if (nonEmptyString(item.draft_url)) entry.listing_url = item.draft_url
  return entry
}

/**
 * Creates the persisted Vinted progress report. The file is intentionally kept after each call:
 * `resumeFrom` points at it for the next bounded draft step, and it holds only listing ids, draft
 * URLs and workflow status rather than credentials, cookies or marketplace message contents.
 */
async function freshReportPath() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fold-post-drafts-'))
  return path.join(directory, `vinted-${Date.now()}-${randomUUID().slice(0, 8)}.json`)
}

async function postVintedDrafts(context) {
  const report = baseReport('vinted')
  const ready = await callFold(context, 'list_ready_listings', {})
  if (!ready.ok) {
    return finish(Object.assign(report, { outcome: 'listing_failed', next: 'stop', failure_code: ready.failure_code, reason: ready.reason }), context)
  }
  const all = Array.isArray(ready.data.listings) ? ready.data.listings : []
  // Fold's ready set spans marketplaces; only this marketplace's listings are planned, so a Depop
  // listing is never reported as a Vinted rejection.
  const vinted = all.filter((listing) => listing?.platform === 'vinted')
  report.other_marketplace_listings = all
    .filter((listing) => listing?.platform !== 'vinted')
    .map((listing) => ({ listing_id: listing?.listing_id ?? null, platform: listing?.platform ?? null }))

  let resumed
  let reportPath
  if (nonEmptyString(context.resumeFrom)) {
    reportPath = context.resumeFrom
    resumed = JSON.parse(await readFile(reportPath, 'utf8'))
  } else {
    if (vinted.length === 0) return finish(Object.assign(report, { outcome: 'nothing_ready' }), context)
    reportPath = await freshReportPath()
  }
  report.report_path = reportPath
  const persist = (value) => writeFile(reportPath, JSON.stringify(value), { mode: 0o600 })

  let adapter
  try {
    const profile = context.profile ?? createAuthenticatedVintedTargetProfile()
    const browser = await createVintedBrowserCapabilityForProvider({
      ...context.capabilityOptions,
      ...context.browser,
      profile,
      memberId: context.memberId,
      resolvePhotoFiles:
        context.resolvePhotoFiles ??
        createPhotoFileResolver({
          directory: context.photoDirectory ?? (await mkdtemp(path.join(os.tmpdir(), 'fold-vinted-photos-'))),
        }),
    })
    adapter = createVintedAdapter({ browser, profile })
  } catch (error) {
    if (error instanceof TypeError) throw error
    return finish(Object.assign(report, {
      outcome: 'browser_unavailable',
      next: 'stop',
      failure_code: errorCode(error, 'browser_provider_unavailable'),
      reason: errorMessage(error),
    }), context)
  }

  let batch = await runDraftBatch({
    adapter,
    readyListings: { ...ready.data, listings: vinted, count: vinted.length },
    resumeFrom: resumed,
    maxDrafts: context.maxDrafts,
    persist,
  })
  const toRecord = batch.to_record
  const answers = await Promise.all(toRecord.map((entry) => markPublished(context, entry.listing_id, entry.listing_url)))
  toRecord.forEach((entry, index) => {
    const answer = answers[index]
    batch = recordDraftResult(
      batch,
      entry.listing_id,
      answer.fold_outcome !== null ? { outcome: answer.fold_outcome } : new Error(answer.reason)
    )
  })
  await persist(batch)

  report.draft_batch = batch
  report.listings = batch.items.map(vintedItemOutcome)
  for (const listingId of batch.pending_listings) report.listings.push({ listing_id: listingId, outcome: 'pending' })
  report.outcome = batch.outcome
  // `record` means Fold refused or failed to record a draft just made. postDrafts never retries a
  // Fold write within a call, so the run stops here; a later call with `resumeFrom` records it
  // again (the draft itself is never re-created).
  report.next = batch.next === 'record' ? 'stop' : batch.next
  if (report.next === 'continue' || report.next === 'confirm') {
    report.resume_hint = 'Call postDrafts again with the same arguments plus resumeFrom: report.report_path'
  }
  return finish(report, context)
}

/**
 * @param {object} input
 * @param {'depop'|'vinted'} input.marketplace
 * @param {(name: string, args: object, options?: { signal?: AbortSignal }) => Promise<object>}
 *   input.callTool the host's Fold MCP caller, by Fold tool name; `createFoldToolBridge().callTool`
 *   when Fold lives in another runtime. Hosts that do not support cancellation may ignore `options`.
 * @param {object} input.browser passed to the marketplace's provider factory:
 *   `{ provider: 'codex-browser-client', tab, reacquireTab, releaseTab, openFreshTab }` or
 *   `{ provider: 'claude-in-chrome', callTool: <chrome bridge>, tabId }`
 * @param {string} [input.memberId] Vinted seller member id (required for Vinted)
 * @param {string} [input.resumeFrom] Vinted: a previous report's `report_path`
 * @param {object} [input.profile] defaults to the authenticated profile for the marketplace
 * @param {object} [input.options] `toolTimeoutMs`, `maxDrafts` (Vinted, default 1),
 *   `photoDirectory`, `resolvePhotoFiles`, `materializeCsv`, `importCsvBatch`, `maxReconcileReads`,
 *   and capability budgets (`surfaceTimeoutMs`, `importTimeoutMs`, `pollMs`, …) passed to the
 *   provider factory
 * @returns {Promise<PostDraftsReport>}
 */
export async function postDrafts({
  marketplace,
  callTool,
  browser,
  memberId,
  resumeFrom,
  profile,
  options = {},
  now = Date.now,
} = {}) {
  if (!MARKETPLACES.has(marketplace)) throw new TypeError('marketplace must be "depop" or "vinted"')
  if (typeof callTool !== 'function') throw new TypeError('callTool must be the host Fold MCP caller')
  if (!isPlainObject(browser)) throw new TypeError('browser must be the provider options object')
  if (!isPlainObject(options)) throw new TypeError('options must be an object')
  const {
    toolTimeoutMs = TOOL_TIMEOUT_MS,
    maxDrafts = 1,
    photoDirectory,
    resolvePhotoFiles,
    materializeCsv = materializeCsvToTempFile,
    importCsvBatch = runImportCsvBatch,
    maxReconcileReads = 60,
    ...capabilityOptions
  } = options
  const cleanupDefaultCsvDirectory = options.materializeCsv === undefined
  if (!Number.isInteger(toolTimeoutMs) || toolTimeoutMs < 1) throw new TypeError('toolTimeoutMs must be a positive integer')
  if (typeof materializeCsv !== 'function') throw new TypeError('materializeCsv must be a function')
  if (typeof importCsvBatch !== 'function') throw new TypeError('importCsvBatch must be a function')
  if (resumeFrom !== undefined && resumeFrom !== null && !nonEmptyString(resumeFrom)) {
    throw new TypeError('resumeFrom must be the report_path a previous postDrafts call returned')
  }

  const context = {
    callTool,
    browser,
    memberId,
    resumeFrom,
    profile,
    now,
    toolTimeoutMs,
    maxDrafts,
    photoDirectory,
    resolvePhotoFiles,
    materializeCsv,
    cleanupDefaultCsvDirectory,
    importCsvBatch,
    maxReconcileReads,
    capabilityOptions,
    foldErrors: [],
  }
  return marketplace === 'depop' ? postDepopDrafts(context) : postVintedDrafts(context)
}

/**
 * A `callTool` for a host whose Fold tools and browser live in different runtimes: Fold's MCP tools
 * may be callable only from an `exec` runtime, while the browser may live in a separate persistent
 * runtime, with neither able to call into the other. The bridge parks each Fold call postDrafts
 * makes, writes it to `<directory>/requests.json`, and resumes when the answers file appears. The
 * run itself stays alive in the persistent browser REPL between calls.
 *
 * Browser runtime:   `const run = bridge.start(postDrafts({ ..., callTool: bridge.callTool }))`
 *                    → `{ next: 'call_fold', calls }` | `{ next: 'working' }` | `{ next: 'finished', report }`
 * Fold runtime:      read `requests.json`, call each `mcp__fold__<name>(args)`, write the answers
 *                    as `{ [id]: result }` to its `response_path`
 * Browser runtime:   `await bridge.deliver()` → the next step, until `finished`
 *
 * Each step returns within `stepTimeoutMs` (default 45 s, under a host's ~60 s call limit); a
 * `working` step just means "call `bridge.step()` again".
 */
export function createFoldToolBridge({ directory, stepTimeoutMs = 45_000 } = {}) {
  if (!nonEmptyString(directory) || !path.isAbsolute(directory)) {
    throw new TypeError('directory must be an absolute folder both runtimes can read and write')
  }
  if (!/^[A-Za-z0-9/._-]+$/.test(directory)) {
    throw new TypeError('directory may contain only letters, numbers, slash, dot, underscore and dash')
  }
  if (directory.split(path.sep).includes('..')) {
    throw new TypeError('directory must not contain a .. path segment')
  }
  if (!Number.isInteger(stepTimeoutMs) || stepTimeoutMs < 0) throw new TypeError('stepTimeoutMs must be a non-negative integer')
  const pending = new Map()
  let nextId = 1
  let round = 0
  let published = null
  let run = null
  let settled = null
  const requestsPath = path.join(directory, 'requests.json')
  let wake = () => {}

  function wakeStep() {
    const current = wake
    wake = () => {}
    current()
  }

  function abortError(name) {
    const error = new Error(`Fold ${name} call was abandoned`)
    error.code = 'fold_tool_aborted'
    return error
  }

  async function waitForChange(deadline) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return
    let timer
    await new Promise((resolve) => {
      wake = resolve
      timer = setTimeout(resolve, remaining)
    })
    clearTimeout(timer)
  }

  async function publishRequests() {
    round += 1
    const responsePath = path.join(directory, `responses-${round}.json`)
    const calls = [...pending.values()].map(({ id, name, args }) => ({ id, name, args }))
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(requestsPath, JSON.stringify({ round, response_path: responsePath, calls }), { mode: 0o600 })
    published = { round, response_path: responsePath, ids: calls.map((call) => call.id).join(',') }
    return { next: 'call_fold', requests_path: requestsPath, response_path: responsePath, calls }
  }

  const bridge = {
    directory,
    callTool(name, args, { signal } = {}) {
      if (!FOLD_TOOL_NAMES.includes(name)) return Promise.reject(new TypeError(`${name} is not a Fold tool`))
      if (signal?.aborted === true) return Promise.reject(abortError(name))
      return new Promise((resolve, reject) => {
        const id = String(nextId++)
        let onAbort = null
        const cleanup = () => {
          if (onAbort !== null) signal.removeEventListener('abort', onAbort)
        }
        pending.set(id, { id, name, args, resolve, reject, cleanup })
        if (signal !== undefined) {
          onAbort = () => {
            const call = pending.get(id)
            if (call === undefined) return
            pending.delete(id)
            cleanup()
            reject(abortError(name))
            wakeStep()
          }
          signal.addEventListener('abort', onAbort, { once: true })
        }
        wakeStep()
      })
    },
    /** Starts (or, for the next Vinted step, restarts) a run; returns its first step. */
    start(promise) {
      settled = null
      run = Promise.resolve(promise).then(
        (report) => {
          settled = { next: 'finished', report }
        },
        (error) => {
          settled = { next: 'error', error_code: errorCode(error, 'post_drafts_failed'), error: errorMessage(error) }
        }
      ).finally(wakeStep)
      return bridge.step()
    },
    async step() {
      if (run === null) throw new TypeError('bridge.start(postDrafts(...)) has not been called')
      const deadline = Date.now() + stepTimeoutMs
      for (;;) {
        if (settled !== null) {
          await rm(requestsPath, { force: true })
          return settled
        }
        if (pending.size > 0) {
          // Let calls issued together (parallel mark_published) land in one request file.
          await new Promise((resolve) => setTimeout(resolve, 20))
          if (pending.size === 0) continue
          const ids = [...pending.keys()].join(',')
          if (published !== null && published.ids === ids) {
            return { next: 'call_fold', requests_path: requestsPath, response_path: published.response_path, calls: [...pending.values()].map(({ id, name, args }) => ({ id, name, args })) }
          }
          return publishRequests()
        }
        if (Date.now() >= deadline) return { next: 'working' }
        await waitForChange(deadline)
      }
    },
    /** Reads the Fold runtime's answers, resumes the run, and returns its next step. */
    async deliver() {
      if (published === null) return bridge.step()
      const answers = JSON.parse(await readFile(published.response_path, 'utf8'))
      for (const [id, result] of Object.entries(answers)) {
        const call = pending.get(id)
        // An abandoned call may answer late after its timeout removed it; that stale answer is dropped.
        if (call === undefined) continue
        pending.delete(id)
        call.cleanup()
        call.resolve(result)
      }
      await rm(published.response_path, { force: true })
      published = null
      return bridge.step()
    },
  }
  return bridge
}
