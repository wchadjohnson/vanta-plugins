import { withDetail } from '../shared/error-detail.mjs'
import {
  createAuthenticatedVintedTargetProfile,
  VINTED_CONDITIONS,
  VINTED_FIXED_FIELDS,
  vintedCategoryPath,
} from './profile.mjs'

export const VINTED_ADAPTER_ID = 'vinted'

const REQUIRED_BROWSER_METHODS = Object.freeze(['savePreparedDraft', 'readDraft'])
const VINTED_ID = /^\d+$/
const CATEGORY_LIST_CODE = /^[a-z][a-z0-9_]*$/

export class VintedAdapterError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'VintedAdapterError'
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

/**
 * One `marketplace_fields` entry as a list of Vinted values, or an error. Fold sends every field as
 * an array of strings; a key it sends is a fact it resolved, so an empty or malformed entry is a
 * projection fault to refuse, never a gap to fill.
 */
function fieldValues(fields, key, errors) {
  const values = fields[key]
  if (values === undefined) return []
  if (!Array.isArray(values) || values.length === 0 || !values.every(nonEmptyString)) {
    errors.push(
      validationError(
        'invalid_marketplace_field',
        `marketplace_fields.${key}`,
        `marketplace_fields.${key} must be a non-empty array of strings`
      )
    )
    return []
  }
  return values
}

function singleId(fields, key, errors, { required }) {
  const values = fieldValues(fields, key, errors)
  if (values.length === 0) {
    if (required && fields[key] === undefined) {
      errors.push(validationError(`missing_${key}`, `marketplace_fields.${key}`, `${key} is required for a Vinted draft`))
    }
    return null
  }
  if (values.length !== 1 || !VINTED_ID.test(values[0])) {
    errors.push(
      validationError(
        `invalid_${key}`,
        `marketplace_fields.${key}`,
        `${key} must be exactly one Vinted id`
      )
    )
    return null
  }
  return values[0]
}

function idList(fields, key, max, errors) {
  const values = fieldValues(fields, key, errors)
  if (values.some((value) => !VINTED_ID.test(value))) {
    errors.push(validationError(`invalid_${key}`, `marketplace_fields.${key}`, `${key} must be Vinted ids`))
    return []
  }
  if (values.length > max) {
    errors.push(
      validationError(`too_many_${key}`, `marketplace_fields.${key}`, `Vinted accepts at most ${max} ${key} values`)
    )
    return []
  }
  if (new Set(values).size !== values.length) {
    errors.push(validationError(`duplicate_${key}`, `marketplace_fields.${key}`, `each ${key} value must differ`))
    return []
  }
  return values
}

function singleLabel(fields, key, errors) {
  const values = fieldValues(fields, key, errors)
  if (values.length === 0) return null
  if (values.length !== 1) {
    errors.push(validationError(`invalid_${key}`, `marketplace_fields.${key}`, `${key} must be one value`))
    return null
  }
  return values[0]
}

/**
 * Reads Fold's projection into the exact values the form takes. Returns null with errors pushed
 * when anything is missing or malformed; the caller refuses the listing rather than guessing.
 */
function projectFields(listing, profile, errors) {
  const fields = listing.marketplace_fields
  if (fields === null || fields === undefined) {
    errors.push(
      validationError(
        'marketplace_fields_missing',
        'marketplace_fields',
        "Fold sent no Vinted field projection for this listing (its projection read failed), so the form's ids are unknown"
      )
    )
    return null
  }
  if (typeof fields !== 'object' || Array.isArray(fields)) {
    errors.push(validationError('invalid_marketplace_fields', 'marketplace_fields', 'marketplace_fields must be an object'))
    return null
  }
  const before = errors.length

  const categoryId = singleId(fields, 'category', errors, { required: true })
  const category = categoryId === null ? null : vintedCategoryPath(categoryId)
  if (categoryId !== null && category === null) {
    errors.push(
      validationError(
        'unsupported_category',
        'marketplace_fields.category',
        'category is not a listable Vinted fashion leaf this adapter can walk to'
      )
    )
  }

  const conditionId = singleId(fields, 'condition', errors, { required: true })
  if (conditionId !== null && !Object.hasOwn(VINTED_CONDITIONS, conditionId)) {
    errors.push(
      validationError('unsupported_condition', 'marketplace_fields.condition', 'condition is not a Vinted condition id')
    )
  }
  const packageSize = singleId(fields, 'package_size', errors, { required: true })
  const brand = singleLabel(fields, 'brand', errors)
  const size = singleLabel(fields, 'size', errors)
  const colors = idList(fields, 'color', profile.limits.maxColors, errors)
  const materials = idList(fields, 'material', profile.limits.maxMaterials, errors)

  const lists = []
  for (const key of Object.keys(fields).sort()) {
    if (VINTED_FIXED_FIELDS.includes(key)) continue
    if (!CATEGORY_LIST_CODE.test(key)) {
      errors.push(
        validationError('unsupported_marketplace_field', `marketplace_fields.${key}`, `${key} is not a Vinted form field`)
      )
      continue
    }
    const id = singleId(fields, key, errors, { required: false })
    if (id !== null) lists.push(Object.freeze({ code: key, id }))
  }

  if (errors.length !== before) return null
  return {
    category,
    condition: Object.freeze({ id: conditionId, label: VINTED_CONDITIONS[conditionId] }),
    packageSize,
    brand,
    size,
    colors,
    materials,
    lists,
  }
}

