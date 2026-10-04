import {
  createDepopTargetProfile,
  depopAudienceOfGroup,
  isLiveActionName,
} from './profile.mjs'

export const DEPOP_ADAPTER_ID = 'depop'

const CONDITION_MAP = new Map([
  ['new', 'Brand new'],
  ['brand new', 'Brand new'],
  ['like new', 'Like new'],
  ['like_new', 'Like new'],
  ['excellent', 'Excellent'],
  ['good', 'Good'],
  ['fair', 'Fair'],
])

const AUTHENTICATED_CONDITION_MAP = new Map([
  ['new', 'Brand new'],
  ['brand new', 'Brand new'],
  ['like new', 'Like new'],
  ['like_new', 'Like new'],
  ['excellent', 'Used - Excellent'],
  ['good', 'Used - Good'],
  ['fair', 'Used - Fair'],
])

/**
 * Depop's Color vocabulary, confirmed live against an authenticated account (2026-08-23,
 * read-only). It is global — the same options regardless of category — and the control holds at
 * most two distinct selections.
 *
 * Nothing here may be extended by inference. An unresearched option is a wrong option that looks
 * right, and this list is what stands between a Fold value and a real browser form.
 */
export const DEPOP_COLORS = Object.freeze([
  'Black', 'Grey', 'White', 'Brown', 'Tan', 'Cream', 'Yellow', 'Red', 'Burgundy', 'Orange',
  'Pink', 'Purple', 'Blue', 'Navy', 'Green', 'Khaki', 'Multi', 'Silver', 'Gold',
])

export const MAX_DEPOP_COLORS = 2

/**
 * Explicit source-to-Depop equivalents. These are finite aliases, not fuzzy matching: an input
 * absent from the map must already equal a qualified Depop option or it is refused.
 */
export const DEPOP_COLOR_ALIASES = new Map([
  ['Gray', 'Grey'],
])

/** Size is category-dependent: three genuinely different sets were observed in the same research. */
export const DEPOP_SIZE_SETS = Object.freeze({
  apparel: Object.freeze([
    'One size', '3XS', 'XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL', '5XL', '6XL', 'Other',
  ]),
  footwear: Object.freeze([
    'One size', 'US 3', 'US 3.5', 'US 4', 'US 4.5', 'US 5', 'US 5.5', 'US 6', 'US 6.5', 'US 7',
    'US 7.5', 'US 8', 'US 8.5', 'US 9', 'US 9.5', 'US 10', 'US 10.5', 'US 11', 'US 11.5', 'US 12',
    'US 12.5', 'US 13', 'US 13.5', 'US 14', 'Other',
  ]),
  dresses: Object.freeze([
    'One size', '00', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '14',
    '16', '18', '20', '22', '24', '26', '28', '30', '32', '34', '36', 'XXS', 'XS', 'S', 'M', 'L',
    'XL', 'XXL', '3XL', '4XL', '5XL', '6XL', 'Other',
  ]),
})

/** Textual apparel sizes Fold may emit whose meaning is identical to Depop's abbreviated option. */
export const DEPOP_SIZE_ALIASES = new Map([
  ['One Size', 'One size'],
  ['Extra Extra Small', 'XXS'],
  ['Extra Small', 'XS'],
  ['Small', 'S'],
  ['Medium', 'M'],
  ['Large', 'L'],
  ['Extra Large', 'XL'],
  ['Extra Extra Large', 'XXL'],
])

/**
 * Which size set a category draws from. Outerwear is mapped to `apparel` because it is alpha-sized
 * like tops and bottoms — that assigns an already-confirmed vocabulary rather than inventing one.
 *
 * Categories whose size sets were never observed are deliberately absent. A category with no entry
 * is left unvalidated rather than pointed at a set that may not be its own: unvalidated is honest,
 * wrongly validated is not.
 */
export const DEPOP_SIZE_FAMILY_BY_CATEGORY = Object.freeze({
  Tops: 'apparel',
  Outerwear: 'apparel',
  Bottoms: 'apparel',
  Dresses: 'dresses',
  Shoes: 'footwear',
})

/** Fold's domain is one physical garment per listing, so a Depop draft is always a single item. */
export const DEPOP_DRAFT_QUANTITY = 1

/**
 * Depop's category picker is audience-scoped: the same garment word appears under several audience
 * groups (`MEN > COATS AND JACKETS` and `WOMEN > COATS AND JACKETS` both offer Jackets), so exact
 * role-and-name matching alone cannot pick one. Fold's category is free-text model output — its
 * prompt asks only for a "platform-appropriate category" and constrains neither vocabulary nor
 * shape — so the audience can only be read from prefixes literally observed in real Fold listings.
 *
 * Only MEN and WOMEN are here because only those two groups were observed live. Unisex and kids
 * prefixes are deliberately absent: naming a Depop group nobody has seen is the same failure mode
 * as inventing a color, and an unrecognized prefix already has a safe answer.
 */
export const DEPOP_AUDIENCE_BY_FOLD_PREFIX = new Map([
  ['menswear', 'MEN'],
  ["men's", 'MEN'],
  ['mens', 'MEN'],
  ['men', 'MEN'],
  ['womenswear', 'WOMEN'],
  ["women's", 'WOMEN'],
  ['womens', 'WOMEN'],
  ['women', 'WOMEN'],
])

const DEPOP_AUDIENCE_PREFIXES = Object.freeze(
  [...DEPOP_AUDIENCE_BY_FOLD_PREFIX.entries()].sort(
    ([left], [right]) => right.length - left.length
  )
)

