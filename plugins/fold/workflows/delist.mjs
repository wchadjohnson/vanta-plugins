/**
 * Shared workflow for deleting a sold piece's still-live sibling listings, once the calling agent
 * has one consolidated seller approval covering every sibling it is about to act on.
 *
 * The capability owns the browser; this owns ordering and per-sibling reporting. It makes no Fold
 * call itself — vanta-fold's `delist_sold_siblings` MCP tool records the attempt/outcome ledger
 * row, and the calling skill resolves that call separately using the outcome this returns. Siblings
 * are processed sequentially with no automatic retry, matching this repository's other write paths.
 */

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value
}

function assertCapability(capability) {
  assertObject(capability, 'capability')
  // A marketplace whose siblings are reached by their own URL (Vinted) deletes each in one call.
  if (typeof capability.delistSibling === 'function') return capability
  for (const method of [
    'navigate',
    'findSiblingRow',
    'openManageMenu',
    'activateDelete',
    'confirmDelete',
  ]) {
    if (typeof capability[method] !== 'function') {
      throw new TypeError(`capability.${method} must be a function`)
    }
  }
  return capability
}

function assertSiblings(siblings, byUrl) {
  if (!Array.isArray(siblings) || siblings.length === 0) {
    throw new TypeError('siblings must be a non-empty array')
  }
  const seen = new Set()
  for (const sibling of siblings) {
    assertObject(sibling, 'sibling')
    if (!nonEmptyString(sibling.listing_id)) {
      throw new TypeError('each sibling requires a non-empty listing_id')
    }
    if (byUrl) {
      // A missing URL or title is not a malformed request: it becomes that sibling's own failure.
    } else if (!nonEmptyString(sibling.sku)) {
      throw new TypeError(`sibling ${sibling.listing_id} has no sku to search Active/Selling for`)
    }
    if (seen.has(sibling.listing_id)) {
      throw new TypeError('two siblings name the same listing_id')
    }
    seen.add(sibling.listing_id)
  }
  return siblings
}

const INFERENCE_CONTROL_BY_CODE = Object.freeze({
  delist_manage_control_inference_required: 'manage',
  delist_delete_control_inference_required: 'delete',
  delist_confirm_control_inference_required: 'confirm',
})

/**
 * Runs one sibling through the capability. Never throws: every outcome, including an unexpected
 * driver failure, becomes a `failed` entry with a safe `failure_code`, so one bad sibling cannot
 * abort the rest of the approved batch.
 *
 * A bounded-inference request (see `delist-capability.mjs`'s `resolveControlCandidates`) is not a
 * failure — it becomes its own `inference_required` entry carrying which control needs a decision,
 * the real candidates, and why (`intent`). The caller resolves it per "Bounded AI control
 * inference" in `sold-with-fold/SKILL.md` and re-invokes this workflow for just that sibling with
 * `decisions[listing_id]` set, which is why `decision` is threaded through every capability call
 * rather than only the one that happened to need it last time — a retry after a Manage-name
 * decision may still hit a fresh Delete- or Confirm-name miss.
 */