function validatePhotos(listing, profile, errors) {
  if (!Array.isArray(listing.photos) || listing.photos.length === 0) {
    errors.push(validationError('missing_photos', 'photos', 'at least one available photo is required'))
    return
  }
  if (listing.photos.length > profile.limits.maxPhotos) {
    errors.push(
      validationError('too_many_photos', 'photos', `Vinted accepts at most ${profile.limits.maxPhotos} photos`)
    )
  }
  listing.photos.forEach((photo, index) => {
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
  })
  if (listing.unavailable_photo_count !== 0) {
    errors.push(
      validationError('unavailable_photos', 'unavailable_photo_count', 'all approved photos must be available')
    )
  }
}

function normalizedFormText(value) {
  return typeof value === 'string' ? value.replace(/\r\n/g, '\n') : value
}

function requireBrowser(browser) {
  if (browser === null || typeof browser !== 'object' || Array.isArray(browser)) {
    throw new VintedAdapterError('missing_browser', 'A qualified browser capability is required to save a Vinted draft')
  }
  for (const method of REQUIRED_BROWSER_METHODS) {
    if (typeof browser[method] !== 'function') {
      throw new VintedAdapterError('invalid_browser_contract', `Browser capability is missing ${method}()`)
    }
  }
  return browser
}

function preparedSignature(prepared) {
  return JSON.stringify(prepared)
}

function safeCode(value) {
  return typeof value === 'string' && /^[a-z0-9_]+$/.test(value) ? value : null
}

function verificationFailure(code, reason) {
  return { verified: false, failure_code: code, reason }
}

function savedResult(observed, profileName) {
  if (observed?.outcome !== 'saved' || !nonEmptyString(observed.canonical_url)) {
    return {
      outcome: 'ambiguous_save',
      failure_code: 'save_observation_missing',
      error: 'Draft save did not expose a confirmed draft identity',
      external_write_attempted: true,
    }
  }
  return {
    outcome: 'draft_saved',
    status: 'draft',
    canonical_url: observed.canonical_url,
    external_identity: observed.external_identity,
    target_profile: profileName,
    ...(observed.notes !== undefined && Object.keys(observed.notes).length > 0
      ? { notes: { ...observed.notes } }
      : {}),
  }
}

/** One browser failure as a save outcome, its cause carried in `error`. */
function failedSave(error) {
  const stage = safeCode(error?.stage) ?? 'draft_transaction'
  const failureCode = safeCode(error?.code) ?? `browser_${stage}_failed`
  const result = {
    failure_code: failureCode,
    error: withDetail(`Vinted draft transaction failed during ${stage.replaceAll('_', ' ')}`, error),
    external_write_attempted: error?.externalWriteAttempted === true,
  }
  if (typeof error?.field === 'string') result.field = error.field
  if (Array.isArray(error?.candidates)) result.candidates = [...error.candidates]
  if (error?.notes !== undefined && Object.keys(error.notes).length > 0) result.notes = { ...error.notes }
  if (error?.expectedFields !== null && typeof error?.expectedFields === 'object') {
    result.expected_fields = JSON.parse(JSON.stringify(error.expectedFields))
  }
  if (error?.code === 'vinted_draft_already_exists') {
    return {
      ...result,
      outcome: 'existing_draft',
      error: withDetail('A Vinted draft with this exact title already exists; nothing was created', error),
    }
  }
  // Save draft was pressed but Vinted had not shown the draft yet: a later call looks for it.
  if (error?.pendingConfirmation === true) return { ...result, outcome: 'awaiting_save_confirmation' }
  if (error?.blocking === true) {
    return {
      ...result,
      outcome: 'blocked_precondition',
      error: withDetail('Vinted blocked the draft on a precondition the seller must clear', error),
    }
  }
  return { ...result, outcome: error?.externalWriteAttempted === true ? 'ambiguous_save' : 'save_failed' }
}