/**
 * Candidate option labels for one Fold category. Fold emits compound values such as
 * "Jackets & Coats" that Depop splits into separate options, so each half is also a candidate.
 * Every candidate is still matched exactly against a real option; splitting widens what can be
 * found, never how loosely it is compared. Matches are pooled across all candidates regardless of
 * order, so a compound that finds two real options stays ambiguous and fails closed.
 */
function depopCategoryTerms(value) {
  const whole = value.trim()
  const parts = whole.split(/\s*[&/]\s*/).map((part) => part.trim()).filter((part) => part !== '')
  return [...new Set([whole, ...parts])].filter((term) => term !== '')
}

/**
 * Resolves Fold's free-text category into an audience plus candidate option labels, or null when it
 * cannot be read with certainty. Null is the safe answer, not a failure: it leaves Category unset
 * exactly as the adapter did before this mapping existed.
 */
export function depopCategorySelection(value, profile) {
  if (!nonEmptyString(value)) return null
  const category = value.trim()
  const categoryLower = category.toLowerCase()
  const match = DEPOP_AUDIENCE_PREFIXES.find(([prefix]) => {
    if (!categoryLower.startsWith(prefix)) return false
    const boundary = category[prefix.length]
    return boundary === '>' || /\s/.test(boundary ?? '')
  })
  if (match === undefined) return null

  const [prefix, audience] = match
  let categoryText = category.slice(prefix.length)
  if (/^\s/.test(categoryText)) categoryText = categoryText.trimStart()
  const hadSeparator = categoryText.startsWith('>')
  if (hadSeparator) categoryText = categoryText.slice(1).trimStart()

  // A value that spelled out "audience > category" is trusted structure. A separatorless value
  // ("Womens Hoodies") only had its audience boundary guessed from whitespace, so accept it only
  // when the remainder is itself category-shaped: one token, or an "&"/"/"-joined compound like
  // "Sweatshirts & Hoodies". A free-text remainder ("Womens Vintage Hoodies") returns null so it
  // falls back to an unset category, exactly as a value with no readable audience does — rather
  // than reaching the picker, finding nothing, and hard-failing the whole listing.
  if (!hadSeparator && /\s/.test(categoryText) && !/[&/]/.test(categoryText)) {
    return null
  }

  const terms = depopCategoryTerms(categoryText)
  if (terms.length === 0) return null
  return Object.freeze({
    status: 'unresolved',
    audience,
    sourceValue: category,
    terms: Object.freeze(terms),
    locator: profile.fields.category,
  })
}

/**
 * Validates one bounded-AI answer to an adapter-issued category inference request and returns a
 * prepared draft that names one category, or refuses.
 *
 * A model picks which of several real options fits the listing, so this is the semantic gate that
 * keeps the pick honest. The candidates are read from the adapter's own save result —
 * every one of them was enumerated from the live Depop picker — and the answer must equal one of
 * them exactly. An invented label, a near miss, or an answer belonging to a different listing is
 * refused and the draft stays unresolved. The choice is recorded on the returned prepared draft so
 * an agent-made decision is visible rather than implicit.
 *
 * This widens how equivalent category text may resolve. It does not widen what may be written: the
 * browser still re-enumerates the picker and requires exactly one option carrying this exact label
 * under this exact audience group before it clicks anything.
 */
export function resolveCategoryChoice({ prepared, saveResult, decision } = {}) {
  if (prepared === null || typeof prepared !== 'object' || prepared.adapter !== DEPOP_ADAPTER_ID) {
    throw new DepopAdapterError('invalid_prepared_draft', 'prepared must come from prepareDraft()')
  }
  const selection = prepared.categorySelection
  if (selection === null || selection === undefined) {
    throw new DepopAdapterError(
      'category_not_resolvable',
      'This listing has no readable Depop audience, so no category choice applies'
    )
  }
  if (saveResult?.outcome !== 'inference_required' || !Array.isArray(saveResult.candidates)) {
    throw new DepopAdapterError(
      'category_choice_unsolicited',
      'A category choice requires an adapter-issued inference request'
    )
  }
  if (saveResult.fold_listing_id !== prepared.foldListingId) {
    throw new DepopAdapterError(
      'category_choice_listing_mismatch',
      'The offered categories belong to a different Fold listing'
    )
  }

  if (decision === null || typeof decision !== 'object' || Array.isArray(decision)) {
    throw new DepopAdapterError(
      'category_inference_invalid',
      'Category inference must return a structured decision'
    )
  }
  if (!nonEmptyString(decision.chosenLabel)) {
    throw new DepopAdapterError(
      'category_inference_label_missing',
      'Category inference must choose one offered label'
    )
  }
  if (!['high', 'medium'].includes(decision.confidence)) {
    throw new DepopAdapterError(
      'category_inference_confidence_insufficient',
      'Category inference confidence must be medium or high'
    )
  }
  if (!nonEmptyString(decision.reason) || decision.reason.length > 500) {
    throw new DepopAdapterError(
      'category_inference_reason_invalid',
      'Category inference must include a concise reason'
    )
  }
  if (
    !Array.isArray(decision.evidence) ||
    decision.evidence.length === 0 ||
    decision.evidence.length > 3 ||
    decision.evidence.some((item) => !nonEmptyString(item) || item.length > 200)
  ) {
    throw new DepopAdapterError(
      'category_inference_evidence_invalid',
      'Category inference must cite one to three concise approved-content excerpts'
    )
  }
  const approvedText = `${prepared.approvedContent.title}\n${prepared.approvedContent.description}`
  if (decision.evidence.some((item) => !approvedText.includes(item))) {
    throw new DepopAdapterError(
      'category_inference_evidence_unapproved',
      'Category inference evidence must be copied from Fold-approved content'
    )
  }

  const offeredCandidates = saveResult.candidates.filter(
    (candidate) =>
      candidate !== null &&
      typeof candidate === 'object' &&
      nonEmptyString(candidate.label) &&
      nonEmptyString(candidate.group)
  )
  const matches = offeredCandidates.filter(
    (candidate) =>
      candidate.label === decision.chosenLabel &&
      depopAudienceOfGroup(candidate.group) === selection.audience
  )
  if (matches.length !== 1) {
    throw new DepopAdapterError(
      'category_choice_not_offered',
      'The chosen category is not exactly one of the options Depop offered for this listing',
      { candidates: saveResult.candidates.map((candidate) => candidate?.label) }
    )
  }

  return Object.freeze({
    ...prepared,
    categorySelection: Object.freeze({
      status: 'resolved',
      audience: selection.audience,
      sourceValue: selection.sourceValue,
      terms: selection.terms,
      locator: selection.locator,
      chosenLabel: matches[0].label,
      chosenGroup: matches[0].group,
      offeredCandidates: Object.freeze(
        offeredCandidates.map((candidate) => Object.freeze({
          label: candidate.label,
          group: candidate.group,
        }))
      ),
      inferenceDecision: Object.freeze({
        field: 'category',
        chosenLabel: decision.chosenLabel,
        confidence: decision.confidence,
        reason: decision.reason,
        evidence: Object.freeze([...decision.evidence]),
      }),
    }),
  })
}


