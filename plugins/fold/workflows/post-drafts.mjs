import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { createAuthenticatedDepopTargetProfile } from '../adapters/depop/profile.mjs'
import {
  createDepopBulkListingCapabilityForProvider,
  createDepopGoLiveCapabilityForProvider,
} from '../adapters/depop/provider-capabilities.mjs'
import { createVintedAdapter } from '../adapters/vinted/adapter.mjs'
import { createAuthenticatedVintedTargetProfile } from '../adapters/vinted/profile.mjs'
import {
  createVintedBrowserCapabilityForProvider,
  createVintedGoLiveCapabilityForProvider,
} from '../adapters/vinted/provider-capabilities.mjs'
import {
  exportDepopCsvBatch,
  importCsvBatch as runImportCsvBatch,
  normalizedExportLease,
  prepareBulkListingSurface,
  reconcileDeliveredRows,
  summarizeBulkListingPlan,
  uploadOutcomeForReport,
} from './bulk-listing.mjs'
import { DRAFT_BATCH_REPORT_VERSION, expectedToRecord, recordDraftResult, runDraftBatch } from './draft-batch.mjs'
import { createPhotoFileResolver } from './photo-files.mjs'
import {
  nonEmptyString,
  isPlainObject,
  errorCode,
  errorMessage,
  clone,
  assertAbsolutePath,
  assertOptions,
  privateTempDir,
  writeJsonPrivate,
  readJsonFile,
  writeFoldCallFile,
  hasDotDotSegment,
  pathInside,
  sameTmpParent,
  validatePrivateWorkspace,
  tryReadJson,
  toolText,
  structuredFrom,
  unansweredResult,
  readResultsForCalls,
  foldFailureFromResult,
} from './phase-files.mjs'

export const POST_DRAFTS_REPORT_VERSION = 'fold-post-drafts/2'
export const POST_DRAFTS_STATE_VERSION = 'fold-post-drafts-state/1'
export const DEPOP_UPLOAD_JS_TIMEOUT_MS = 300_000
export const GO_LIVE_REPORT_VERSION = 'fold-go-live/1'
export const GO_LIVE_STATE_VERSION = 'fold-go-live-state/1'
export const GO_LIVE_JS_TIMEOUT_MS = 300_000
export const FOLD_TOOL_NAMES = Object.freeze([
  'list_ready_listings',
  'export_depop_csv',
  'report_csv_upload',
  'mark_published',
  'list_drafted_listings',
  'mark_live',
  'mark_sold',
  'delist_sold_siblings',
  'list_pending_delists',
  'report_delist',
])

const RECORDED = new Set(['published', 'already_published'])
const DEFAULT_PHASE_BUDGET_MS = 270_000
const RECONCILE_MIN_REMAINING_MS = 30_000
const VINTED_STATE_FILE = 'vinted-batch.json'
const DEPOP_STATE_FILE = 'state.json'
const DEPOP_EXPORT_FILE = 'export.json'
const VINTED_ENVELOPE_KEYS = new Set([
  'state_version',
  'marketplace',
  'run_id',
  'ready_path',
  'report_path',
  'workspace_dir',
  '__fold_post_drafts',
])