/**
 * The Vinted draft adapter: Fold's `marketplace_fields` ids onto the vinted.com sell form, saved
 * with Save draft and never with Upload, which publishes.
 *
 * Vinted has no simulator target, so the default profile is the real one. That alone reaches
 * nothing: validation and preparation are pure, and a save needs a host-provided browser
 * capability, which is only ever built from a profile the caller passes explicitly.
 */
export function createVintedAdapter(options = {}) {
  const browser = options.browser
  const profile = options.profile ?? createAuthenticatedVintedTargetProfile(options.target)

  function validateListing(listing) {
    const errors = []
    if (listing === null || typeof listing !== 'object' || Array.isArray(listing)) {
      return { valid: false, errors: [validationError('invalid_listing', 'listing', 'listing must be an object')] }
    }
    for (const field of ['listing_id', 'title', 'description', 'platform']) {
      if (!nonEmptyString(listing[field])) {
        errors.push(validationError(`missing_${field}`, field, `${field} is required`))
      }
    }
    if (listing.platform !== undefined && listing.platform !== VINTED_ADAPTER_ID) {
      errors.push(validationError('wrong_platform', 'platform', 'listing platform must be vinted'))
    }
    if (!nonEmptyString(listing.reference_token)) {
      errors.push(validationError('missing_reference_token', 'reference_token', 'reference_token is required'))
    }
    if (nonEmptyString(listing.title) && listing.title.length > profile.limits.maxTitleLength) {
      errors.push(
        validationError('title_too_long', 'title', `title exceeds ${profile.limits.maxTitleLength} characters`)
      )
    }
    if (
      nonEmptyString(listing.description) &&
      listing.description.length > profile.limits.maxDescriptionLength
    ) {
      errors.push(
        validationError(
          'description_too_long',
          'description',
          `description exceeds ${profile.limits.maxDescriptionLength} characters`
        )
      )
    }
    if (
      !Number.isFinite(listing.price) ||
      listing.price < profile.limits.minPrice ||
      listing.price > profile.limits.maxPrice
    ) {
      errors.push(
        validationError(
          'invalid_price',
          'price',
          `price must be between $${profile.limits.minPrice} and $${profile.limits.maxPrice}`
        )
      )
    }
    validatePhotos(listing, profile, errors)
    projectFields(listing, profile, errors)
    return { valid: errors.length === 0, errors }
  }

  function prepareDraft(listing) {
    const validation = validateListing(listing)
    if (!validation.valid) {
      throw new VintedAdapterError('invalid_listing', 'Listing is not safe to send to Vinted', {
        errors: validation.errors,
      })
    }
    const projected = projectFields(listing, profile, [])
    return Object.freeze({
      adapter: VINTED_ADAPTER_ID,
      targetProfile: profile.name,
      foldListingId: listing.listing_id,
      entryUrl: profile.entryUrl,
      title: listing.title,
      description: listing.description,
      price: listing.price.toFixed(2),
      photos: Object.freeze(
        listing.photos.map((photo, order) =>
          Object.freeze({ sourceUrl: photo.url, filename: photo.filename, order })
        )
      ),
      category: projected.category,
      brand: projected.brand,
      size: projected.size,
      condition: projected.condition,
      colors: Object.freeze([...projected.colors]),
      materials: Object.freeze([...projected.materials]),
      lists: Object.freeze([...projected.lists]),
      packageSize: projected.packageSize,
    })
  }

  async function saveDraft({ listing, prepared } = {}) {
    const activeBrowser = requireBrowser(browser)
    if (prepared === null || typeof prepared !== 'object' || prepared.adapter !== VINTED_ADAPTER_ID) {
      throw new VintedAdapterError('invalid_prepared_draft', 'prepared must come from prepareDraft()')
    }
    if (listing?.listing_id !== prepared.foldListingId) {
      throw new VintedAdapterError('prepared_listing_mismatch', 'Prepared draft no longer matches the selected Fold listing')
    }
    if (preparedSignature(prepared) !== preparedSignature(prepareDraft(listing))) {
      throw new VintedAdapterError(
        'prepared_listing_mismatch',
        'Prepared draft does not match the current approved listing content'
      )
    }

    try {
      return savedResult(await activeBrowser.savePreparedDraft({ prepared }), profile.name)
    } catch (error) {
      return failedSave(error)
    }
  }

  /**
   * Looks for a draft an earlier call saved but could not confirm (`awaiting_save_confirmation`).
   * Never saves: the browser only reads the seller's wardrobe.
   */
  async function confirmSavedDraft({ listing, prepared, expectedFields } = {}) {
    const activeBrowser = requireBrowser(browser)
    if (typeof activeBrowser.confirmSavedDraft !== 'function') {
      throw new VintedAdapterError('invalid_browser_contract', 'Browser capability is missing confirmSavedDraft()')
    }
    if (prepared?.adapter !== VINTED_ADAPTER_ID || listing?.listing_id !== prepared.foldListingId) {
      throw new VintedAdapterError('prepared_listing_mismatch', 'Prepared draft no longer matches the selected Fold listing')
    }
    try {
      return savedResult(await activeBrowser.confirmSavedDraft({ prepared, expectedFields }), profile.name)
    } catch (error) {
      return failedSave(error)
    }
  }

  async function verifyDraft({ listing, prepared, saveResult } = {}) {
    const activeBrowser = requireBrowser(browser)
    if (listing?.listing_id !== prepared?.foldListingId) {
      return verificationFailure('verification_listing_mismatch', 'Verification input no longer matches the selected Fold listing')
    }
    if (saveResult?.outcome !== 'draft_saved' || !nonEmptyString(saveResult.external_identity)) {
      return verificationFailure('verification_save_result_invalid', 'Verification requires a confirmed draft save result')
    }
    let actual
    try {
      actual = await activeBrowser.readDraft({ external_identity: saveResult.external_identity })
    } catch (error) {
      if (error?.blocking === true) {
        return verificationFailure(safeCode(error.code) ?? 'draft_read_blocked', 'Vinted blocked the draft read behind account verification')
      }
      return verificationFailure(
        'draft_read_failed',
        withDetail('Saved draft could not be read from the browser', error)
      )
    }
    if (actual?.external_identity !== saveResult.external_identity) {
      return verificationFailure('persisted_identity_mismatch', 'Saved draft identity does not match the save')
    }
    if (actual.is_draft !== true) {
      return verificationFailure('persisted_status_mismatch', 'The saved item is not a draft (no Delete draft control)')
    }
    if (Array.isArray(actual.field_mismatches) && actual.field_mismatches.length > 0) {
      return verificationFailure(
        'persisted_field_mismatch',
        `The saved draft does not hold what was entered for: ${actual.field_mismatches.join(', ')}`
      )
    }
    if (actual.title !== prepared.title) {
      return verificationFailure('persisted_title_mismatch', 'Saved draft title does not match Fold')
    }
    if (normalizedFormText(actual.description) !== normalizedFormText(prepared.description)) {
      return verificationFailure('persisted_description_mismatch', 'Saved draft description does not match Fold')
    }
    if (actual.price !== prepared.price) {
      return verificationFailure('persisted_price_mismatch', 'Saved draft price does not match Fold')
    }
    if (actual.category !== prepared.category.title) {
      return verificationFailure('persisted_category_mismatch', 'Saved draft category does not match Fold')
    }
    return { verified: true }
  }

  function metrics() {
    if (typeof browser?.metrics !== 'function') return null
    return browser.metrics()
  }

  return Object.freeze({
    id: VINTED_ADAPTER_ID,
    platform: VINTED_ADAPTER_ID,
    validateListing,
    prepareDraft,
    saveDraft,
    confirmSavedDraft,
    verifyDraft,
    metrics,
  })
}