/**
 * Depop keeps these locked until Category is chosen, so without a resolved category they cannot be
 * written at all. Sending them anyway would fail against a disabled control rather than fail closed.
 */
const CATEGORY_GATED_FIELDS = Object.freeze(['size', 'material'])

/** The size options a category offers, or null when this category was never researched. */
export function depopSizeOptionsFor(category) {
  if (!nonEmptyString(category)) return null
  const family = DEPOP_SIZE_FAMILY_BY_CATEGORY[category]
  if (family === undefined) return null
  return DEPOP_SIZE_SETS[family] ?? null
}

const REQUIRED_STRUCTURED_FIELDS = Object.freeze(['brand', 'size', 'color'])

const DIRECT_STRUCTURED_FIELDS = Object.freeze([
  ['brand', 'brand'],
  ['size', 'size'],
  ['color', 'color'],
  ['material', 'material'],
  ['style', 'style'],
  ['source', 'source'],
  ['age', 'age'],
  ['audience', 'audience'],
  ['shipping', 'shipping'],
])

const REQUIRED_BROWSER_METHODS = Object.freeze([
  'navigate',
  'inspectDraftSurface',
  'fillField',
  'selectField',
  'uploadPhotos',
  'activate',
  'observeDraftSave',
  'readDraft',
])

export class DepopAdapterError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'DepopAdapterError'
    this.code = code
    this.details = details
  }
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function validationError(code, field, message) {
  return { code, field, message }
}

function normalizedHashtags(value, errors, maxHashtags) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    errors.push(validationError('invalid_hashtags', 'hashtags', 'hashtags must be an array'))
    return []
  }
  if (value.length > maxHashtags) {
    errors.push(
      validationError(
        'too_many_hashtags',
        'hashtags',
        `hashtags exceeds the qualified maximum of ${maxHashtags}`
      )
    )
  }
  const normalized = []
  const seen = new Set()
  for (const hashtag of value) {
    const trimmed = nonEmptyString(hashtag) ? hashtag.trim() : ''
    const tag = trimmed.replace(/^#+/, '')
    if (tag === '' || /[\r\n\0]/.test(tag)) {
      errors.push(
        validationError(
          'invalid_hashtag',
          'hashtags',
          'each hashtag must be non-empty text on one line'
        )
      )
      continue
    }
    const formatted = `#${tag}`
    const identity = formatted.toLowerCase()
    if (seen.has(identity)) {
      errors.push(validationError('duplicate_hashtag', 'hashtags', 'hashtags must be unique'))
      continue
    }
    seen.add(identity)
    normalized.push(formatted)
  }
  return normalized
}

function validateSku(value, errors, maxLength) {
  if (!nonEmptyString(value)) {
    errors.push(
      validationError('missing_reference_token', 'reference_token', 'reference_token is required')
    )
    return
  }
  if (value.length > maxLength) {
    errors.push(
      validationError(
        'reference_token_too_long',
        'reference_token',
        `reference_token exceeds the qualified SKU maximum of ${maxLength}`
      )
    )
  }
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value) || !/^[A-Za-z0-9-]+$/.test(value)) {
    errors.push(
      validationError(
        'reference_token_not_sku_safe',
        'reference_token',
        'reference_token must contain letters and numbers and use only qualified SKU characters'
      )
    )
  }
}

function validatePhoto(photo, index, errors) {
  if (photo === null || typeof photo !== 'object' || Array.isArray(photo)) {
    errors.push(validationError('invalid_photo', `photos[${index}]`, 'photo must be an object'))
    return
  }
  if (!nonEmptyString(photo.url)) {
    errors.push(validationError('missing_photo_url', `photos[${index}].url`, 'photo URL is required'))
  }
  if (!nonEmptyString(photo.filename)) {
    errors.push(
      validationError('missing_photo_filename', `photos[${index}].filename`, 'photo filename is required')
    )
  }
}