function assertObject(value, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be an object`)
  return value
}

async function writeTextPrivate(file, value) {
  await writeFile(file, value, { mode: 0o600 })
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

function stripVintedStateEnvelope(value) {
  const batch = clone(value)
  for (const key of VINTED_ENVELOPE_KEYS) delete batch[key]
  return batch
}

function vintedStateFromBatch(batch, envelope, postDrafts) {
  const state = {
    ...stripVintedStateEnvelope(batch),
    state_version: POST_DRAFTS_STATE_VERSION,
    marketplace: 'vinted',
    run_id: envelope.run_id,
    ready_path: envelope.ready_path,
    report_path: envelope.report_path,
    workspace_dir: envelope.workspace_dir,
  }
  if (postDrafts !== undefined) state.__fold_post_drafts = postDrafts
  return state
}

function stateInvalid(marketplace, reason, failureCode = 'state_invalid') {
  const report = finish(Object.assign(baseReport(marketplace), {
    outcome: 'state_invalid',
    failure_code: failureCode,
    reason,
  }))
  return {
    marketplace,
    outcome: 'state_invalid',
    report,
    failure_code: failureCode,
    reason,
    next: 'done',
    fold_calls: [],
    fold_calls_path: null,
    results_path: null,
  }
}

function vintedDraftStateInvalid(reason, reportPath = null) {
  const result = stateInvalid('vinted', reason)
  // Browser-phase state refusals stop the phase loop; summarizers use the default terminal `done`.
  result.next = 'stop'
  result.report.next = 'stop'
  if (reportPath !== null) result.report_path = reportPath
  return result
}

function resultsPathOutsideWorkspace(marketplace, resultsPath, workspaceDir) {
  return stateInvalid(
    marketplace,
    `resultsPath ${resultsPath} is not directly inside workspace ${workspaceDir}`,
    'results_path_outside_workspace'
  )
}

function resultsPathMismatch(marketplace, expected, actual) {
  const report = finish(Object.assign(baseReport(marketplace), {
    outcome: 'state_invalid',
    failure_code: 'results_path_mismatch',
    reason: `resultsPath ${actual} does not match expected ${expected}`,
  }))
  return {
    marketplace,
    outcome: 'state_invalid',
    report,
    failure_code: 'results_path_mismatch',
    reason: report.reason,
    expected_results_path: expected,
    results_path: actual,
    next: 'stop',
    fold_calls: [],
  }
}

function safeCsvFilename(filename) {
  const base = path.basename(nonEmptyString(filename) ? filename : 'depop-bulk-listing.csv')
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '')
  return cleaned.toLowerCase().endsWith('.csv') ? cleaned : `${cleaned || 'depop-bulk-listing'}.csv`
}

export async function materializeCsvToTempFile({ bytes, filename }) {
  if (typeof bytes !== 'string' || bytes === '') {
    const error = new Error('The export returned no CSV bytes to write')
    error.code = 'bulk_listing_csv_empty'
    throw error
  }
  const directory = await privateTempDir('fold-depop-csv-')
  const file = path.join(directory, safeCsvFilename(filename))
  await writeTextPrivate(file, bytes)
  return file
}

/**
 * Build Codex browser provider options inside the same js call as the phase.
 * Never reuse the returned object across js calls. `onTabChange` lets snippets keep
 * `var tabId` current when Vinted opens a fresh tab.
 */
export async function codexBrowser({ cua, browserId, tabId, onTabChange } = {}) {
  if (!isPlainObject(cua) || typeof cua.getTab !== 'function' || typeof cua.createBrowserTab !== 'function') {
    throw new TypeError('cua must be an object with getTab and createBrowserTab functions')
  }
  if (!nonEmptyString(browserId)) throw new TypeError('browserId must be a non-empty string')
  const validTabId = nonEmptyString(tabId) || Number.isInteger(tabId)
  if (!validTabId) throw new TypeError('tabId must be a non-empty string or integer')
  if (onTabChange !== undefined && typeof onTabChange !== 'function') {
    throw new TypeError('onTabChange must be a function')
  }
  const tab = await cua.getTab(tabId, { browser: browserId })
  return {
    provider: 'codex-browser-client',
    tab,
    reacquireTab: async (id) => {
      const next = await cua.getTab(id, { browser: browserId })
      onTabChange?.(next.id)
      return next
    },
    releaseTab: async (id, replacementId) => {
      if (id !== replacementId) await (await cua.getTab(id, { browser: browserId })).close()
    },
    openFreshTab: async (url) => {
      const next = await cua.createBrowserTab(browserId, url, { visible: true })
      onTabChange?.(next.id)
      return next
    },
  }
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

function tally(report) {
  const groups = {
    recorded: new Set(['recorded']),
    to_record: new Set(['to_record']),
    pending: new Set(['pending', 'awaiting_confirmation', 'awaiting_save_confirmation']),
    failed: new Set(['not_imported', 'draft_unrecorded', 'rejected', 'failed', 'blocked']),
    needs_attention: new Set(['ambiguous', 'needs_manual_check', 'existing_draft']),
    old_draft_pending: new Set(['old_draft_pending_deletion']),
  }
  for (const [key, outcomes] of Object.entries(groups)) {
    report[key] = report.listings.filter((entry) => outcomes.has(entry.outcome)).map((entry) => entry.listing_id)
  }
  return report
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
  if (report.to_record.length > 0) lines.push(`${plural(report.to_record.length, 'draft')} saved on ${where} and waiting to be recorded in Fold.`)
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
  if (report.old_draft_pending.length > 0) {
    lines.push(
      `${plural(report.old_draft_pending.length, 'draft')} saved on ${where} but not yet recorded: Fold holds ${report.old_draft_pending.length === 1 ? 'it' : 'them'} until the old draft from a Redo is deleted. Run the cleanup (list_pending_delists, the delist phase, report_delist), then record ${report.old_draft_pending.length === 1 ? 'it' : 'them'} with mark_published.`
    )
  }
  if (report.needs_attention.length > 0) lines.push(`${plural(report.needs_attention.length, 'listing')} need the seller to check their ${where} drafts.`)
  lines.push('Drafts only: nothing was posted publicly.')
  return lines.join(' ')
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

function finish(report) {
  tally(report)
  report.summary_text = summaryText(report)
  return report
}

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

function vintedItemOutcome(item) {
  const outcome = item.outcome === 'draft_verified' ? 'to_record' : item.outcome
  const entry = { listing_id: item.listing_id, outcome }
  for (const key of ['failure_code', 'reason', 'fold_outcome', 'authenticity_hint', 'brand_id_fallback', 'candidates']) {
    if (item[key] !== undefined) entry[key] = item[key]
  }
  if (nonEmptyString(item.draft_url)) entry.listing_url = item.draft_url
  return entry
}

function validHttpsUrl(value) {
  if (!nonEmptyString(value)) return false
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function validateVintedDraftBatch(state) {
  if (state.report_version !== DRAFT_BATCH_REPORT_VERSION) return `report_version must be ${DRAFT_BATCH_REPORT_VERSION}`
  if (state.platform !== 'vinted') return 'platform must be vinted'
  if (!Array.isArray(state.items)) return 'items must be an array'
  const expected = expectedToRecord(state)
  if (!Array.isArray(state.to_record)) return 'to_record must be an array'
  for (const entry of state.to_record) {
    if (!validHttpsUrl(entry?.listing_url)) return 'to_record listing_url must be an https URL'
    const item = state.items.find((candidate) => candidate?.listing_id === entry.listing_id)
    if (item === undefined) return `to_record listing ${entry?.listing_id ?? '<missing>'} is not in items`
    if (item.draft_url !== entry.listing_url) return `to_record listing ${entry.listing_id} does not match its item draft_url`
  }
  if (!deepEqual(state.to_record, expected)) return 'to_record does not match the draft-batch report'
  const storedCalls = state.__fold_post_drafts?.fold_calls
  if (Array.isArray(storedCalls) && storedCalls.length > 0 && !deepEqual(storedCalls, foldCallsForVinted(state))) {
    return 'stored fold calls do not match the draft-batch report'
  }
  return null
}

async function readDepopState(statePath) {
  const read = await tryReadJson(statePath)
  if (!read.ok) return { ok: false, result: stateInvalid('depop', read.reason) }
  const state = read.value
  if (!isPlainObject(state) || state.state_version !== POST_DRAFTS_STATE_VERSION || state.marketplace !== 'depop') {
    return { ok: false, result: stateInvalid('depop', 'state file is not a Depop post-drafts state') }
  }
  if (state.state_path !== statePath) {
    return { ok: false, result: stateInvalid('depop', 'state_path does not match the file being read') }
  }
  const directory = path.dirname(statePath)
  if (!pathInside(directory, statePath) || path.basename(statePath) !== DEPOP_STATE_FILE) {
    return { ok: false, result: stateInvalid('depop', 'statePath is not a valid Depop state path') }
  }
  const workspaceError = await validatePrivateWorkspace({
    workspaceDir: directory,
    statePath,
    prefix: 'fold-depop-',
    stateFile: DEPOP_STATE_FILE,
  })
  if (workspaceError !== null) return { ok: false, result: stateInvalid('depop', workspaceError) }
  const expectedExportPath = path.join(directory, DEPOP_EXPORT_FILE)
  if (state.export_path !== expectedExportPath || !pathInside(directory, state.export_path)) {
    return { ok: false, result: stateInvalid('depop', 'export_path does not match the prepared workspace') }
  }
  for (const key of ['fold_calls_path', 'results_path']) {
    if (state[key] !== undefined && state[key] !== null && !pathInside(directory, state[key])) {
      return { ok: false, result: stateInvalid('depop', `${key} is outside the state workspace`) }
    }
  }
  return { ok: true, state }
}

async function readVintedState(statePath, { readyPath } = {}) {
  const read = await tryReadJson(statePath)
  if (!read.ok) return { ok: false, result: stateInvalid('vinted', read.reason) }
  const state = read.value
  if (!isPlainObject(state)) return { ok: false, result: stateInvalid('vinted', 'state file is not a JSON object') }
  if (
    state.state_version !== POST_DRAFTS_STATE_VERSION ||
    state.marketplace !== 'vinted' ||
    !nonEmptyString(state.run_id)
  ) {
    return { ok: false, result: stateInvalid('vinted', 'state file is not a Vinted post-drafts state') }
  }
  if (state.report_path !== statePath) return { ok: false, result: stateInvalid('vinted', 'report_path does not match the file being read') }
  if (path.basename(statePath) !== VINTED_STATE_FILE) {
    return { ok: false, result: stateInvalid('vinted', `report_path must end in ${VINTED_STATE_FILE}`) }
  }
  const workspaceError = await validatePrivateWorkspace({
    workspaceDir: state.workspace_dir,
    statePath,
    prefix: 'fold-vinted-',
    stateFile: VINTED_STATE_FILE,
  })
  if (workspaceError !== null) return { ok: false, result: stateInvalid('vinted', workspaceError) }
  if (statePath !== path.join(state.workspace_dir, VINTED_STATE_FILE)) {
    return { ok: false, result: stateInvalid('vinted', 'report_path does not match the workspace state file') }
  }
  if (readyPath !== undefined && state.ready_path !== readyPath) {
    return { ok: false, result: stateInvalid('vinted', 'ready_path does not match the resume readyPath') }
  }
  const batchError = validateVintedDraftBatch(state)
  if (batchError !== null) return { ok: false, result: stateInvalid('vinted', batchError) }
  for (const key of ['fold_calls_path', 'results_path']) {
    const value = state.__fold_post_drafts?.[key]
    if (value !== undefined && value !== null && !pathInside(state.workspace_dir, value)) {
      return { ok: false, result: stateInvalid('vinted', `${key} is outside the state workspace`) }
    }
  }
  return { ok: true, state }
}

async function persistDepopState(state) {
  await writeJsonPrivate(state.state_path, state)
}

function depopWorkspaceState(directory, surface) {
  return {
    state_version: POST_DRAFTS_STATE_VERSION,
    marketplace: 'depop',
    phase: 'prepared',
    surface,
    created_at: new Date().toISOString(),
    state_path: path.join(directory, 'state.json'),
    export_path: path.join(directory, 'export.json'),
  }
}

function depopReturnFromState(state, extra = {}) {
  return {
    marketplace: 'depop',
    state_path: state.state_path,
    export_path: state.export_path,
    ...extra,
  }
}

function emptyDepopPhaseReport(outcome, extra = {}) {
  return finish(Object.assign(baseReport('depop'), { outcome, ...extra }))
}

export async function depopPrepare({ browser, profile, options } = {}) {
  if (!isPlainObject(browser)) throw new TypeError('browser must be the provider options object')
  const allOptions = assertOptions(options)
  const directory = await privateTempDir('fold-depop-')
  const statePath = path.join(directory, 'state.json')
  const exportPath = path.join(directory, 'export.json')
  let capability
  try {
    capability = await createDepopBulkListingCapabilityForProvider({
      ...allOptions,
      ...browser,
      profile: profile ?? createAuthenticatedDepopTargetProfile(),
      resolveCsvFile: async () => [],
    })
  } catch (error) {
    if (error instanceof TypeError) throw error
    const state = {
      state_version: POST_DRAFTS_STATE_VERSION,
      marketplace: 'depop',
      phase: 'prepared',
      surface: {
        outcome: 'browser_unavailable',
        failure_code: errorCode(error, 'browser_provider_unavailable'),
        reason: errorMessage(error),
      },
      created_at: new Date().toISOString(),
      state_path: statePath,
      export_path: exportPath,
    }
    await persistDepopState(state)
    const report = emptyDepopPhaseReport('browser_unavailable', {
      failure_code: state.surface.failure_code,
      reason: state.surface.reason,
    })
    return depopReturnFromState(state, {
      outcome: 'browser_unavailable',
      report,
      failure_code: state.surface.failure_code,
      reason: state.surface.reason,
      fold_calls: [],
      fold_calls_path: null,
      results_path: null,
      next: 'stop',
    })
  }

  const surface = await prepareBulkListingSurface({ capability })
  const state = depopWorkspaceState(directory, surface)
  await persistDepopState(state)
  if (surface.outcome !== 'surface_ready') {
    const report = emptyDepopPhaseReport('surface_unavailable', {
      failure_code: surface.failure_code,
      reason: surface.reason,
    })
    return depopReturnFromState(state, {
      outcome: 'surface_unavailable',
      report,
      failure_code: surface.failure_code,
      reason: surface.reason,
      browser_metrics: surface.browser_metrics,
      fold_calls: [],
      fold_calls_path: null,
      results_path: null,
      next: 'stop',
    })
  }
  const report = emptyDepopPhaseReport('surface_ready')
  return depopReturnFromState(state, {
    outcome: 'surface_ready',
    report,
    browser_metrics: surface.browser_metrics,
    fold_calls: [],
    fold_calls_path: null,
    results_path: null,
    next: 'export',
  })
}

async function persistDepopAwaitingFold(state, report, foldCalls) {
  const callFiles = await writeFoldCallFile(path.dirname(state.state_path), foldCalls)
  state.phase = 'awaiting_fold'
  state.report = report
  state.fold_calls = foldCalls
  state.fold_calls_path = callFiles.fold_calls_path
  state.results_path = callFiles.results_path
  await persistDepopState(state)
  return callFiles
}

function exportFailure(outcome, failureCode, reason, state) {
  return depopReturnFromState(state, {
    outcome,
    report: finish(Object.assign(baseReport('depop'), { outcome, failure_code: failureCode, reason })),
    fold_calls: [],
    fold_calls_path: null,
    results_path: null,
    next: 'done',
  })
}

function foldReportCall(lease, uploaded, note) {
  if (!nonEmptyString(lease.submission_id)) return null
  const args = { submission_id: lease.submission_id, uploaded }
  if (nonEmptyString(note)) args.note = note
  return { name: 'report_csv_upload', args }
}

function rowIdentity(row) {
  if (!isPlainObject(row) || !nonEmptyString(row.listing_id)) return null
  return {
    listing_id: row.listing_id,
    ...(nonEmptyString(row.sku) ? { sku: row.sku } : {}),
  }
}

function interruptedUploadReport(state) {
  const report = baseReport('depop')
  Object.assign(report, {
    outcome: 'upload_outcome_unknown',
    failure_code: 'bulk_listing_upload_interrupted',
    reason: 'the upload call ended before its outcome was read',
    upload_report: nonEmptyString(state.submission_id) ? null : { skipped: 'no_submission_id' },
  })
  const rows = Array.isArray(state.current_rows) ? state.current_rows : []
  for (const row of rows) {
    const identity = rowIdentity(row)
    if (identity === null) continue
    report.listings.push({
      ...identity,
      outcome: 'pending',
      failure_code: 'bulk_listing_upload_interrupted',
      reason: 'the upload call ended before its outcome was read',
    })
  }
  return finish(report)
}

function materializerForWorkspace(directory) {
  return async ({ csv, bytes, filename }) => {
    const data = typeof bytes === 'string' ? bytes : csv
    if (typeof data !== 'string' || data === '') {
      const error = new Error('The export returned no CSV bytes to write')
      error.code = 'bulk_listing_csv_empty'
      throw error
    }
    const file = path.join(directory, safeCsvFilename(filename))
    await writeTextPrivate(file, data)
    return file
  }
}

async function cleanupMaterializedCsv(report, csvPath) {
  if (!nonEmptyString(csvPath)) return
  try {
    await rm(csvPath, { force: true })
  } catch (error) {
    report.cleanup_error = {
      path: csvPath,
      failure_code: errorCode(error, 'bulk_listing_csv_cleanup_failed'),
      reason: errorMessage(error),
    }
  }
}

function buildExportSummary(exportResult, exported, lease) {
  return {
    outcome: exportResult?.outcome ?? 'export_unusable',
    included_count: exportResult?.included_count ?? null,
    truncated: exportResult?.truncated === true,
    max_listings: exportResult?.max_listings ?? null,
    blanked_cells: exportResult?.blanked_cells ?? (Array.isArray(exported.blanked_cells) ? exported.blanked_cells : []),
    message: exportResult?.message ?? null,
    plan_text: exportResult?.outcome === 'export_ready' ? planTextOrNull(exportResult) : null,
    submission_id: lease.submission_id,
    lease_expires_at: lease.lease_expires_at,
    awaiting_confirmation: lease.awaiting_confirmation,
    awaiting_confirmation_malformed_count: lease.awaiting_confirmation_malformed_count,
  }
}

async function createDepopCapabilityForUpload({ browser, profile, capabilityOptions, csvPathRef }) {
  return await createDepopBulkListingCapabilityForProvider({
    ...capabilityOptions,
    ...browser,
    profile: profile ?? createAuthenticatedDepopTargetProfile(),
    resolveCsvFile: async () => (csvPathRef.current === null ? [] : [csvPathRef.current]),
  })
}

export async function depopUpload({ browser, statePath, exportPath, profile, options, now = Date.now } = {}) {
  if (!isPlainObject(browser)) throw new TypeError('browser must be the provider options object')
  assertAbsolutePath(statePath, 'statePath')
  assertAbsolutePath(exportPath, 'exportPath')
  const allOptions = assertOptions(options)
  const stateRead = await readDepopState(statePath)
  if (!stateRead.ok) return stateRead.result
  const state = stateRead.state
  if (exportPath !== state.export_path) {
    return stateInvalid('depop', 'exportPath does not match the prepared Depop state export_path')
  }
  if (state.phase !== 'prepared') {
    if (state.phase === 'upload_attempted') {
      const report = interruptedUploadReport(state)
      const foldCalls = []
      if (nonEmptyString(state.submission_id)) {
        foldCalls.push({
          name: 'report_csv_upload',
          args: {
            submission_id: state.submission_id,
            uploaded: true,
            note: 'bulk_listing_upload_interrupted',
          },
        })
      }
      const callFiles = await persistDepopAwaitingFold(state, report, foldCalls)
      return depopReturnFromState(state, {
        outcome: report.outcome,
        report,
        fold_calls: foldCalls,
        ...callFiles,
        next: foldCalls.length > 0 ? 'call_fold' : 'done',
      })
    }
    // The upload finished but its Fold calls may never have run (the js result was lost). Name the
    // stored calls again rather than dropping them: report_csv_upload must still happen exactly
    // once per submission and the drafts still need recording. Both Fold tools are idempotent, so
    // re-running them after they did land changes nothing.
    if (state.phase === 'awaiting_fold' && Array.isArray(state.fold_calls) && state.fold_calls.length > 0) {
      const report = isPlainObject(state.report) ? state.report : emptyDepopPhaseReport('already_uploaded')
      return depopReturnFromState(state, {
        outcome: 'already_uploaded',
        report,
        fold_calls: state.fold_calls,
        fold_calls_path: state.fold_calls_path,
        results_path: state.results_path,
        next: 'call_fold',
      })
    }
    if (['awaiting_fold', 'summarized'].includes(state.phase)) {
      const report = isPlainObject(state.report)
        ? state.report
        : isPlainObject(state.summary)
          ? state.summary
          : emptyDepopPhaseReport('already_uploaded')
      return depopReturnFromState(state, {
        outcome: 'already_uploaded',
        report,
        fold_calls: [],
        fold_calls_path: null,
        results_path: null,
        next: 'done',
      })
    }
    return stateInvalid('depop', `state phase ${state.phase ?? '<missing>'} cannot be uploaded`)
  }

  const exportRead = await tryReadJson(exportPath)
  if (!exportRead.ok) return exportFailure('export_failed', exportRead.failure_code, exportRead.reason, state)
  const rawExport = exportRead.value
  if (rawExport?.isError === true) {
    return exportFailure('export_refused', 'fold_tool_refused', toolText(rawExport) ?? 'Fold refused the export and gave no reason', state)
  }
  const exported = structuredFrom(rawExport)
  if (!isPlainObject(exported)) return exportFailure('export_failed', 'fold_tool_result_unreadable', 'Fold export had no structured content', state)
  const lease = normalizedExportLease(exported)
  const directory = path.dirname(state.state_path)
  const report = baseReport('depop')
  const foldCalls = []

  if (state.surface?.outcome !== 'surface_ready') {
    report.export = buildExportSummary(null, exported, lease)
    Object.assign(report, {
      outcome: 'surface_unavailable',
      failure_code: state.surface?.failure_code ?? 'bulk_listing_surface_unavailable',
      reason: state.surface?.reason ?? 'The Depop bulk surface was not ready',
      upload_report: nonEmptyString(lease.submission_id) ? null : { skipped: 'no_submission_id' },
    })
    const call = foldReportCall(lease, false, 'surface_unavailable')
    if (call !== null) foldCalls.push(call)
    const finished = finish(report)
    const callFiles = await persistDepopAwaitingFold(state, finished, foldCalls)
    return depopReturnFromState(state, { outcome: report.outcome, report: finished, fold_calls: foldCalls, ...callFiles, next: foldCalls.length > 0 ? 'call_fold' : 'done' })
  }

  const {
    materializeCsv = materializerForWorkspace(directory),
    importCsvBatch = runImportCsvBatch,
    maxReconcileReads = 30,
    phaseBudgetMs = DEFAULT_PHASE_BUDGET_MS,
    ...capabilityOptions
  } = allOptions
  if (typeof materializeCsv !== 'function') throw new TypeError('materializeCsv must be a function')
  if (typeof importCsvBatch !== 'function') throw new TypeError('importCsvBatch must be a function')
  if (!Number.isInteger(maxReconcileReads) || maxReconcileReads < 0) throw new TypeError('maxReconcileReads must be a non-negative integer')
  if (!Number.isInteger(phaseBudgetMs) || phaseBudgetMs < 1) throw new TypeError('phaseBudgetMs must be a positive integer')
  const effectiveCapabilityOptions = {
    importTimeoutMs: 120_000,
    ...capabilityOptions,
  }
  const csvPathRef = { current: null }
  let capability
  try {
    capability = await createDepopCapabilityForUpload({ browser, profile, capabilityOptions: effectiveCapabilityOptions, csvPathRef })
  } catch (error) {
    if (error instanceof TypeError) throw error
    const call = foldReportCall(lease, false, errorCode(error, 'browser_provider_unavailable'))
    if (call !== null) foldCalls.push(call)
    Object.assign(report, {
      outcome: 'browser_unavailable',
      failure_code: errorCode(error, 'browser_provider_unavailable'),
      reason: errorMessage(error),
      export: buildExportSummary(null, exported, lease),
      upload_report: call === null ? { skipped: 'no_submission_id' } : null,
    })
    const finished = finish(report)
    const callFiles = await persistDepopAwaitingFold(state, finished, foldCalls)
    return depopReturnFromState(state, { outcome: report.outcome, report: finished, fold_calls: foldCalls, ...callFiles, next: foldCalls.length > 0 ? 'call_fold' : 'done' })
  }

  let exportResult = null
  let importResult = null
  let notDelivered = null
  let uploadUnknown = null
  const startedAt = Date.now()
  try {
    exportResult = await exportDepopCsvBatch({
      fold: { exportDepopCsv: async () => ({ structuredContent: exported, content: [] }) },
      materializeCsv,
    })
  } catch (error) {
    notDelivered = { failure_code: errorCode(error, 'bulk_listing_upload_not_delivered'), reason: errorMessage(error) }
  }
  if (notDelivered === null && exportResult?.outcome === 'export_ready') {
    csvPathRef.current = exportResult.csv_path
    state.phase = 'upload_attempted'
    state.upload_attempted_at = new Date().toISOString()
    state.submission_id = nonEmptyString(lease.submission_id) ? lease.submission_id : null
    state.current_rows = exportResult.batch.rows.map((row) => rowIdentity(row)).filter((row) => row !== null)
    await persistDepopState(state)
    try {
      importResult = await importCsvBatch({ capability, batch: exportResult.batch, now })
    } catch (error) {
      uploadUnknown = {
        failure_code: errorCode(error, 'bulk_listing_upload_outcome_unknown'),
        reason: errorMessage(error),
      }
    }
  }

  report.export = buildExportSummary(exportResult, exported, lease)
  if (importResult !== null) report.import = importResult

  const delivery = importResult !== null
    ? uploadOutcomeForReport(importResult)
    : uploadUnknown !== null
      ? { uploaded: true, note: uploadUnknown.failure_code }
      : { uploaded: false, note: notDelivered?.failure_code ?? exportResult?.outcome ?? 'bulk_listing_upload_not_delivered' }
  const reportCall = foldReportCall(lease, delivery.uploaded, delivery.note)
  if (reportCall !== null) foldCalls.push(reportCall)
  report.upload_report = reportCall === null ? { skipped: 'no_submission_id' } : null

  const toRecord = []
  if (importResult !== null) {
    for (const row of importResult.imported) toRecord.push({ ...row, reconciled: false })
    for (const row of importResult.unresolved ?? []) report.listings.push(depopRowOutcome(row, importResult.failure_code))
    if (importResult.imported.length === 0 && (importResult.unresolved ?? []).length === 0) {
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
    for (const listing of Array.isArray(exported.listings) ? exported.listings : []) {
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

  const currentBatchListingIds = new Set([
    ...(exportResult?.batch?.rows ?? []).map((row) => row.listing_id),
    ...(Array.isArray(exported.listings) ? exported.listings : [])
      .map((listing) => listing?.listing_id)
      .filter(nonEmptyString),
  ])
  const shouldReconcile = lease.awaiting_confirmation.some((row) => row.delivered)
  if (shouldReconcile) {
    const remaining = phaseBudgetMs - (Date.now() - startedAt)
    if (remaining < RECONCILE_MIN_REMAINING_MS) {
      report.reconciliation = { outcome: 'skipped_budget' }
      for (const row of lease.awaiting_confirmation.filter((entry) => entry.delivered && !currentBatchListingIds.has(entry.listing_id))) {
        report.listings.push({ listing_id: row.listing_id, sku: row.sku, outcome: 'awaiting_confirmation', reconciled: true })
      }
    } else {
      const knownUrls = new Map((importResult?.imported ?? []).map((row) => [row.listing_url, row.sku]))
      const reconciliation = await reconcileDeliveredRows({
        capability,
        awaiting: lease.awaiting_confirmation,
        maxDraftReads: maxReconcileReads,
        knownUrls,
        deadline: startedAt + phaseBudgetMs,
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
  }

  const uniqueToRecord = dedupeByListingId(toRecord)
  for (const row of uniqueToRecord) {
    report.listings.push({
      listing_id: row.listing_id,
      sku: row.sku,
      outcome: 'to_record',
      listing_url: row.listing_url,
      ...(row.reconciled ? { reconciled: true } : {}),
    })
    foldCalls.push({ name: 'mark_published', args: { listing_id: row.listing_id, listing_url: row.listing_url, visibility: 'draft' } })
  }

  if (notDelivered !== null) Object.assign(report, { outcome: 'upload_not_delivered', ...notDelivered })
  else if (uploadUnknown !== null) Object.assign(report, { outcome: 'upload_outcome_unknown', ...uploadUnknown })
  else if (importResult !== null) {
    report.outcome = importResult.outcome
    if (nonEmptyString(importResult.failure_code)) {
      report.failure_code = importResult.failure_code
      report.reason = importResult.reason
    }
  } else report.outcome = exportResult.outcome

  if (allOptions.materializeCsv === undefined) await cleanupMaterializedCsv(report, csvPathRef.current)
  const finished = finish(report)
  const callFiles = await persistDepopAwaitingFold(state, finished, foldCalls)
  return depopReturnFromState(state, {
    outcome: finished.outcome,
    report: finished,
    fold_calls: foldCalls,
    ...callFiles,
    next: foldCalls.length > 0 ? 'call_fold' : 'done',
  })
}

async function freshVintedReportPath() {
  const directory = await privateTempDir('fold-vinted-')
  return path.join(directory, VINTED_STATE_FILE)
}

function vintedReportFromBatch(batch, reportPath, resultsPath, otherMarketplaceListings = []) {
  const cleanBatch = stripVintedStateEnvelope(batch)
  const report = baseReport('vinted')
  report.report_path = reportPath
  report.results_path = resultsPath
  report.draft_batch = cleanBatch
  report.other_marketplace_listings = otherMarketplaceListings
  report.listings = cleanBatch.items.map(vintedItemOutcome)
  for (const listingId of cleanBatch.pending_listings ?? []) report.listings.push({ listing_id: listingId, outcome: 'pending' })
  report.outcome = cleanBatch.outcome
  report.next = cleanBatch.next === 'record' ? 'stop' : cleanBatch.next
  if (report.next === 'continue' || report.next === 'confirm') {
    report.resume_hint = 'Call vintedDraft again with the same readyPath plus resumeFrom: report.report_path'
  }
  return finish(report)
}

function foldCallsForVinted(batch) {
  return (batch.to_record ?? []).map((entry) => ({
    name: 'mark_published',
    args: { listing_id: entry.listing_id, listing_url: entry.listing_url, visibility: 'draft' },
  }))
}

async function persistVintedFoldCalls(batch, envelope, foldCalls) {
  const callFiles = await writeFoldCallFile(envelope.workspace_dir, foldCalls)
  const postDrafts = { fold_calls: foldCalls, ...callFiles }
  await writeJsonPrivate(envelope.report_path, vintedStateFromBatch(batch, envelope, postDrafts))
  return callFiles
}

export async function vintedDraft({ browser, readyPath, memberId, resumeFrom, profile, options } = {}) {
  if (!isPlainObject(browser)) throw new TypeError('browser must be the provider options object')
  assertAbsolutePath(readyPath, 'readyPath')
  if (resumeFrom !== undefined && resumeFrom !== null) assertAbsolutePath(resumeFrom, 'resumeFrom')
  const allOptions = assertOptions(options)
  const readyRead = await tryReadJson(readyPath)
  if (!readyRead.ok) {
    const report = finish(Object.assign(baseReport('vinted'), { outcome: 'listing_failed', next: 'stop', failure_code: readyRead.failure_code, reason: readyRead.reason }))
    return {
      marketplace: 'vinted',
      outcome: report.outcome,
      report,
      fold_calls: [],
      fold_calls_path: null,
      results_path: null,
      next: 'stop',
    }
  }
  const rawReady = readyRead.value
  if (rawReady?.isError === true) {
    const report = finish(Object.assign(baseReport('vinted'), { outcome: 'listing_failed', next: 'stop', failure_code: 'fold_tool_refused', reason: toolText(rawReady) ?? 'Fold refused list_ready_listings' }))
    return {
      marketplace: 'vinted',
      outcome: report.outcome,
      report,
      fold_calls: [],
      fold_calls_path: null,
      results_path: null,
      next: 'stop',
    }
  }
  const ready = structuredFrom(rawReady)
  if (!isPlainObject(ready)) {
    const report = finish(Object.assign(baseReport('vinted'), { outcome: 'listing_failed', next: 'stop', failure_code: 'fold_tool_result_unreadable', reason: 'Fold ready-listings result had no structured content' }))
    return {
      marketplace: 'vinted',
      outcome: report.outcome,
      report,
      fold_calls: [],
      fold_calls_path: null,
      results_path: null,
      next: 'stop',
    }
  }
  const all = Array.isArray(ready.listings) ? ready.listings : []
  const vinted = all.filter((listing) => listing?.platform === 'vinted')
  const otherMarketplaceListings = all
    .filter((listing) => listing?.platform !== 'vinted')
    .map((listing) => ({ listing_id: listing?.listing_id ?? null, platform: listing?.platform ?? null }))

  if ((resumeFrom === undefined || resumeFrom === null) && vinted.length === 0) {
    const report = finish(Object.assign(baseReport('vinted'), {
      outcome: 'nothing_ready',
      other_marketplace_listings: otherMarketplaceListings,
    }))
    return {
      marketplace: 'vinted',
      outcome: report.outcome,
      report,
      fold_calls: [],
      fold_calls_path: null,
      results_path: null,
      next: 'done',
    }
  }

  let resumed
  let envelope
  const reportPath = resumeFrom ?? await freshVintedReportPath()
  if (resumeFrom !== undefined && resumeFrom !== null) {
    const resumedRead = await readVintedState(resumeFrom, { readyPath })
    if (!resumedRead.ok) {
      const refused = vintedDraftStateInvalid(resumedRead.result.reason, reportPath)
      refused.failure_code = resumedRead.result.failure_code
      refused.report.failure_code = resumedRead.result.failure_code
      return refused
    }
    const resumedState = resumedRead.state
    envelope = {
      run_id: resumedState.run_id,
      ready_path: resumedState.ready_path,
      report_path: resumedState.report_path,
      workspace_dir: resumedState.workspace_dir,
    }
    resumed = stripVintedStateEnvelope(resumedState)
    if (Array.isArray(resumed.to_record) && resumed.to_record.length > 0) {
      const foldCalls = foldCallsForVinted(resumed)
      const callFiles = await persistVintedFoldCalls(resumed, envelope, foldCalls)
      const report = vintedReportFromBatch(resumed, reportPath, callFiles.results_path, otherMarketplaceListings)
      return { marketplace: 'vinted', outcome: report.outcome, report, fold_calls: foldCalls, report_path: reportPath, ...callFiles, next: 'call_fold' }
    }
  } else {
    envelope = {
      run_id: randomUUID(),
      ready_path: readyPath,
      report_path: reportPath,
      workspace_dir: path.dirname(reportPath),
    }
  }

  let adapter
  try {
    const targetProfile = profile ?? createAuthenticatedVintedTargetProfile()
    const {
      maxDrafts = 1,
      photoDirectory,
      resolvePhotoFiles,
      ...capabilityOptions
    } = allOptions
    if (!Number.isInteger(maxDrafts) || maxDrafts < 1) throw new TypeError('maxDrafts must be a positive integer')
    const photoDir = photoDirectory ?? await privateTempDir('fold-vinted-photos-')
    const browserCapability = await createVintedBrowserCapabilityForProvider({
      ...capabilityOptions,
      ...browser,
      profile: targetProfile,
      memberId,
      resolvePhotoFiles: resolvePhotoFiles ?? createPhotoFileResolver({ directory: photoDir }),
    })
    adapter = createVintedAdapter({ browser: browserCapability, profile: targetProfile })
  } catch (error) {
    if (error instanceof TypeError) throw error
    const report = finish(Object.assign(baseReport('vinted'), {
      outcome: 'browser_unavailable',
      next: 'stop',
      failure_code: errorCode(error, 'browser_provider_unavailable'),
      reason: errorMessage(error),
    }))
    return { marketplace: 'vinted', outcome: report.outcome, report, fold_calls: [], report_path: reportPath, fold_calls_path: null, results_path: null, next: 'stop' }
  }

  const persist = (value) => writeJsonPrivate(reportPath, vintedStateFromBatch(value, envelope))
  const batch = await runDraftBatch({
    adapter,
    readyListings: { ...ready, listings: vinted, count: vinted.length },
    resumeFrom: resumed,
    maxDrafts: allOptions.maxDrafts ?? 1,
    persist,
  })
  const foldCalls = foldCallsForVinted(batch)
  const callFiles = await persistVintedFoldCalls(batch, envelope, foldCalls)
  const report = vintedReportFromBatch(batch, reportPath, callFiles.results_path, otherMarketplaceListings)
  return {
    marketplace: 'vinted',
    outcome: report.outcome,
    report,
    fold_calls: foldCalls,
    report_path: reportPath,
    ...callFiles,
    next: foldCalls.length > 0 ? 'call_fold' : report.next,
  }
}

async function summarizeDepop({ statePath, resultsPath }) {
  const stateRead = await readDepopState(statePath)
  if (!stateRead.ok) return stateRead.result
  const state = stateRead.state
  const directory = path.dirname(statePath)
  if (!pathInside(directory, resultsPath)) {
    return resultsPathOutsideWorkspace('depop', resultsPath, directory)
  }
  if (nonEmptyString(state.results_path) && state.results_path !== resultsPath) {
    return resultsPathMismatch('depop', state.results_path, resultsPath)
  }
  if (state.phase === 'summarized') return state.summary
  if (state.phase !== 'awaiting_fold' || !isPlainObject(state.report) || !Array.isArray(state.fold_calls)) {
    return stateInvalid('depop', 'state is not awaiting Fold results')
  }
  const report = clone(state.report)
  const foldErrors = []
  const answers = await readResultsForCalls(resultsPath, state.fold_calls)
  for (const [index, call] of state.fold_calls.entries()) {
    const result = answers[index].result
    if (call.name === 'report_csv_upload') {
      const failed = foldFailureFromResult(result)
      if (failed !== null) {
        report.upload_report = { ...call.args, outcome: 'report_failed', ...failed }
        foldErrors.push({ tool: call.name, ...failed })
      } else {
        report.upload_report = { ...call.args, ...structuredFrom(result) }
      }
      continue
    }
    if (call.name !== 'mark_published') continue
    const listing = report.listings.find((entry) =>
      entry.outcome === 'to_record' &&
      entry.listing_id === call.args.listing_id &&
      entry.listing_url === call.args.listing_url
    )
    const failed = foldFailureFromResult(result)
    if (listing === undefined) {
      if (failed !== null) foldErrors.push({ tool: call.name, listing_id: call.args.listing_id, ...failed })
      continue
    }
    if (failed !== null) {
      Object.assign(listing, { outcome: 'draft_unrecorded', failure_code: failed.failure_code, reason: failed.reason })
      foldErrors.push({ tool: call.name, listing_id: listing.listing_id, ...failed })
      continue
    }
    const data = structuredFrom(result)
    const outcome = data.outcome
    if (RECORDED.has(outcome)) {
      listing.outcome = 'recorded'
      listing.fold_outcome = outcome
    } else if (outcome === 'old_draft_pending_deletion') {
      // Not recorded and not failed: Fold holds the listing until its old Redo draft is deleted.
      listing.outcome = 'old_draft_pending_deletion'
      listing.fold_outcome = outcome
      listing.reason = 'Fold holds this listing until its old draft (from a Redo) is deleted; run the cleanup, then record it'
    } else {
      listing.outcome = 'draft_unrecorded'
      listing.fold_outcome = typeof outcome === 'string' ? outcome : null
      listing.failure_code = 'fold_mark_published_refused'
      listing.reason = `Fold refused the draft: ${outcome ?? 'unknown'}`
      foldErrors.push({ tool: call.name, listing_id: listing.listing_id, failure_code: listing.failure_code, reason: listing.reason })
    }
  }
  if (foldErrors.length > 0) report.fold_errors = foldErrors
  report.next = 'done'
  finish(report)
  state.phase = 'summarized'
  state.summary = report
  await persistDepopState(state)
  return report
}

async function summarizeVinted({ statePath, resultsPath }) {
  const read = await readVintedState(statePath)
  if (!read.ok) return read.result
  const state = read.state
  if (!pathInside(state.workspace_dir, resultsPath)) {
    return resultsPathOutsideWorkspace('vinted', resultsPath, state.workspace_dir)
  }
  let batch = stripVintedStateEnvelope(state)
  const postDrafts = isPlainObject(state.__fold_post_drafts) ? state.__fold_post_drafts : {}
  const expectedResultsPath = postDrafts.results_path
  if (nonEmptyString(expectedResultsPath) && expectedResultsPath !== resultsPath) {
    return resultsPathMismatch('vinted', expectedResultsPath, resultsPath)
  }
  if (postDrafts.summarized === true) {
    return vintedReportFromBatch(batch, statePath, expectedResultsPath ?? resultsPath)
  }
  const foldCalls = Array.isArray(postDrafts.fold_calls) ? postDrafts.fold_calls : foldCallsForVinted(batch)
  const answers = await readResultsForCalls(resultsPath, foldCalls)
  for (const [index, call] of foldCalls.entries()) {
    if (call.name !== 'mark_published') continue
    const result = answers[index].result
    const failed = foldFailureFromResult(result)
    const folded = failed !== null ? new Error(failed.reason) : structuredFrom(result)
    batch = recordDraftResult(batch, call.args.listing_id, folded)
    if (failed !== null) {
      const item = batch.items.find((entry) => entry.listing_id === call.args.listing_id)
      if (item !== undefined) Object.assign(item, failed)
    }
  }
  await writeJsonPrivate(statePath, vintedStateFromBatch(batch, {
    run_id: state.run_id,
    ready_path: state.ready_path,
    report_path: state.report_path,
    workspace_dir: state.workspace_dir,
  }, { ...postDrafts, fold_calls: [], summarized: true }))
  const report = vintedReportFromBatch(batch, statePath, resultsPath)
  report.next = batch.next
  if (report.next === 'record') report.next = 'stop'
  return report
}

export async function summarizeResults({ statePath, resultsPath } = {}) {
  assertAbsolutePath(statePath, 'statePath')
  assertAbsolutePath(resultsPath, 'resultsPath')
  const peek = await tryReadJson(statePath)
  if (!peek.ok) return stateInvalid('depop', peek.reason)
  if (peek.value?.state_version === POST_DRAFTS_STATE_VERSION && peek.value?.marketplace === 'depop') {
    return summarizeDepop({ statePath, resultsPath })
  }
  if (peek.value?.state_version === POST_DRAFTS_STATE_VERSION && peek.value?.marketplace === 'vinted') {
    return summarizeVinted({ statePath, resultsPath })
  }
  if (peek.value?.state_version === GO_LIVE_STATE_VERSION && GO_LIVE_MARKETPLACES.has(peek.value?.marketplace)) {
    return summarizeGoLive({ statePath, resultsPath })
  }
  return stateInvalid('unknown', 'state file is not a recognized post-drafts state')
}

// ---------------------------------------------------------------------------------------------
// Go-live: the seller explicitly asked for drafts Fold recorded to be made live.
// ---------------------------------------------------------------------------------------------

const GO_LIVE_MARKETPLACES = new Set(['vinted', 'depop'])
const GO_LIVE_STATE_FILE = 'go-live.json'
const GO_LIVE_WORKSPACE_PREFIX = 'fold-golive-'
const GO_LIVE_DRAFTED_PREFIX = 'fold-drafted-'
const GO_LIVE_DRAFTED_FILE = 'drafted.json'
const GO_LIVE_MIN_REMAINING_MS = 60_000
const LIVE_RECORDED = new Set(['live', 'already_live'])

function goLiveWhere(marketplace) {
  return marketplace === 'depop' ? 'Depop' : 'Vinted'
}

function goLiveSummaryText(report) {
  const where = goLiveWhere(report.marketplace)
  const by = (outcomes) => report.listings.filter((entry) => outcomes.includes(entry.outcome))
  const lines = []
  if (report.listings.length === 0) {
    if (report.outcome === 'browser_unavailable') lines.push(`The ${where} page was not usable (${report.failure_code}), so nothing was made live.`)
    else if (report.outcome === 'listing_failed') lines.push(`Fold did not hand over the drafted listings: ${report.reason}`)
    else lines.push(`No ${where} drafts recorded in Fold were waiting to go live.`)
  }
  const live = by(['live'])
  if (live.length > 0) {
    lines.push(`${plural(live.length, 'listing')} live on ${where}: ${live.map((entry) => entry.public_url).join(', ')}.`)
    const notYet = live.filter((entry) => entry.recorded === false)
    if (notYet.length > 0 && report.summarized === true) lines.push(`${plural(notYet.length, 'listing')} not yet recorded as live in Fold.`)
  }
  const unrecorded = by(['live_unrecorded'])
  if (unrecorded.length > 0) lines.push(`${plural(unrecorded.length, 'listing')} live on ${where} but Fold did not record it; see each reason.`)
  const incomplete = by(['incomplete'])
  if (incomplete.length > 0) lines.push(`${plural(incomplete.length, 'draft')} need required fields filled on ${where} before they can go live.`)
  const mismatch = by(['mismatch'])
  if (mismatch.length > 0) lines.push(`${plural(mismatch.length, 'draft')} could not be confirmed as Fold's draft, so nothing was clicked.`)
  const unconfirmed = by(['unconfirmed'])
  if (unconfirmed.length > 0) lines.push(`${plural(unconfirmed.length, 'draft')} may have gone live but could not be confirmed; nothing is ever pressed twice, so check ${where} by hand.`)
  const errors = by(['error'])
  if (errors.length > 0) lines.push(`${plural(errors.length, 'draft')} hit an error before anything was clicked.`)
  const waiting = by(['not_attempted'])
  if (waiting.length > 0) lines.push(`${plural(waiting.length, 'draft')} left for the next go-live call.`)
  return lines.join(' ')
}

