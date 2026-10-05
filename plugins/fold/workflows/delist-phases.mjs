import path from 'node:path'

import { createAuthenticatedDepopTargetProfile } from '../adapters/depop/profile.mjs'
import {
  createDepopDelistCapabilityForProvider,
  createDepopDraftDeleteCapabilityForProvider,
} from '../adapters/depop/provider-capabilities.mjs'
import { createAuthenticatedVintedTargetProfile } from '../adapters/vinted/profile.mjs'
import {
  createVintedDelistCapabilityForProvider,
  createVintedDraftDeleteCapabilityForProvider,
} from '../adapters/vinted/provider-capabilities.mjs'
import { deleteDraftSiblings, delistApprovedSiblings, delistReportCalls, liveTakedownOutcome } from './delist.mjs'
import {
  assertAbsolutePath,
  assertOptions,
  clone,
  errorCode,
  errorMessage,
  foldFailureFromResult,
  isPlainObject,
  nonEmptyString,
  pathInside,
  privateTempDir,
  readResultsForCalls,
  structuredFrom,
  toolText,
  tryReadJson,
  validatePrivateWorkspace,
  writeFoldCallFile,
  writeJsonPrivate,
} from './phase-files.mjs'

/**
 * Delist phases for the sold/Delist-all flow. Each runs inside ONE host `js` call — every browser
 * action starts and finishes there — and hands its Fold calls back as a private `fold_calls` file
 * the host's exec step runs, exactly like the draft-posting phases.
 *
 * Per copy, by Fold's `kind`:
 * - `draft`: deleted at the exact draft URL Fold recorded (the draft-delete capability), never
 *   searched for on Active/Selling. A Depop draft with no recorded URL is found by its exact SKU in
 *   the drafts views; an ambiguous SKU stops it.
 * - `live` (or no kind, from an older Fold): taken down by the existing delist path
 *   (`delistApprovedSiblings`) — Depop by SKU on Active/Selling, Vinted at its recorded item URL.
 *
 * `report_delist({ listing_ids, resolution: 'confirmed' })` is named for every copy proven gone
 * (`deleted`, `already_deleted`, `not_found`); everything else stays open in Fold and is reported.
 */

export const DELIST_REPORT_VERSION = 'fold-delist/1'
export const DELIST_STATE_VERSION = 'fold-delist-state/1'
export const DELIST_JS_TIMEOUT_MS = 300_000

const STATE_FILE = 'delist.json'
const PENDING_FILE = 'pending.json'
const PENDING_PREFIX = 'fold-pending-'
const WORKSPACE_PREFIX = 'fold-delist-'
const DEFAULT_PHASE_BUDGET_MS = 270_000
const MIN_REMAINING_MS = 60_000
const OPEN_ATTEMPTS = new Set(['accepted', 'pending'])

function plural(count, word, many = `${word}s`) {
  return `${count} ${count === 1 ? word : many}`
}

function where(marketplace) {
  return marketplace === 'depop' ? 'Depop' : 'Vinted'
}

function summaryText(report) {
  const by = (outcomes) => report.listings.filter((entry) => outcomes.includes(entry.outcome))
  const lines = []
  const at = where(report.marketplace)
  if (report.listings.length === 0) {
    if (report.outcome === 'listing_failed') lines.push(`Fold did not hand over the pending delists: ${report.reason}`)
    else lines.push(`Nothing on ${at} is waiting to be taken down.`)
  }
  const deletedDrafts = by(['deleted']).filter((entry) => entry.kind === 'draft')
  const takenDown = by(['deleted']).filter((entry) => entry.kind !== 'draft')
  if (deletedDrafts.length > 0) lines.push(`${plural(deletedDrafts.length, 'draft')} deleted on ${at}.`)
  if (takenDown.length > 0) lines.push(`${plural(takenDown.length, 'live listing')} taken down on ${at}.`)
  const gone = by(['already_deleted', 'not_found'])
  if (gone.length > 0) lines.push(`${plural(gone.length, 'copy', 'copies')} already gone from ${at}.`)
  const posted = by(['went_live'])
  if (posted.length > 0) lines.push(`${plural(posted.length, 'draft')} turned out to be posted (live) on ${at} and could not be taken down here; left open.`)
  const open = by(['mismatch', 'unconfirmed', 'error', 'inference_required', 'not_attempted'])
  if (open.length > 0) lines.push(`${plural(open.length, 'copy', 'copies')} left open in Fold; see each reason.`)
  if (report.summarized === true) {
    const recorded = report.listings.filter((entry) => entry.fold_outcome !== undefined && entry.fold_outcome !== null)
    if (recorded.length > 0) lines.push(`Fold closed ${plural(recorded.length, 'copy', 'copies')}.`)
  }
  return lines.join(' ')
}