function normalizedCondition(value, profile) {
  if (!nonEmptyString(value)) return undefined
  const map = profile?.kind === 'depop' ? AUTHENTICATED_CONDITION_MAP : CONDITION_MAP
  return map.get(value.trim().toLowerCase())
}

function validateOptionalStructuredValue(listing, key, errors) {
  const value = listing[key]
  if (value === undefined || value === null) return
  if (nonEmptyString(value)) return
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => nonEmptyString(item))
  ) return
  errors.push(
    validationError(
      'invalid_structured_value',
      key,
      `${key} must be a non-empty string or non-empty array of strings when supplied`
    )
  )
}

function suppliedValues(value) {
  if (nonEmptyString(value)) return [value]
  if (Array.isArray(value)) return value.filter((entry) => nonEmptyString(entry))
  return []
}

function normalizeControlledValue(value, aliases) {
  if (nonEmptyString(value)) return aliases.get(value) ?? value
  if (Array.isArray(value)) {
    return value.map((entry) => aliases.get(entry) ?? entry)
  }
  return value
}

function normalizedStructuredValue(key, value) {
  if (key === 'color') return normalizeControlledValue(value, DEPOP_COLOR_ALIASES)
  if (key === 'size') return normalizeControlledValue(value, DEPOP_SIZE_ALIASES)
  return value
}

/**
 * Depop refuses a "Ready to post" listing without Brand, Size, and Color, so a candidate missing
 * any of them is rejected here rather than discovered at the form. Fold returns null when the
 * seller has not supplied a value; that is a real absence, never something to fill in.
 */
function validateRequiredStructuredValue(listing, key, errors) {
  if (suppliedValues(listing[key]).length > 0) return false
  errors.push(validationError(`missing_${key}`, key, `${key} is required for a Depop draft`))
  return true
}

/**
 * Target taxonomy values are matched exactly after applying the finite equivalent-value aliases
 * above. Case-folding or nearest-match resolution would still be a guess about seller intent.
 */
function validateColor(value, errors) {
  const colors = suppliedValues(normalizedStructuredValue('color', value))
  if (colors.length > MAX_DEPOP_COLORS) {
    errors.push(
      validationError('too_many_colors', 'color', `Depop supports at most ${MAX_DEPOP_COLORS} colors`)
    )
    return
  }
  if (new Set(colors).size !== colors.length) {
    errors.push(validationError('duplicate_color', 'color', 'each Depop color selection must differ'))
    return
  }
  if (colors.some((color) => !DEPOP_COLORS.includes(color))) {
    errors.push(
      validationError('unsupported_color', 'color', 'color is not an option Depop offers')
    )
  }
}

function validateSize(listing, errors) {
  // Size can only be checked once the category is known, because the category picks the vocabulary.
  const options = depopSizeOptionsFor(listing.category)
  if (options === null) return
  const sizes = suppliedValues(normalizedStructuredValue('size', listing.size))
  if (sizes.some((size) => !options.includes(size))) {
    errors.push(
      validationError('unsupported_size', 'size', 'size is not an option this Depop category offers')
    )
  }
}

function buildDescription(listing) {
  const segments = [listing.title, listing.description]
  if (listing.hashtags.length > 0) segments.push(listing.hashtags.join(' '))
  return segments.join('\n\n')
}

function valuesEqual(actual, expected) {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) &&
      actual.length === expected.length &&
      actual.every((value, index) => value === expected[index])
  }
  return actual === expected
}

function normalizedFormText(value) {
  return typeof value === 'string' ? value.replace(/\r\n/g, '\n') : value
}

function exactMatches(items, expected, keys) {
  if (!Array.isArray(items)) return []
  return items.filter((item) =>
    item !== null &&
    typeof item === 'object' &&
    keys.every((key) => item[key] === expected[key])
  )
}

function requireBrowser(browser) {
  if (browser === null || typeof browser !== 'object' || Array.isArray(browser)) {
    throw new DepopAdapterError(
      'missing_browser',
      'A qualified browser capability is required to save a Depop draft'
    )
  }
  for (const method of REQUIRED_BROWSER_METHODS) {
    if (typeof browser[method] !== 'function') {
      throw new DepopAdapterError(
        'invalid_browser_contract',
        `Browser capability is missing ${method}()`
      )
    }
  }
  return browser
}

function assertSurface(surface, prepared, stage) {
  if (surface === null || typeof surface !== 'object' || Array.isArray(surface)) {
    throw new DepopAdapterError('changed_surface', `${stage} did not expose inspectable browser state`)
  }

  let surfaceUrl
  const entryUrl = new URL(prepared.entryUrl)
  try {
    surfaceUrl = new URL(surface.url)
  } catch {
    throw new DepopAdapterError('changed_surface', `${stage} did not expose its current URL`)
  }
  if (surfaceUrl.origin !== entryUrl.origin) {
    throw new DepopAdapterError(
      'target_origin_mismatch',
      `${stage} escaped the configured target origin`
    )
  }
  const onExpectedPath = stage === 'drafts hub'
    ? surfaceUrl.pathname === entryUrl.pathname
    : surfaceUrl.pathname.startsWith(entryUrl.pathname)
  if (!onExpectedPath) {
    throw new DepopAdapterError('changed_surface', `${stage} opened an unexpected path`)
  }

  const expectedAction = stage === 'drafts hub'
    ? prepared.actions.addDraft
    : prepared.actions.saveDraft
  const actionMatches = exactMatches(surface.controls, expectedAction, ['role', 'name'])
  if (actionMatches.length !== 1) {
    throw new DepopAdapterError(
      'changed_control',
      `${stage} must expose exactly one ${expectedAction.name} control`
    )
  }
  if (isLiveActionName(expectedAction.name) || isLiveActionName(actionMatches[0].name)) {
    throw new DepopAdapterError(
      'live_action_risk',
      'The selected action resembles a live-publication control'
    )
  }

  if (stage === 'draft form') {
    const expectedFields = prepared.formFields.map((field) => field.locator)
    const missing = expectedFields.filter(
      (expected) => exactMatches(surface.fields, expected, ['label', 'role']).length !== 1
    )
    if (missing.length > 0) {
      throw new DepopAdapterError('changed_field', 'Draft form fields are missing or ambiguous', {
        fields: missing.map((field) => field.label),
      })
    }

    const ambiguousSave = Array.isArray(surface.controls) && surface.controls.some(
      (control) =>
        control !== null &&
        typeof control === 'object' &&
        control.role === expectedAction.role &&
        control.name !== expectedAction.name &&
        /save/i.test(control.name ?? '') &&
        isLiveActionName(control.name)
    )
    if (ambiguousSave) {
      throw new DepopAdapterError(
        'live_action_risk',
        'Draft form contains a save control that could publish the listing live'
      )
    }
  }
}