function goLiveReport(marketplace, extra = {}) {
  const report = {
    report_version: GO_LIVE_REPORT_VERSION,
    kind: 'go_live',
    marketplace,
    outcome: null,
    next: 'done',
    summary_text: '',
    listings: [],
    ...extra,
  }
  report.summary_text = goLiveSummaryText(report)
  return report
}

function goLiveStop(marketplace, outcome, failureCode, reason) {
  const report = goLiveReport(marketplace, { outcome, failure_code: failureCode, reason })
  return { marketplace, outcome, report, state_path: null, fold_calls: [], fold_calls_path: null, results_path: null, next: 'done' }
}

function assertListingIds(value) {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value) || value.some((id) => !nonEmptyString(id))) {
    throw new TypeError('listingIds must be an array of non-empty strings')
  }
  return new Set(value)
}

/**
 * Shared body of the two go-live phases. One `js` call: every browser action starts and finishes
 * here, and Fold's `mark_live` calls are handed back as a `fold_calls` file for the exec step.
 */
/** The listing ids an earlier go-live call already pressed for, from its validated state. */
async function goLivePriorPressed(marketplace, priorStatePath) {
  if (priorStatePath === undefined || priorStatePath === null) return { ok: true, ids: new Set() }
  assertAbsolutePath(priorStatePath, 'priorStatePath')
  const read = await tryReadJson(priorStatePath)
  if (!read.ok) return { ok: false, reason: read.reason }
  const state = read.value
  if (
    state?.state_version !== GO_LIVE_STATE_VERSION ||
    state.marketplace !== marketplace ||
    state.state_path !== priorStatePath ||
    path.basename(priorStatePath) !== GO_LIVE_STATE_FILE
  ) {
    return { ok: false, reason: 'priorStatePath is not a go-live state for this marketplace' }
  }
  const workspaceError = await validatePrivateWorkspace({
    workspaceDir: path.dirname(priorStatePath),
    statePath: priorStatePath,
    prefix: GO_LIVE_WORKSPACE_PREFIX,
    stateFile: GO_LIVE_STATE_FILE,
  })
  if (workspaceError !== null) return { ok: false, reason: workspaceError }
  return { ok: true, ids: new Set(Array.isArray(state.pressed_listing_ids) ? state.pressed_listing_ids.filter(nonEmptyString) : []) }
}