function delistReport(marketplace, extra = {}) {
  const report = {
    report_version: DELIST_REPORT_VERSION,
    kind: 'delist',
    marketplace,
    outcome: null,
    next: 'done',
    summary_text: '',
    listings: [],
    ...extra,
  }
  report.summary_text = summaryText(report)
  return report
}

function stop(marketplace, outcome, failureCode, reason) {
  const report = delistReport(marketplace, { outcome, failure_code: failureCode, reason })
  return { marketplace, outcome, report, state_path: null, fold_calls: [], fold_calls_path: null, results_path: null, next: 'done' }
}

function stateInvalid(marketplace, reason, failureCode = 'state_invalid') {
  const report = delistReport(marketplace, { outcome: 'state_invalid', failure_code: failureCode, reason })
  return { marketplace, outcome: 'state_invalid', report, failure_code: failureCode, reason, next: 'stop', fold_calls: [] }
}

function assertListingIds(value) {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value) || value.some((id) => !nonEmptyString(id))) {
    throw new TypeError('listingIds must be an array of non-empty strings')
  }
  return new Set(value)
}

/**
 * The open copies for one marketplace, from either `list_pending_delists` (`{ delists }`, every
 * entry names its platform) or `delist_sold_siblings` (`{ results }`, no platform: those entries
 * are taken only when `listingIds` names them, and only while their attempt is open).
 */
function pendingCopies(data, marketplace, only) {
  if (Array.isArray(data.delists)) {
    return data.delists.filter(
      (entry) => isPlainObject(entry) && entry.platform === marketplace && (only === null || only.has(entry.listing_id))
    )
  }
  if (Array.isArray(data.results)) {
    return data.results.filter(
      (entry) =>
        isPlainObject(entry) &&
        (entry.platform === undefined ? only !== null : entry.platform === marketplace) &&
        (only === null || only.has(entry.listing_id)) &&
        OPEN_ATTEMPTS.has(entry.outcome)
    )
  }
  return []
}

function notAttempted(copy) {
  return {
    listing_id: copy.listing_id,
    ...(nonEmptyString(copy.sku) ? { sku: copy.sku } : {}),
    kind: copy.kind ?? null,
    outcome: 'not_attempted',
    message: 'Left for the next delist call so this one finishes inside its time budget.',
  }
}

/**
 * The pending-delists input file: written by the host's exec step as `pending.json` in a private
 * `mkdtemp` folder (`fold-pending-*`, 0700, owned by this user) with mode 0600. Anything else is
 * refused before it is read.
 */
async function pendingFileError(pendingPath) {
  return await validatePrivateWorkspace({
    workspaceDir: path.dirname(pendingPath),
    statePath: pendingPath,
    prefix: PENDING_PREFIX,
    stateFile: PENDING_FILE,
  })
}

/** The listing ids a prior delist call already pressed a delete for, from its validated state. */
async function priorPressedIds(marketplace, priorStatePath) {
  if (priorStatePath === undefined || priorStatePath === null) return { ok: true, ids: new Set() }
  assertAbsolutePath(priorStatePath, 'priorStatePath')
  const read = await tryReadJson(priorStatePath)
  if (!read.ok) return { ok: false, reason: read.reason }
  const state = read.value
  if (
    state?.state_version !== DELIST_STATE_VERSION ||
    state.marketplace !== marketplace ||
    state.state_path !== priorStatePath ||
    path.basename(priorStatePath) !== STATE_FILE
  ) {
    return { ok: false, reason: 'priorStatePath is not a delist state for this marketplace' }
  }
  const workspaceError = await validatePrivateWorkspace({
    workspaceDir: path.dirname(priorStatePath),
    statePath: priorStatePath,
    prefix: WORKSPACE_PREFIX,
    stateFile: STATE_FILE,
  })
  if (workspaceError !== null) return { ok: false, reason: workspaceError }
  const ids = Array.isArray(state.pressed_listing_ids) ? state.pressed_listing_ids.filter(nonEmptyString) : []
  return { ok: true, ids: new Set(ids) }
}