function normalizedCanonicalUrl(value, profile) {
  if (!nonEmptyString(value)) return undefined
  const url = new URL(value)
  if (url.origin !== profile.origin) {
    throw new DepopAdapterError('invalid_draft_identity', 'Draft URL escaped the configured target origin')
  }
  if (url.pathname === profile.draftsPath || !profile.draftPathPattern.test(url.pathname)) {
    throw new DepopAdapterError(
      'invalid_draft_identity',
      'Save result did not expose a stable per-draft URL'
    )
  }
  url.search = ''
  url.hash = ''
  return url.toString()
}

function normalizedSaveSuccess(observed, profile) {
  if (observed === null || typeof observed !== 'object' || Array.isArray(observed)) {
    return {
      outcome: 'ambiguous_save',
      failure_code: 'save_observation_missing',
      error: 'Save outcome was not observable',
    }
  }
  if (observed.outcome === 'validation_error') {
    return {
      outcome: 'validation_failed',
      failure_code: 'target_validation_failed',
      error: 'Target rejected the draft fields',
    }
  }
  if (observed.outcome !== 'saved') {
    return {
      outcome: 'ambiguous_save',
      failure_code: 'save_outcome_mismatch',
      error: 'Draft save did not expose a confirmed saved outcome',
    }
  }
  const observedStatus = nonEmptyString(observed.status)
    ? observed.status.trim().toLowerCase()
    : undefined
  if (observedStatus !== 'draft') {
    return {
      outcome: 'ambiguous_save',
      failure_code: 'saved_status_mismatch',
      error: 'Saved item did not expose draft status',
    }
  }

  let canonicalUrl
  try {
    canonicalUrl = normalizedCanonicalUrl(observed.canonical_url, profile)
  } catch (error) {
    return {
      outcome: 'ambiguous_save',
      failure_code: 'invalid_draft_identity',
      error:
        error instanceof DepopAdapterError
          ? error.message
          : 'Draft save exposed an invalid stable identity',
    }
  }
  const externalIdentity = nonEmptyString(observed.external_identity)
    ? observed.external_identity
    : undefined
  if (canonicalUrl === undefined && externalIdentity === undefined) {
    return {
      outcome: 'ambiguous_save',
      failure_code: 'stable_identity_missing',
      error: 'Draft save exposed no stable external identity',
    }
  }
  return {
    outcome: 'draft_saved',
    canonical_url: canonicalUrl,
    external_identity: externalIdentity,
    status: 'draft',
    target_profile: profile.name,
  }
}

function expectedPersistedDraft(prepared) {
  return {
    status: 'draft',
    sku: prepared.sku,
    title: prepared.approvedContent.title,
    description: prepared.description,
    price: prepared.price,
    structured_fields: Object.fromEntries(
      prepared.structuredFields.map((field) => [field.key, field.value])
    ),
    photo_filenames: prepared.photos.map((photo) => photo.filename),
  }
}

function preparedSignature(prepared) {
  return JSON.stringify({
    adapter: prepared.adapter,
    targetProfile: prepared.targetProfile,
    foldListingId: prepared.foldListingId,
    entryUrl: prepared.entryUrl,
    sku: prepared.sku,
    approvedContent: prepared.approvedContent,
    description: prepared.description,
    price: prepared.price,
    // Only the content-derived half of the selection belongs to the signature. A caller's category
    // choice must survive re-preparation on the retry, while a changed Fold category still changes
    // the audience or terms and is still caught as drift.
    categorySelection: prepared.categorySelection == null
      ? null
      : {
        audience: prepared.categorySelection.audience,
        sourceValue: prepared.categorySelection.sourceValue,
        terms: prepared.categorySelection.terms,
        locator: prepared.categorySelection.locator,
      },
    structuredFields: prepared.structuredFields.map(({ key, value, locator }) => ({
      key,
      value,
      locator,
    })),
    photos: prepared.photos,
    actions: prepared.actions,
  })
}

function verificationFailure(code, reason) {
  return { verified: false, failure_code: code, reason }
}