async function delistOneSibling(capability, sibling, decision = {}) {
  if (typeof capability.delistSibling === 'function') {
    try {
      const result = await capability.delistSibling(sibling)
      return { listing_id: sibling.listing_id, ...result }
    } catch (error) {
      return {
        listing_id: sibling.listing_id,
        status: 'failed',
        failure_code: typeof error?.code === 'string' ? error.code : 'delist_failed',
        reason: error instanceof Error ? error.message : String(error),
      }
    }
  }
  const searchesDrafts = typeof capability.findDraftSibling === 'function'
  try {
    // A drafts search leaves Active/Selling, so each sibling starts there again.
    if (searchesDrafts) await capability.navigate()
    const row = await capability.findSiblingRow(sibling.sku, { manageDecision: decision.manage })
    if (!row.found) {
      const draft = searchesDrafts ? await capability.findDraftSibling(sibling.sku) : { found: false }
      if (draft.found) {
        const deleted = await capability.deleteDraftRow({ ...draft, sku: sibling.sku })
        return {
          listing_id: sibling.listing_id,
          sku: sibling.sku,
          status: 'deleted',
          surface: deleted.surface,
          dialog_text: deleted.dialog_text,
        }
      }
      return {
        listing_id: sibling.listing_id,
        sku: sibling.sku,
        status: 'not_found',
        reason: searchesDrafts
          ? 'No row on Active/Selling or in the drafts carries this SKU; nothing to do'
          : 'Active/Selling is confirmed loaded and no row matches this SKU; nothing to do',
      }
    }
    await capability.openManageMenu(row.manageAction)
    await capability.activateDelete({ deleteDecision: decision.delete })
    const confirmation = await capability.confirmDelete({ confirmDecision: decision.confirm })
    return {
      listing_id: sibling.listing_id,
      sku: sibling.sku,
      status: 'deleted',
      ...(searchesDrafts ? { surface: 'active' } : {}),
      dialog_text: confirmation.dialog_text,
    }
  } catch (error) {
    const control = INFERENCE_CONTROL_BY_CODE[error?.code]
    if (control !== undefined) {
      return {
        listing_id: sibling.listing_id,
        sku: sibling.sku,
        status: 'inference_required',
        control,
        intent: error.intent,
        candidates: error.candidates,
        observed_dialog_text: error.observed_dialog_text,
      }
    }
    return {
      listing_id: sibling.listing_id,
      sku: sibling.sku,
      status: 'failed',
      failure_code: typeof error?.code === 'string' ? error.code : 'delist_failed',
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * `decisions`, keyed by `listing_id`, is optional and only ever needed on a retry after a prior
 * call reported `inference_required` for that sibling — see `delistOneSibling` above. Omitting it
 * (the normal case, Depop unchanged) behaves exactly as before this existed.
 */
export async function delistApprovedSiblings({ capability, siblings, decisions = {} } = {}) {
  assertCapability(capability)
  assertSiblings(siblings, typeof capability.delistSibling === 'function')
  assertObject(decisions, 'decisions')

  await capability.navigate()

  const results = []
  for (const sibling of siblings) {
    results.push(await delistOneSibling(capability, sibling, decisions[sibling.listing_id]))
  }

  capability.complete?.()
  const anyFailed = results.some((entry) => entry.status === 'failed')
  const anyInferenceRequired = results.some((entry) => entry.status === 'inference_required')
  return {
    outcome: anyFailed
      ? 'completed_with_failures'
      : anyInferenceRequired
        ? 'completed_with_pending_inference'
        : 'completed',
    results,
  }
}

/**
 * Maps browser delist results into Fold resolution groups. `deleted` and `not_found` both confirm
 * the listing is no longer live; `failed` is abandoned. `unresolved` is the caller's decision
 * point: resolve bounded inference first, then close anything still unresolved at report time as
 * abandoned.
 */
export function delistResolutionGroups(results) {
  if (!Array.isArray(results)) {
    throw new TypeError('results must be an array')
  }

  const groups = { confirmed: [], abandoned: [], unresolved: [] }
  const seen = new Set()
  for (const entry of results) {
    assertObject(entry, 'result')
    if (!nonEmptyString(entry.listing_id)) {
      throw new TypeError('each result requires a non-empty listing_id')
    }
    if (seen.has(entry.listing_id)) {
      throw new TypeError('two results name the same listing_id')
    }
    seen.add(entry.listing_id)

    switch (entry.status) {
      case 'deleted':
      case 'not_found':
        groups.confirmed.push(entry.listing_id)
        break
      case 'failed':
        groups.abandoned.push(entry.listing_id)
        break
      case 'inference_required':
        groups.unresolved.push(entry.listing_id)
        break
      default:
        throw new TypeError(`result ${entry.listing_id} has unknown status ${String(entry.status)}`)
    }
  }
  return groups
}