async function runGoLive(marketplace, { browser, draftedPath, listingIds, profile, options, priorStatePath }, createCapability, defaultProfile) {
  if (!isPlainObject(browser)) throw new TypeError('browser must be the provider options object')
  assertAbsolutePath(draftedPath, 'draftedPath')
  const only = assertListingIds(listingIds)
  const allOptions = assertOptions(options)
  const { phaseBudgetMs = DEFAULT_PHASE_BUDGET_MS, ...capabilityOptions } = allOptions
  if (!Number.isInteger(phaseBudgetMs) || phaseBudgetMs < 1) throw new TypeError('phaseBudgetMs must be a positive integer')
  const startedAt = Date.now()

  // The drafted-listings input is written by the host's exec step as drafted.json in a private
  // mkdtemp folder (fold-drafted-*, 0700, this user) with mode 0600; anything else is refused.
  const fileError = await validatePrivateWorkspace({
    workspaceDir: path.dirname(draftedPath),
    statePath: draftedPath,
    prefix: GO_LIVE_DRAFTED_PREFIX,
    stateFile: GO_LIVE_DRAFTED_FILE,
  })
  if (fileError !== null) return goLiveStop(marketplace, 'state_invalid', 'drafted_path_invalid', fileError)
  const prior = await goLivePriorPressed(marketplace, priorStatePath)
  if (!prior.ok) return goLiveStop(marketplace, 'state_invalid', 'prior_state_invalid', prior.reason)

  const read = await tryReadJson(draftedPath)
  if (!read.ok) return goLiveStop(marketplace, 'listing_failed', read.failure_code, read.reason)
  if (read.value?.isError === true) {
    return goLiveStop(marketplace, 'listing_failed', 'fold_tool_refused', toolText(read.value) ?? 'Fold refused list_drafted_listings')
  }
  const drafted = structuredFrom(read.value)
  if (!isPlainObject(drafted)) {
    return goLiveStop(marketplace, 'listing_failed', 'fold_tool_result_unreadable', 'Fold drafted-listings result had no structured content')
  }
  const all = Array.isArray(drafted.listings) ? drafted.listings.filter(isPlainObject) : []
  const mine = all.filter((listing) => listing.platform === marketplace && (only === null || only.has(listing.listing_id)))
  const otherMarketplaceListings = all
    .filter((listing) => listing.platform !== marketplace)
    .map((listing) => ({ listing_id: listing.listing_id ?? null, platform: listing.platform ?? null }))
  const missing = only === null ? [] : [...only].filter((id) => !mine.some((listing) => listing.listing_id === id))

  if (mine.length === 0) {
    const report = goLiveReport(marketplace, {
      outcome: 'nothing_drafted',
      other_marketplace_listings: otherMarketplaceListings,
      ...(missing.length > 0 ? { not_drafted_listing_ids: missing } : {}),
    })
    return { marketplace, outcome: report.outcome, report, state_path: null, fold_calls: [], fold_calls_path: null, results_path: null, next: 'done' }
  }

  let capability
  try {
    capability = await createCapability({ ...capabilityOptions, ...browser, profile: profile ?? defaultProfile() })
  } catch (error) {
    if (error instanceof TypeError) throw error
    return goLiveStop(marketplace, 'browser_unavailable', errorCode(error, 'browser_provider_unavailable'), errorMessage(error))
  }

  const listings = []
  const foldCalls = []
  const workspace = await privateTempDir(GO_LIVE_WORKSPACE_PREFIX)
  const statePath = path.join(workspace, GO_LIVE_STATE_FILE)
  const pressedSoFar = () => [...new Set([...prior.ids, ...listings.filter((entry) => entry.pressed === true).map((entry) => entry.listing_id)])]

  /**
   * Records one listing's result and, before the next listing is touched, writes the state with
   * every press and every mark_live call so far — a throw or timeout later never loses a press.
   */
  async function record(entry) {
    listings.push(entry)
    await writeJsonPrivate(statePath, {
      state_version: GO_LIVE_STATE_VERSION,
      kind: 'go_live',
      marketplace,
      state_path: statePath,
      phase: 'in_progress',
      report: goLiveReport(marketplace, { outcome: 'in_progress', listings }),
      pressed_listing_ids: pressedSoFar(),
      fold_calls: foldCalls,
    })
  }

  for (const listing of mine) {
    if (phaseBudgetMs - (Date.now() - startedAt) < GO_LIVE_MIN_REMAINING_MS && listings.length > 0) {
      await record({
        listing_id: listing.listing_id,
        ...(nonEmptyString(listing.sku) ? { sku: listing.sku } : {}),
        draft_url: listing.draft_url ?? null,
        outcome: 'not_attempted',
        message: 'Left for the next go-live call so this one finishes inside its time budget.',
      })
      continue
    }
    // A listing pressed in any earlier call is never pressed again: read-only proof only.
    const result = await capability.goLive({
      listing_id: listing.listing_id,
      sku: listing.sku,
      draft_url: listing.draft_url,
      ...(prior.ids.has(listing.listing_id) ? { reconcileOnly: true } : {}),
    })
    const entry = { ...result }
    if (entry.sku === null || entry.sku === undefined) delete entry.sku
    if (marketplace === 'vinted' && nonEmptyString(listing.sku)) entry.sku = listing.sku
    if (entry.outcome === 'live') {
      entry.recorded = false
      foldCalls.push({ name: 'mark_live', args: { listing_id: listing.listing_id, listing_url: entry.public_url } })
    }
    await record(entry)
  }

  const callFiles = await writeFoldCallFile(workspace, foldCalls)
  const leftover = listings.some((entry) => entry.outcome === 'not_attempted')
  const report = goLiveReport(marketplace, {
    outcome: leftover ? 'partial' : 'completed',
    next: leftover ? 'continue' : 'done',
    listings,
    other_marketplace_listings: otherMarketplaceListings,
    ...(missing.length > 0 ? { not_drafted_listing_ids: missing } : {}),
    state_path: statePath,
    results_path: callFiles.results_path,
  })
  if (leftover) {
    report.resume_hint = 'Run the Fold calls, call list_drafted_listings again, and rerun with priorStatePath: this state_path and listingIds: the not_attempted ids'
    report.not_attempted_listing_ids = listings.filter((entry) => entry.outcome === 'not_attempted').map((entry) => entry.listing_id)
  }
  const pressedIds = pressedSoFar()
  await writeJsonPrivate(statePath, {
    state_version: GO_LIVE_STATE_VERSION,
    kind: 'go_live',
    marketplace,
    state_path: statePath,
    phase: 'awaiting_fold',
    report,
    pressed_listing_ids: pressedIds,
    fold_calls: foldCalls,
    ...callFiles,
  })
  return {
    marketplace,
    outcome: report.outcome,
    report,
    state_path: statePath,
    fold_calls: foldCalls,
    ...callFiles,
    next: foldCalls.length > 0 ? 'call_fold' : report.next,
  }
}