function verifyPersistedDraft(actual, prepared, saveResult) {
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
    return verificationFailure('persisted_draft_missing', 'Saved draft could not be read')
  }
  const expected = expectedPersistedDraft(prepared)
  if (String(actual.status ?? '').trim().toLowerCase() !== expected.status) {
    return verificationFailure('persisted_status_mismatch', 'Saved item is not in draft state')
  }
  if (actual.sku !== expected.sku) {
    return verificationFailure('persisted_identity_mismatch', 'Saved draft identity does not match Fold')
  }
  if (actual.title !== expected.title) {
    return verificationFailure('persisted_title_mismatch', 'Saved draft title does not match Fold')
  }
  if (normalizedFormText(actual.description) !== normalizedFormText(expected.description)) {
    return verificationFailure(
      'persisted_description_mismatch',
      'Saved draft description does not match Fold'
    )
  }
  if (actual.price !== expected.price) {
    return verificationFailure('persisted_price_mismatch', 'Saved draft price does not match Fold')
  }
  if (!valuesEqual(actual.photo_filenames, expected.photo_filenames)) {
    return verificationFailure(
      'persisted_photo_order_mismatch',
      'Saved draft photo order does not match Fold'
    )
  }

  const actualFields = actual.structured_fields
  if (actualFields === null || typeof actualFields !== 'object' || Array.isArray(actualFields)) {
    if (expected.structured_fields && Object.keys(expected.structured_fields).length > 0) {
      return verificationFailure(
        'persisted_structured_fields_missing',
        'Saved draft structured fields could not be read'
      )
    }
  } else {
    for (const [key, value] of Object.entries(expected.structured_fields)) {
      if (!valuesEqual(actualFields[key], value)) {
        return verificationFailure(
          'persisted_structured_field_mismatch',
          `Saved draft ${key} does not match Fold`
        )
      }
    }
  }

  if (
    saveResult.canonical_url !== undefined &&
    actual.canonical_url !== saveResult.canonical_url
  ) {
    return verificationFailure(
      'persisted_canonical_url_mismatch',
      'Saved draft URL changed during verification'
    )
  }
  if (
    saveResult.external_identity !== undefined &&
    actual.external_identity !== saveResult.external_identity
  ) {
    return verificationFailure(
      'persisted_external_identity_mismatch',
      'Saved draft external identity changed during verification'
    )
  }
  return { verified: true }
}

