const TOKEN_CHARACTER = '[A-Za-z0-9_-]'
const EXECUTION_CANDIDATES = Symbol('executionCandidates')

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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function validateReadyListing(listing) {
  assertObject(listing, 'listing')

  for (const field of ['listing_id', 'title', 'description', 'platform']) {
    if (typeof listing[field] !== 'string' || listing[field].trim() === '') {
      throw new Error(`Ready listing is missing ${field}`)
    }
  }

  if (typeof listing.reference_token !== 'string' || listing.reference_token.trim() === '') {
    throw new Error(`Listing ${listing.listing_id} has no Fold reference_token`)
  }
  if (!Number.isFinite(listing.price) || listing.price <= 0) {
    throw new Error(`Listing ${listing.listing_id} has an invalid price`)
  }
  if (!Array.isArray(listing.photos) || listing.photos.length === 0) {
    throw new Error(`Listing ${listing.listing_id} has no available photos`)
  }
  if (listing.unavailable_photo_count !== 0) {
    throw new Error(`Listing ${listing.listing_id} has unavailable photos`)
  }

  return listing
}

function publicCandidate(listing) {
  return {
    listing_id: listing.listing_id,
    item_id: listing.item_id,
    platform: listing.platform,
    title: listing.title,
    price: listing.price,
    photo_count: listing.photos.length,
    reference_token_present: true,
  }
}

function rejection(listing, error) {
  return {
    listing_id:
      listing !== null && typeof listing === 'object' && typeof listing.listing_id === 'string'
        ? listing.listing_id
        : null,
    reason: error instanceof Error ? error.message : String(error),
  }
}

function assertDraftAdapter(adapter) {
  assertObject(adapter, 'adapter')
  if (typeof adapter.platform !== 'string' || adapter.platform.trim() === '') {
    throw new TypeError('adapter.platform must be a non-empty string')
  }
  for (const method of ['validateListing', 'prepareDraft', 'saveDraft', 'verifyDraft']) {
    assertFunction(adapter[method], `adapter.${method}`)
  }
  return adapter
}

/** Builds a redacted plan. Full reference tokens and signed photo URLs stay private. */
export async function planPublicationBatch(listReadyResult, adapter) {
  assertObject(listReadyResult, 'list_ready_listings result')
  assertDraftAdapter(adapter)
  if (!Array.isArray(listReadyResult.listings)) {
    throw new Error('list_ready_listings result is missing listings')
  }

  const candidates = []
  const rejectedCandidates = []
  for (const listing of listReadyResult.listings) {
    try {
      const ready = validateReadyListing(listing)
      if (ready.platform !== adapter.platform) {
        throw new Error(`Listing is for ${ready.platform}, not ${adapter.platform}`)
      }
      const validation = await adapter.validateListing(ready)
      if (validation !== true && validation?.valid !== true) {
        throw new Error(
          validation?.reason ?? validation?.errors?.[0]?.message ?? 'Adapter rejected the listing'
        )
      }
      candidates.push(ready)
    } catch (error) {
      rejectedCandidates.push(rejection(listing, error))
    }
  }

  const plan = {
    platform: adapter.platform,
    greenlit_count: listReadyResult.listings.length,
    valid_candidates: candidates.map(publicCandidate),
    rejected_candidates: rejectedCandidates,
  }
  Object.defineProperty(plan, EXECUTION_CANDIDATES, { value: candidates })
  return plan
}

/** The full ready listings behind a plan's redacted candidates, in Fold order. */
export function planCandidates(plan) {
  const candidates = plan?.[EXECUTION_CANDIDATES]
  if (!Array.isArray(candidates)) throw new TypeError('plan must come from planPublicationBatch()')
  return candidates
}

function batchReport(plan, fields = {}) {
  return {
    platform: plan.platform,
    greenlit_count: plan.greenlit_count,
    valid_candidate_count: plan.valid_candidates.length,
    rejected_candidates: plan.rejected_candidates,
    drafts_verified: [],
    fold_outcomes: [],
    failed_listing: null,
    untouched_listings: [],
    ...fields,
  }
}