/**
 * Takes Fold-recorded Vinted drafts live. One `js` call. `draftedPath` holds the raw
 * `list_drafted_listings` result; `listingIds`, when given, limits the run to those listings (the
 * ones this run drafted, for "post these live"). Returns `{ report, fold_calls, fold_calls_path,
 * results_path, state_path, next }`; `next` is `'call_fold'` when there are `mark_live` calls.
 */
export async function vintedGoLive(input = {}) {
  return runGoLive('vinted', input, createVintedGoLiveCapabilityForProvider, createAuthenticatedVintedTargetProfile)
}

/** The Depop sibling of `vintedGoLive`: Post on each recorded draft, proven by SKU. */
export async function depopGoLive(input = {}) {
  return runGoLive('depop', input, createDepopGoLiveCapabilityForProvider, createAuthenticatedDepopTargetProfile)
}

async function summarizeGoLive({ statePath, resultsPath }) {
  const read = await tryReadJson(statePath)
  if (!read.ok) return stateInvalid('unknown', read.reason)
  const state = read.value
  const marketplace = GO_LIVE_MARKETPLACES.has(state?.marketplace) ? state.marketplace : 'unknown'
  if (state.state_path !== statePath || path.basename(statePath) !== GO_LIVE_STATE_FILE) {
    return stateInvalid(marketplace, 'state_path does not match the file being read')
  }
  const directory = path.dirname(statePath)
  const workspaceError = await validatePrivateWorkspace({
    workspaceDir: directory,
    statePath,
    prefix: GO_LIVE_WORKSPACE_PREFIX,
    stateFile: GO_LIVE_STATE_FILE,
  })
  if (workspaceError !== null) return stateInvalid(marketplace, workspaceError)
  if (!pathInside(directory, resultsPath)) return resultsPathOutsideWorkspace(marketplace, resultsPath, directory)
  if (nonEmptyString(state.results_path) && state.results_path !== resultsPath) {
    return resultsPathMismatch(marketplace, state.results_path, resultsPath)
  }
  if (state.phase === 'summarized' && isPlainObject(state.summary)) return state.summary
  if (state.phase !== 'awaiting_fold' || !isPlainObject(state.report) || !Array.isArray(state.fold_calls)) {
    return stateInvalid(marketplace, 'state is not awaiting Fold results')
  }
  const report = clone(state.report)
  const foldErrors = []
  const answers = await readResultsForCalls(resultsPath, state.fold_calls)
  for (const [index, call] of state.fold_calls.entries()) {
    if (call.name !== 'mark_live') continue
    const result = answers[index].result
    const listing = report.listings.find((entry) =>
      entry.outcome === 'live' && entry.listing_id === call.args.listing_id && entry.public_url === call.args.listing_url
    )
    const failed = foldFailureFromResult(result)
    if (listing === undefined) {
      if (failed !== null) foldErrors.push({ tool: call.name, listing_id: call.args.listing_id, ...failed })
      continue
    }
    if (failed !== null) {
      Object.assign(listing, { outcome: 'live_unrecorded', failure_code: failed.failure_code, reason: failed.reason })
      foldErrors.push({ tool: call.name, listing_id: listing.listing_id, ...failed })
      continue
    }
    const outcome = structuredFrom(result).outcome
    if (LIVE_RECORDED.has(outcome)) {
      listing.recorded = true
      listing.fold_outcome = outcome
    } else {
      Object.assign(listing, {
        outcome: 'live_unrecorded',
        fold_outcome: typeof outcome === 'string' ? outcome : null,
        failure_code: 'fold_mark_live_refused',
        reason: `Fold did not record the live listing: ${outcome ?? 'unknown'}`,
      })
      foldErrors.push({ tool: call.name, listing_id: listing.listing_id, failure_code: listing.failure_code, reason: listing.reason })
    }
  }
  if (foldErrors.length > 0) report.fold_errors = foldErrors
  report.summarized = true
  report.summary_text = goLiveSummaryText(report)
  state.phase = 'summarized'
  state.summary = report
  await writeJsonPrivate(statePath, state)
  return report
}