export function createDepopAdapter(options = {}) {
  const browser = options.browser
  const profile = options.profile ?? createDepopTargetProfile(options.target)
  const inferenceChallenges = new WeakMap()
  const trustedResolvedDrafts = new WeakSet()

  function validateListing(listing) {
    const errors = []
    if (listing === null || typeof listing !== 'object' || Array.isArray(listing)) {
      return {
        valid: false,
        errors: [validationError('invalid_listing', 'listing', 'listing must be an object')],
      }
    }
    for (const field of ['listing_id', 'title', 'description', 'platform']) {
      if (!nonEmptyString(listing[field])) {
        errors.push(validationError(`missing_${field}`, field, `${field} is required`))
      }
    }
    if (listing.platform !== undefined && listing.platform !== DEPOP_ADAPTER_ID) {
      errors.push(
        validationError('wrong_platform', 'platform', 'listing platform must be depop')
      )
    }
    validateSku(listing.reference_token, errors, profile.limits.maxSkuLength)
    if (!Number.isFinite(listing.price) || listing.price <= 0) {
      errors.push(validationError('invalid_price', 'price', 'price must be a number above zero'))
    }
    const hashtags = normalizedHashtags(listing.hashtags, errors, profile.limits.maxHashtags)
    if (
      nonEmptyString(listing.title) &&
      nonEmptyString(listing.description) &&
      buildDescription({
        title: listing.title,
        description: listing.description,
        hashtags,
      }).length > profile.limits.maxDescriptionLength
    ) {
      errors.push(
        validationError(
          'description_too_long',
          'description',
          `composed Depop description exceeds ${profile.limits.maxDescriptionLength} characters`
        )
      )
    }
    if (!Array.isArray(listing.photos) || listing.photos.length === 0) {
      errors.push(validationError('missing_photos', 'photos', 'at least one available photo is required'))
    } else {
      if (listing.photos.length > profile.limits.maxPhotos) {
        errors.push(
          validationError(
            'too_many_photos',
            'photos',
            `photos exceeds the target-profile maximum of ${profile.limits.maxPhotos}`
          )
        )
      }
      listing.photos.forEach((photo, index) => validatePhoto(photo, index, errors))
    }
    if (listing.unavailable_photo_count !== 0) {
      errors.push(
        validationError(
          'unavailable_photos',
          'unavailable_photo_count',
          'all approved photos must be available'
        )
      )
    }
    if (
      nonEmptyString(listing.condition) &&
      normalizedCondition(listing.condition, profile) === undefined
    ) {
      errors.push(
        validationError(
          'unsupported_condition',
          'condition',
          'condition has no evidence-backed Depop mapping'
        )
      )
    }
    if (
      listing.condition !== undefined &&
      listing.condition !== null &&
      !nonEmptyString(listing.condition)
    ) {
      errors.push(
        validationError(
          'invalid_structured_value',
          'condition',
          'condition must be a non-empty string when supplied'
        )
      )
    }
    if (
      listing.category !== undefined &&
      listing.category !== null &&
      !nonEmptyString(listing.category)
    ) {
      errors.push(
        validationError(
          'invalid_structured_value',
          'category',
          'category must be a non-empty string when supplied'
        )
      )
    }
    const absent = new Set()
    for (const key of REQUIRED_STRUCTURED_FIELDS) {
      if (validateRequiredStructuredValue(listing, key, errors)) absent.add(key)
    }
    for (const [listingKey] of DIRECT_STRUCTURED_FIELDS) {
      if (absent.has(listingKey)) continue
      validateOptionalStructuredValue(listing, listingKey, errors)
    }
    if (!absent.has('color')) validateColor(listing.color, errors)
    if (!absent.has('size')) validateSize(listing, errors)
    return { valid: errors.length === 0, errors }
  }

  function prepareDraft(listing) {
    const validation = validateListing(listing)
    if (!validation.valid) {
      throw new DepopAdapterError('invalid_listing', 'Listing is not safe to send to Depop', {
        errors: validation.errors,
      })
    }

    // Depop's category is audience-scoped while Fold's is free text, so the authenticated profile
    // resolves it through the audience prefix rather than writing Fold's value verbatim. The value
    // Depop finally holds is the option label chosen at the form, which is not knowable here, so
    // category stays out of structuredFields and never becomes a persisted-equality assertion.
    const categorySelection = profile.kind === 'depop'
      ? depopCategorySelection(listing.category, profile)
      : null

    const structuredFields = []
    if (nonEmptyString(listing.category) && profile.kind !== 'depop') {
      structuredFields.push({ key: 'category', value: listing.category, locator: profile.fields.category })
    }
    const condition = normalizedCondition(listing.condition, profile)
    if (condition !== undefined) {
      structuredFields.push({ key: 'condition', value: condition, locator: profile.fields.condition })
    }
    const gated = profile.kind === 'depop' && categorySelection === null ? CATEGORY_GATED_FIELDS : []
    for (const [listingKey, profileKey] of DIRECT_STRUCTURED_FIELDS) {
      if (gated.includes(listingKey)) continue
      const value = normalizedStructuredValue(listingKey, listing[listingKey])
      if (nonEmptyString(value) || (Array.isArray(value) && value.length > 0)) {
        structuredFields.push({ key: listingKey, value, locator: profile.fields[profileKey] })
      }
    }

    const formattedHashtags = normalizedHashtags(
      listing.hashtags,
      [],
      profile.limits.maxHashtags
    )
    const description = buildDescription({
      title: listing.title,
      description: listing.description,
      hashtags: formattedHashtags,
    })
    const photos = listing.photos.map((photo, order) => ({
      sourceUrl: photo.url,
      filename: photo.filename,
      order,
    }))
    const formFields = [
      { key: 'title', value: listing.title, locator: profile.fields.title, operation: 'fill' },
      { key: 'description', value: description, locator: profile.fields.description, operation: 'fill' },
      { key: 'sku', value: listing.reference_token, locator: profile.fields.sku, operation: 'fill' },
      { key: 'price', value: listing.price.toFixed(2), locator: profile.fields.price, operation: 'fill' },
      ...structuredFields.map((field) => ({ ...field, operation: 'select' })),
      { key: 'photos', value: photos, locator: profile.fields.photos, operation: 'upload' },
    ]

    return Object.freeze({
      adapter: DEPOP_ADAPTER_ID,
      targetProfile: profile.name,
      foldListingId: listing.listing_id,
      entryUrl: profile.entryUrl,
      sku: listing.reference_token,
      quantity: DEPOP_DRAFT_QUANTITY,
      approvedContent: Object.freeze({
        title: listing.title,
        description: listing.description,
        hashtags: Object.freeze([...(listing.hashtags ?? [])]),
      }),
      description,
      price: listing.price.toFixed(2),
      categorySelection,
      structuredFields: Object.freeze(structuredFields.map((field) => Object.freeze(field))),
      photos: Object.freeze(photos.map((photo) => Object.freeze(photo))),
      formFields: Object.freeze(formFields.map((field) => Object.freeze(field))),
      actions: profile.actions,
    })
  }

  function resolveInference({ prepared, saveResult, decision } = {}) {
    const challenge =
      saveResult !== null && typeof saveResult === 'object'
        ? inferenceChallenges.get(saveResult)
        : undefined
    if (challenge === undefined || challenge.prepared !== prepared) {
      throw new DepopAdapterError(
        'category_inference_challenge_untrusted',
        "Category inference requires this adapter instance's actual inference request"
      )
    }
    if (challenge.consumed) {
      throw new DepopAdapterError(
        'category_inference_challenge_replayed',
        'Category inference requests may be resolved only once'
      )
    }
    challenge.consumed = true
    const resolved = resolveCategoryChoice({ prepared, saveResult, decision })
    trustedResolvedDrafts.add(resolved)
    return resolved
  }

  async function saveDraft({ listing, prepared }) {
    const activeBrowser = requireBrowser(browser)
    if (prepared === null || typeof prepared !== 'object' || prepared.adapter !== DEPOP_ADAPTER_ID) {
      throw new DepopAdapterError('invalid_prepared_draft', 'prepared must come from prepareDraft()')
    }
    if (listing?.listing_id !== prepared.foldListingId || listing?.reference_token !== prepared.sku) {
      throw new DepopAdapterError(
        'prepared_listing_mismatch',
        'Prepared draft no longer matches the selected Fold listing'
      )
    }
    const currentPrepared = prepareDraft(listing)
    if (preparedSignature(prepared) !== preparedSignature(currentPrepared)) {
      throw new DepopAdapterError(
        'prepared_listing_mismatch',
        'Prepared draft does not match the current approved listing content'
      )
    }
    if (
      prepared.categorySelection?.status === 'resolved' &&
      !trustedResolvedDrafts.has(prepared)
    ) {
      throw new DepopAdapterError(
        'category_inference_resolution_untrusted',
        'Resolved category must come from this adapter instance inference gate'
      )
    }
    if (prepared.categorySelection?.status === 'resolved') {
      // A model-resolved transaction gets one browser attempt. Reusing the prepared object could
      // create a duplicate after an ambiguous response, so consume trust before browser work.
      trustedResolvedDrafts.delete(prepared)
    }

    if (profile.kind === 'depop') {
      if (typeof activeBrowser.savePreparedDraft !== 'function') {
        throw new DepopAdapterError(
          'invalid_browser_contract',
          'Authenticated Depop requires savePreparedDraft()'
        )
      }
      try {
        return normalizedSaveSuccess(
          await activeBrowser.savePreparedDraft({ listing, prepared }),
          profile
        )
      } catch (error) {
        // Category inference is requested before a draft exists. The returned object identity is
        // bound to this adapter instance so callers cannot fabricate or replay an offered set.
        if (
          error?.code === 'browser_category_inference_required' &&
          Array.isArray(error.candidates)
        ) {
          const candidates = Object.freeze(
            error.candidates
              .filter(
                (candidate) =>
                  nonEmptyString(candidate?.label) && nonEmptyString(candidate?.group)
              )
              .map((candidate) => Object.freeze({
                label: candidate.label,
                group: candidate.group,
              }))
          )
          const saveResult = Object.freeze({
            outcome: 'inference_required',
            failure_code: 'browser_category_inference_required',
            fold_listing_id: prepared.foldListingId,
            inference: Object.freeze({
              field: 'category',
              source_value: prepared.categorySelection?.sourceValue,
              audience: prepared.categorySelection?.audience,
            }),
            candidates,
            error: 'Depop category requires bounded inference among live options',
          })
          inferenceChallenges.set(saveResult, { prepared, consumed: false })
          return saveResult
        }
        const browserCode =
          typeof error?.code === 'string' && /^[a-z0-9_]+$/.test(error.code)
            ? error.code
            : null
        const failureStage =
          typeof error?.stage === 'string' && /^[a-z0-9_]+$/.test(error.stage)
            ? error.stage
            : 'authenticated_draft_transaction'
        const failureCode = browserCode ?? `browser_${failureStage}_failed`
        return {
          outcome: error?.externalWriteAttempted === true ? 'ambiguous_save' : 'save_failed',
          failure_code: failureCode,
          error: `Authenticated draft transaction failed during ${failureStage.replaceAll('_', ' ')}`,
        }
      }
    }

    let saveActivated = false
    let stage = 'navigate_to_drafts_hub'
    try {
      await activeBrowser.navigate(prepared.entryUrl)
      stage = 'inspect_drafts_hub'
      assertSurface(await activeBrowser.inspectDraftSurface(), prepared, 'drafts hub')
      stage = 'open_draft_form'
      await activeBrowser.activate(prepared.actions.addDraft)
      stage = 'inspect_draft_form'
      assertSurface(await activeBrowser.inspectDraftSurface(), prepared, 'draft form')

      for (const field of prepared.formFields) {
        stage = `populate_${field.key}`
        if (field.operation === 'fill') {
          await activeBrowser.fillField(field.locator, field.value)
        } else if (field.operation === 'select') {
          await activeBrowser.selectField(field.locator, field.value)
        } else if (field.operation === 'upload') {
          await activeBrowser.uploadPhotos(field.locator, field.value)
        }
      }

      stage = 'verify_draft_form_controls'
      assertSurface(await activeBrowser.inspectDraftSurface(), prepared, 'draft form')
      saveActivated = true
      stage = 'save_draft'
      await activeBrowser.activate(prepared.actions.saveDraft)
      stage = 'observe_saved_draft'
      return normalizedSaveSuccess(await activeBrowser.observeDraftSave(), profile)
    } catch (error) {
      if (error instanceof DepopAdapterError && !saveActivated) throw error
      return {
        outcome: saveActivated ? 'ambiguous_save' : 'save_failed',
        failure_code: `browser_${stage}_failed`,
        error: `Browser operation failed during ${stage.replaceAll('_', ' ')}`,
      }
    }
  }

  async function verifyDraft({ listing, prepared, saveResult }) {
    const activeBrowser = requireBrowser(browser)
    if (listing?.listing_id !== prepared?.foldListingId || listing?.reference_token !== prepared?.sku) {
      return verificationFailure(
        'verification_listing_mismatch',
        'Verification input no longer matches the selected Fold listing'
      )
    }
    if (
      saveResult?.outcome !== 'draft_saved' ||
      String(saveResult.status ?? '').trim().toLowerCase() !== 'draft'
    ) {
      return verificationFailure(
        'verification_save_result_invalid',
        'Verification requires a confirmed draft save result'
      )
    }
    if (
      !nonEmptyString(saveResult.canonical_url) &&
      !nonEmptyString(saveResult.external_identity)
    ) {
      return verificationFailure(
        'verification_identity_missing',
        'Verification requires a stable draft identity'
      )
    }

    try {
      const actual = await activeBrowser.readDraft({
        canonical_url: saveResult.canonical_url,
        external_identity: saveResult.external_identity,
        sku: prepared.sku,
      })
      return verifyPersistedDraft(actual, prepared, saveResult)
    } catch {
      return verificationFailure(
        'draft_read_failed',
        'Saved draft could not be read from the browser'
      )
    }
  }

  function metrics() {
    if (typeof browser?.metrics !== 'function') return null
    return browser.metrics()
  }

  return Object.freeze({
    id: DEPOP_ADAPTER_ID,
    platform: DEPOP_ADAPTER_ID,
    validateListing,
    prepareDraft,
    resolveInference,
    saveDraft,
    verifyDraft,
    metrics,
  })
}