async function runDelist(marketplace, input, factories) {
  const { browser, pendingPath, listingIds, memberId, profile, options, priorStatePath, draftsOnly = false } = input
  if (!isPlainObject(browser)) throw new TypeError('browser must be the provider options object')
  if (typeof draftsOnly !== 'boolean') throw new TypeError('draftsOnly must be a boolean')
  assertAbsolutePath(pendingPath, 'pendingPath')
  const only = assertListingIds(listingIds)
  const { phaseBudgetMs = DEFAULT_PHASE_BUDGET_MS, ...capabilityOptions } = assertOptions(options)
  if (!Number.isInteger(phaseBudgetMs) || phaseBudgetMs < 1) throw new TypeError('phaseBudgetMs must be a positive integer')
  const startedAt = Date.now()
  const remaining = () => phaseBudgetMs - (Date.now() - startedAt)

  const fileError = await pendingFileError(pendingPath)
  if (fileError !== null) return stop(marketplace, 'state_invalid', 'pending_path_invalid', fileError)
  const prior = await priorPressedIds(marketplace, priorStatePath)
  if (!prior.ok) return stop(marketplace, 'state_invalid', 'prior_state_invalid', prior.reason)

  const read = await tryReadJson(pendingPath)
  if (!read.ok) return stop(marketplace, 'listing_failed', read.failure_code, read.reason)
  if (read.value?.isError === true) {
    return stop(marketplace, 'listing_failed', 'fold_tool_refused', toolText(read.value) ?? 'Fold refused the pending delists')
  }
  const data = structuredFrom(read.value)
  if (!isPlainObject(data)) return stop(marketplace, 'listing_failed', 'fold_tool_result_unreadable', 'Fold returned no structured content')
  // draftsOnly (the pre-draft cleanup of a Redo or Delist all): delete drafts, never touch a live
  // listing — live copies are left for the sold/delist flow.
  const copies = pendingCopies(data, marketplace, only).filter((copy) => !draftsOnly || copy.kind === 'draft')
  if (copies.length === 0) {
    const report = delistReport(marketplace, { outcome: 'nothing_pending' })
    return { marketplace, outcome: report.outcome, report, state_path: null, fold_calls: [], fold_calls_path: null, results_path: null, next: 'done' }
  }

  const targetProfile = profile ?? factories.profile()
  const providerOptions = { ...capabilityOptions, ...browser, profile: targetProfile, memberId }
  const drafts = copies.filter((copy) => copy.kind === 'draft')
  const live = copies.filter((copy) => copy.kind !== 'draft')
  const listings = []
  const wentLive = []
  const workspace = await privateTempDir(WORKSPACE_PREFIX)
  const statePath = path.join(workspace, STATE_FILE)
  const pressedSoFar = () => [...new Set([
    ...prior.ids,
    ...[...listings, ...wentLive.map(({ result }) => result)].filter((entry) => entry.pressed === true).map((entry) => entry.listing_id),
  ])]

  /**
   * Records one copy's result and, before the next copy is touched, writes the state with every
   * press so far — so a throw or a timeout later in this call never loses a press record.
   */
  async function record(entry) {
    if (entry !== null) listings.push(entry)
    await writeJsonPrivate(statePath, {
      state_version: DELIST_STATE_VERSION,
      kind: 'delist',
      marketplace,
      state_path: statePath,
      phase: 'in_progress',
      report: delistReport(marketplace, { outcome: 'in_progress', listings }),
      pressed_listing_ids: pressedSoFar(),
      fold_calls: delistReportCalls(listings),
    })
  }

  async function capabilityOrError(create, group) {
    try {
      return await create(providerOptions)
    } catch (error) {
      if (error instanceof TypeError) throw error
      for (const copy of group) {
        listings.push({
          listing_id: copy.listing_id,
          ...(nonEmptyString(copy.sku) ? { sku: copy.sku } : {}),
          kind: copy.kind ?? null,
          outcome: 'error',
          failure_code: errorCode(error, 'browser_provider_unavailable'),
          message: errorMessage(error),
        })
      }
      return null
    }
  }

  if (drafts.length > 0) {
    const draftCapability = await capabilityOrError(factories.draftDelete, drafts)
    const needsFind = factories.findBySku && drafts.some((copy) => !nonEmptyString(copy.draft_url))
    const findCapability = draftCapability !== null && needsFind ? await capabilityOrError(factories.live, []) : null
    if (draftCapability !== null) {
      for (const copy of drafts) {
        if (remaining() < MIN_REMAINING_MS && listings.length > 0) {
          await record(notAttempted(copy))
          continue
        }
        const [result] = await deleteDraftSiblings({
          draftCapability,
          findCapability,
          siblings: [{
            listing_id: copy.listing_id,
            sku: copy.sku,
            draft_url: copy.draft_url,
            ...(prior.ids.has(copy.listing_id) ? { reconcileOnly: true } : {}),
          }],
        })
        // A posted draft is a live listing now: take it down with the live copies, never confirm it.
        if (result.outcome === 'went_live' && draftsOnly) {
          await record({ ...result, message: `${result.message} Not taken down: this cleanup only deletes drafts.` })
        } else if (result.outcome === 'went_live') {
          wentLive.push({ copy, result })
          await record(null)
        } else await record(result)
      }
    }
  }

  const liveCopies = [
    ...live.map((copy) => ({ copy, wentLive: null })),
    ...wentLive.map(({ copy, result }) => ({
      copy: { ...copy, kind: 'live', external_url: result.public_url ?? copy.external_url ?? null },
      wentLive: result,
    })),
  ]
  if (liveCopies.length > 0) {
    let capability = null
    let capabilityFailed = false
    for (const { copy, wentLive: earlier } of liveCopies) {
      if (remaining() < MIN_REMAINING_MS && listings.length > 0) {
        await record(earlier === null ? notAttempted(copy) : { ...earlier, message: `${earlier.message} Left open for the next delist call to take down.` })
        continue
      }
      const sibling = factories.liveSibling(copy)
      if (sibling.error !== undefined) {
        await record(earlier === null ? sibling.error : { ...earlier, failure_code: sibling.error.failure_code, message: `${earlier.message} ${sibling.error.message}` })
        continue
      }
      if (capability === null && !capabilityFailed) {
        capability = await capabilityOrError(factories.live, [])
        capabilityFailed = capability === null
      }
      if (capability === null) {
        await record({
          listing_id: copy.listing_id,
          ...(nonEmptyString(copy.sku) ? { sku: copy.sku } : {}),
          kind: 'live',
          outcome: 'error',
          failure_code: 'browser_provider_unavailable',
          message: 'The live delist surface could not be opened; nothing was clicked.',
        })
        continue
      }
      // One sibling per call, so every takedown sits behind its own time-budget check.
      const { results } = await delistApprovedSiblings({ capability, siblings: [sibling.sibling] })
      for (const result of results) {
        const entry = liveTakedownOutcome(result)
        if (earlier !== null) {
          entry.went_live = true
          // A posted draft that the live path also could not find is still not proven gone.
          if (entry.outcome === 'not_found') {
            entry.outcome = 'went_live'
            entry.message = 'Posted from its draft, but the live listing could not be found to take down; left open.'
          }
        }
        await record(entry)
      }
    }
  }

  const foldCalls = delistReportCalls(listings)
  const callFiles = await writeFoldCallFile(workspace, foldCalls)
  const leftover = listings.some((entry) => entry.outcome === 'not_attempted')
  const pressedIds = pressedSoFar()
  const report = delistReport(marketplace, {
    outcome: leftover ? 'partial' : 'completed',
    next: leftover ? 'continue' : 'done',
    listings,
    state_path: statePath,
    results_path: callFiles.results_path,
  })
  if (leftover) {
    report.resume_hint = 'Run the Fold calls, call list_pending_delists again, and rerun with priorStatePath: this state_path and listingIds: the not_attempted ids'
    report.not_attempted_listing_ids = listings.filter((entry) => entry.outcome === 'not_attempted').map((entry) => entry.listing_id)
  }
  await writeJsonPrivate(statePath, {
    state_version: DELIST_STATE_VERSION,
    kind: 'delist',
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

function missingInput(copy, failureCode, message) {
  return {
    error: {
      listing_id: copy.listing_id,
      ...(nonEmptyString(copy.sku) ? { sku: copy.sku } : {}),
      kind: copy.kind ?? null,
      outcome: 'error',
      failure_code: failureCode,
      message,
    },
  }
}

/**
 * `draftsOnly: true` restricts a run to drafted copies (the pre-draft cleanup after a Redo or a
 * Delist all): no live listing is taken down, and a draft found posted stays open as went_live.
 *
 * Deletes Vinted drafts and takes down Vinted live listings for the open delists in `pendingPath`
 * (the raw `list_pending_delists` result, or `delist_sold_siblings` results with `listingIds`).
 * One `js` call. `memberId` (the seller's wardrobe id) is required for live takedowns.
 */
export async function vintedDelist(input = {}) {
  return runDelist('vinted', input, {
    profile: createAuthenticatedVintedTargetProfile,
    draftDelete: createVintedDraftDeleteCapabilityForProvider,
    live: createVintedDelistCapabilityForProvider,
    findBySku: false,
    liveSibling(copy) {
      const url = copy.external_url ?? copy.listing_url ?? null
      if (!nonEmptyString(url)) {
        return missingInput(copy, 'vinted_delist_url_missing', 'Fold gave no external_url for this live Vinted copy; remove it on Vinted by hand.')
      }
      return { sibling: { listing_id: copy.listing_id, listing_url: url, title: copy.title } }
    },
  })
}

/** The Depop sibling of `vintedDelist`: drafts deleted at their draft URL, live copies by SKU. */
export async function depopDelist(input = {}) {
  return runDelist('depop', input, {
    profile: createAuthenticatedDepopTargetProfile,
    draftDelete: createDepopDraftDeleteCapabilityForProvider,
    live: createDepopDelistCapabilityForProvider,
    findBySku: true,
    liveSibling(copy) {
      if (!nonEmptyString(copy.sku)) {
        return missingInput(copy, 'depop_delist_sku_missing', 'Fold gave no SKU to find this listing on Active/Selling.')
      }
      return { sibling: { listing_id: copy.listing_id, sku: copy.sku } }
    },
  })
}

/** Folds the `report_delist` answer into a delist phase's report. Idempotent. */
export async function summarizeDelist({ statePath, resultsPath } = {}) {
  assertAbsolutePath(statePath, 'statePath')
  assertAbsolutePath(resultsPath, 'resultsPath')
  const read = await tryReadJson(statePath)
  if (!read.ok) return stateInvalid('unknown', read.reason)
  const state = read.value
  const marketplace = ['vinted', 'depop'].includes(state?.marketplace) ? state.marketplace : 'unknown'
  if (state?.state_version !== DELIST_STATE_VERSION || state.state_path !== statePath || path.basename(statePath) !== STATE_FILE) {
    return stateInvalid(marketplace, 'state file is not a delist state')
  }
  const directory = path.dirname(statePath)
  const workspaceError = await validatePrivateWorkspace({ workspaceDir: directory, statePath, prefix: WORKSPACE_PREFIX, stateFile: STATE_FILE })
  if (workspaceError !== null) return stateInvalid(marketplace, workspaceError)
  if (!pathInside(directory, resultsPath)) {
    return stateInvalid(marketplace, `resultsPath ${resultsPath} is not directly inside workspace ${directory}`, 'results_path_outside_workspace')
  }
  if (nonEmptyString(state.results_path) && state.results_path !== resultsPath) {
    return stateInvalid(marketplace, `resultsPath ${resultsPath} does not match expected ${state.results_path}`, 'results_path_mismatch')
  }
  if (state.phase === 'summarized' && isPlainObject(state.summary)) return state.summary
  if (state.phase !== 'awaiting_fold' || !isPlainObject(state.report) || !Array.isArray(state.fold_calls)) {
    return stateInvalid(marketplace, 'state is not awaiting Fold results')
  }
  const report = clone(state.report)
  const foldErrors = []
  const answers = await readResultsForCalls(resultsPath, state.fold_calls)
  for (const [index, call] of state.fold_calls.entries()) {
    if (call.name !== 'report_delist') continue
    const result = answers[index].result
    const failed = foldFailureFromResult(result)
    if (failed !== null) {
      foldErrors.push({ tool: call.name, listing_ids: call.args.listing_ids, ...failed })
      for (const entry of report.listings) {
        if (call.args.listing_ids.includes(entry.listing_id)) entry.fold_outcome = null
      }
      continue
    }
    const data = structuredFrom(result)
    const perCopy = Array.isArray(data.results) ? data.results.filter(isPlainObject) : []
    for (const entry of report.listings) {
      if (!call.args.listing_ids.includes(entry.listing_id)) continue
      const answer = perCopy.find((candidate) => candidate.listing_id === entry.listing_id)
      entry.fold_outcome = typeof answer?.outcome === 'string' ? answer.outcome : null
    }
    if (nonEmptyString(data.message)) report.fold_message = data.message
  }
  if (foldErrors.length > 0) report.fold_errors = foldErrors
  report.summarized = true
  report.summary_text = summaryText(report)
  state.phase = 'summarized'
  state.summary = report
  await writeJsonPrivate(statePath, state)
  return report
}