function untouchedCandidates(candidates, startIndex) {
  return candidates.slice(startIndex).map((listing) => listing.listing_id)
}

function readAdapterMetrics(adapter) {
  if (typeof adapter.metrics !== 'function') return null
  try {
    const value = adapter.metrics()
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

/**
 * Runs the private-draft transaction and its verification. Keeping this envelope executable
 * prevents callers from accidentally passing a prepared draft directly to adapter.saveDraft(),
 * which also requires the current Fold listing for integrity checks.
 */
export async function saveAndVerifyDraft({ adapter, listing, resolveInference } = {}) {
  assertDraftAdapter(adapter)
  let ready
  try {
    ready = validateReadyListing(listing)
  } catch (error) {
    return { outcome: 'draft_failed', failed_listing: rejection(listing, error) }
  }
  if (ready.platform !== adapter.platform) {
    return {
      outcome: 'draft_failed',
      failed_listing: rejection(
        ready,
        new Error(`Listing is for ${ready.platform}, not ${adapter.platform}`)
      ),
    }
  }

  let validation
  try {
    validation = await adapter.validateListing(ready)
  } catch (error) {
    return {
      outcome: 'draft_failed',
      failed_listing: {
        ...rejection(ready, error),
        ...(typeof error?.code === 'string' ? { failure_code: error.code } : {}),
      },
    }
  }
  if (validation !== true && validation?.valid !== true) {
    return {
      outcome: 'draft_failed',
      failed_listing: {
        listing_id: ready.listing_id,
        failure_code: validation?.errors?.[0]?.code ?? 'adapter_validation_failed',
        reason:
          validation?.reason ?? validation?.errors?.[0]?.message ?? 'Adapter rejected the listing',
      },
    }
  }

  let prepared
  let saveResult
  try {
    prepared = await adapter.prepareDraft(ready)
    saveResult = await adapter.saveDraft({ listing: ready, prepared })
  } catch (error) {
    return {
      outcome: 'draft_failed',
      failed_listing: {
        ...rejection(ready, error),
        ...(typeof error?.code === 'string' ? { failure_code: error.code } : {}),
      },
    }
  }

  if (saveResult?.outcome === 'inference_required') {
    if (typeof resolveInference !== 'function' || typeof adapter.resolveInference !== 'function') {
      return {
        outcome: 'draft_failed',
        failed_listing: {
          listing_id: ready.listing_id,
          failure_code: saveResult.failure_code ?? 'inference_required',
          reason: 'The adapter requires a bounded AI inference decision before it can write',
        },
      }
    }

    const request = Object.freeze({
      kind: 'bounded_taxonomy_inference',
      field: saveResult.inference?.field,
      source_value: saveResult.inference?.source_value,
      audience: saveResult.inference?.audience,
      listing: Object.freeze({
        listing_id: ready.listing_id,
        title: ready.title,
        description: ready.description,
        category: ready.category,
      }),
      candidates: Object.freeze(
        (saveResult.candidates ?? []).map((candidate) => Object.freeze({
          label: candidate.label,
          group: candidate.group,
        }))
      ),
      requirements: Object.freeze({
        choose_exact_candidate: true,
        approved_content_evidence_only: true,
        low_confidence_must_refuse: true,
      }),
    })

    try {
      const decision = await resolveInference(request)
      prepared = await adapter.resolveInference({ prepared, saveResult, decision })
      saveResult = await adapter.saveDraft({ listing: ready, prepared })
    } catch (error) {
      return {
        outcome: 'draft_failed',
        failed_listing: {
          ...rejection(ready, error),
          failure_code:
            typeof error?.code === 'string' ? error.code : 'category_inference_failed',
        },
      }
    }
  }

  return finishSavedDraft({ adapter, ready, prepared, saveResult })
}

/** The shared second half of a draft transaction: a confirmed save, its URL, and its verification. */
async function finishSavedDraft({ adapter, ready, prepared, saveResult }) {
  if (saveResult?.outcome !== 'draft_saved') {
    return {
      outcome: 'draft_failed',
      failed_listing: {
        listing_id: ready.listing_id,
        failure_code: saveResult?.failure_code ?? 'draft_save_not_confirmed',
        reason: saveResult?.error ?? 'The adapter did not report an unambiguous draft save',
        save_outcome: saveResult?.outcome ?? null,
        ...(saveResult?.notes ? { notes: saveResult.notes } : {}),
        ...(Array.isArray(saveResult?.candidates) ? { candidates: saveResult.candidates } : {}),
        ...(saveResult?.expected_fields ? { expected_fields: saveResult.expected_fields } : {}),
      },
    }
  }

  let draftUrl
  try {
    draftUrl = canonicalHttpUrl(saveResult.canonical_url)
  } catch (error) {
    return { outcome: 'draft_failed', failed_listing: rejection(ready, error) }
  }

  let verification
  try {
    verification = await adapter.verifyDraft({
      listing: ready,
      prepared,
      saveResult,
      canonicalUrl: draftUrl,
    })
  } catch (error) {
    return {
      outcome: 'draft_failed',
      failed_listing: {
        ...rejection(ready, error),
        ...(typeof error?.code === 'string' ? { failure_code: error.code } : {}),
      },
    }
  }
  if (verification !== true && verification?.verified !== true) {
    return {
      outcome: 'draft_failed',
      failed_listing: {
        listing_id: ready.listing_id,
        failure_code: verification?.failure_code ?? 'draft_verification_failed',
        reason: verification?.reason ?? 'Saved draft verification failed',
        save_outcome: 'draft_saved',
        canonical_url: draftUrl,
        ...(saveResult.notes ? { notes: saveResult.notes } : {}),
      },
    }
  }

  const result = {
    outcome: 'draft_verified',
    listing_id: ready.listing_id,
    canonical_url: draftUrl,
    external_identity: saveResult.external_identity ?? null,
    browser_metrics: readAdapterMetrics(adapter),
  }
  if (saveResult.notes) result.notes = saveResult.notes
  if (prepared.categorySelection?.inferenceDecision) {
    result.inference_decisions = [prepared.categorySelection.inferenceDecision]
  }
  return result
}

/**
 * Resolves a save the adapter could not confirm within the call that made it
 * (`awaiting_save_confirmation`): the adapter looks for the draft it saved — it never saves again —
 * and a draft found is verified exactly like a fresh one.
 */
export async function confirmAndVerifyDraft({ adapter, listing, expectedFields } = {}) {
  assertDraftAdapter(adapter)
  assertFunction(adapter.confirmSavedDraft, 'adapter.confirmSavedDraft')
  let ready
  let prepared
  let saveResult
  try {
    ready = validateReadyListing(listing)
    prepared = await adapter.prepareDraft(ready)
    saveResult = await adapter.confirmSavedDraft({ listing: ready, prepared, expectedFields })
  } catch (error) {
    return {
      outcome: 'draft_failed',
      failed_listing: {
        ...rejection(listing, error),
        ...(typeof error?.code === 'string' ? { failure_code: error.code } : {}),
        save_outcome: 'awaiting_save_confirmation',
      },
    }
  }
  return finishSavedDraft({ adapter, ready, prepared, saveResult })
}

/**
 * Draft publication semantics: a verified, stable external draft is enough for mark_published.
 * This function never invokes a live action itself and never retries an ambiguous external
 * operation. A bounded inference challenge may continue once because the adapter proves no draft
 * existed before the model decision.
 */
export async function publishApprovedBatch({ fold, adapter, resolveInference }) {
  assertObject(fold, 'fold')
  assertDraftAdapter(adapter)
  assertFunction(fold.listReadyListings, 'fold.listReadyListings')
  assertFunction(fold.markPublished, 'fold.markPublished')

  // This is intentionally the sole readiness read for the batch.
  const plan = await planPublicationBatch(await fold.listReadyListings(), adapter)
  const candidates = plan[EXECUTION_CANDIDATES]
  if (candidates.length === 0) {
    return batchReport(plan, { outcome: 'no_valid_candidates' })
  }

  const draftsVerified = []
  const foldOutcomes = []
  for (let index = 0; index < candidates.length; index += 1) {
    const listing = candidates[index]
    const draftResult = await saveAndVerifyDraft({ adapter, listing, resolveInference })
    if (draftResult.outcome !== 'draft_verified') {
      return batchReport(plan, {
        outcome: 'batch_stopped',
        drafts_verified: draftsVerified,
        fold_outcomes: foldOutcomes,
        failed_listing: draftResult.failed_listing,
        untouched_listings: untouchedCandidates(candidates, index + 1),
      })
    }

    const verifiedDraft = {
      listing_id: listing.listing_id,
      canonical_url: draftResult.canonical_url,
      external_identity: draftResult.external_identity,
      ...(draftResult.browser_metrics === null
        ? {}
        : { browser_metrics: draftResult.browser_metrics }),
    }
    if (draftResult.inference_decisions) {
      verifiedDraft.inference_decisions = draftResult.inference_decisions
    }
    draftsVerified.push(verifiedDraft)

    let foldResult
    try {
      foldResult = await fold.markPublished({
        listing_id: listing.listing_id,
        listing_url: draftResult.canonical_url,
        visibility: 'draft',
      })
    } catch (error) {
      return batchReport(plan, {
        outcome: 'batch_stopped',
        drafts_verified: draftsVerified,
        fold_outcomes: foldOutcomes,
        failed_listing: rejection(listing, error),
        untouched_listings: untouchedCandidates(candidates, index + 1),
      })
    }
    foldOutcomes.push({ listing_id: listing.listing_id, outcome: foldResult?.outcome ?? 'unknown' })
    if (foldResult?.outcome !== 'published' && foldResult?.outcome !== 'already_published') {
      return batchReport(plan, {
        outcome: 'batch_stopped',
        drafts_verified: draftsVerified,
        fold_outcomes: foldOutcomes,
        failed_listing: {
          listing_id: listing.listing_id,
          reason: `Fold refused the verified draft: ${foldResult?.outcome ?? 'unknown'}`,
        },
        untouched_listings: untouchedCandidates(candidates, index + 1),
      })
    }

  }

  return batchReport(plan, {
    outcome: 'completed',
    drafts_verified: draftsVerified,
    fold_outcomes: foldOutcomes,
  })
}

export function selectReadyListing(listReadyResult, listingId) {
  assertObject(listReadyResult, 'list_ready_listings result')
  if (!Array.isArray(listReadyResult.listings)) {
    throw new Error('list_ready_listings result is missing listings')
  }

  const candidates =
    listingId === undefined
      ? listReadyResult.listings
      : listReadyResult.listings.filter((listing) => listing?.listing_id === listingId)

  if (candidates.length === 0) return { outcome: 'not_ready' }
  if (listingId === undefined && candidates.length > 1) {
    return { outcome: 'selection_required', listing_ids: candidates.map((item) => item.listing_id) }
  }

  return { outcome: 'selected', listing: validateReadyListing(candidates[0]) }
}

function canonicalHttpUrl(value) {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Adapter success URL must use HTTP or HTTPS')
  }
  url.hash = ''
  return url.toString()
}

export async function publishApprovedListing({ fold, adapter, confirmSubmission, listingId }) {
  assertObject(fold, 'fold')
  assertObject(adapter, 'adapter')
  assertFunction(fold.listReadyListings, 'fold.listReadyListings')
  assertFunction(fold.markPublished, 'fold.markPublished')
  assertFunction(adapter.postListing, 'adapter.postListing')
  assertFunction(adapter.verifyPublishedListing, 'adapter.verifyPublishedListing')
  assertFunction(confirmSubmission, 'confirmSubmission')

  const selection = selectReadyListing(await fold.listReadyListings(), listingId)
  if (selection.outcome !== 'selected') return selection

  const approved = await confirmSubmission(selection.listing)
  if (approved !== true) return { outcome: 'submission_cancelled', listing_id: selection.listing.listing_id }

  const browserResult = await adapter.postListing(selection.listing)
  if (browserResult?.outcome !== 'published') {
    return {
      outcome: 'browser_failed',
      listing_id: selection.listing.listing_id,
      error: browserResult?.error ?? 'The adapter did not report publication success',
    }
  }

  let listingUrl
  try {
    listingUrl = canonicalHttpUrl(browserResult.canonical_url)
  } catch (error) {
    return {
      outcome: 'browser_failed',
      listing_id: selection.listing.listing_id,
      error: error instanceof Error ? error.message : String(error),
    }
  }

  const verified = await adapter.verifyPublishedListing({
    listing: selection.listing,
    browserResult,
    canonicalUrl: listingUrl,
  })
  if (verified !== true) {
    return {
      outcome: 'verification_failed',
      listing_id: selection.listing.listing_id,
      canonical_url: listingUrl,
    }
  }

  const foldResult = await fold.markPublished({
    listing_id: selection.listing.listing_id,
    listing_url: listingUrl,
  })
  if (foldResult?.outcome !== 'published' && foldResult?.outcome !== 'already_published') {
    return {
      outcome: 'fold_refused',
      listing_id: selection.listing.listing_id,
      canonical_url: listingUrl,
      fold: foldResult,
    }
  }
  return {
    outcome: 'fold_updated',
    listing_id: selection.listing.listing_id,
    canonical_url: listingUrl,
    fold: foldResult,
  }
}

export function messageContainsExactToken(message, referenceToken) {
  assertObject(message, 'message')
  if (typeof referenceToken !== 'string' || referenceToken.trim() === '') {
    throw new Error('referenceToken must be a non-empty string')
  }

  const searchable = [message.subject, message.body, message.snippet]
    .filter((value) => typeof value === 'string')
    .join('\n')
  const pattern = new RegExp(
    `(?<!${TOKEN_CHARACTER})${escapeRegExp(referenceToken)}(?!${TOKEN_CHARACTER})`
  )
  return pattern.test(searchable)
}

export function selectExactTokenMessage(messages, referenceToken) {
  if (!Array.isArray(messages)) throw new TypeError('messages must be an array')
  const matches = messages.filter((message) => messageContainsExactToken(message, referenceToken))

  if (matches.length === 0) return { outcome: 'missing_match' }
  if (matches.length > 1) {
    return {
      outcome: 'ambiguous_match',
      message_ids: matches.map((message) => message.id).filter((id) => typeof id === 'string'),
    }
  }
  return { outcome: 'matched', message: matches[0] }
}

export async function processSoldNotification({ fold, messages, referenceToken }) {
  assertObject(fold, 'fold')
  assertFunction(fold.markSold, 'fold.markSold')

  const match = selectExactTokenMessage(messages, referenceToken)
  if (match.outcome !== 'matched') return match

  const result = await fold.markSold({ reference_token: referenceToken })
  if (result?.outcome === 'already_sold') {
    return {
      outcome: 'already_sold_noop',
      reference_token: referenceToken,
      message_id: match.message.id,
    }
  }

  if (result?.outcome !== 'sold') {
    return {
      outcome: 'fold_refused',
      reference_token: referenceToken,
      message_id: match.message.id,
      fold: result,
    }
  }

  return {
    outcome: 'fold_updated',
    reference_token: referenceToken,
    message_id: match.message.id,
    fold: result,
  }
}
