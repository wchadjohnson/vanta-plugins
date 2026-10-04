import { VINTED_CATEGORY_ANCESTRY as ancestry } from './category-ancestry.mjs'

export const VINTED_ORIGIN = 'https://www.vinted.com'
export const VINTED_CREATE_PATH = '/items/new'

/**
 * Vinted answers API error 115 (UserVerificationRequired) by navigating to `/users/verification`
 * and error 168 to `/users/verification/phone` — read from the sell form's own JS chunk on
 * 2026-10-03, and observed live when choosing a category on an account without a phone number.
 * Reaching either is a blocking precondition the seller must clear themselves: the adapter stops
 * and reports it, and never works around it.
 */
export const VINTED_VERIFICATION_PATH_PREFIX = '/users/verification'

/**
 * The sell form at `/items/new`, captured live 2026-10-04 from the owner's logged-in session
 * (read-only, nothing saved). Every control is addressed by the `data-testid` or `id` Vinted itself
 * renders; none of these is a guess. Option rows are keyed by Vinted's own ids, which is also what
 * Fold's `marketplace_fields` projection sends, so the adapter maps ids to controls and never
 * re-derives a taxonomy.
 */
const CONTROLS = Object.freeze({
  photosInput: 'add-photos-input',
  photosTrigger: 'Upload photos',
  title: 'title--input',
  description: 'description--input',
  category: 'catalog-select-dropdown-input',
  categoryContent: 'catalog-select-dropdown-content',
  brand: 'brand-select-dropdown-input',
  brandSearch: 'brand-search--input',
  brandEmptyState: 'brand_empty_state',
  size: 'category-size-single-grid-input',
  condition: 'category-condition-single-list-input',
  color: 'color-select-dropdown-input',
  material: 'category-material-multi-list-input',
  price: 'price-input--input',
  saveDraft: 'upload-form-save-draft-button',
})

/**
 * Vinted's "Upload" button publishes the listing. It sits beside Save draft, and nothing in this
 * adapter may ever activate it: every click the capability makes is checked against this test id
 * and this exact name before it is sent.
 */
export const VINTED_PUBLISH_TEST_ID = 'upload-form-save-button'
export const VINTED_PUBLISH_NAME = 'Upload'
export const VINTED_SAVE_DRAFT_NAME = 'Save draft'

const LIVE_ACTION_PATTERN = /\b(upload|post|publish|list|make\s+live)\b/i

/** Option-row ids and test ids, each a template over Vinted's own id for that value. */
const OPTIONS = Object.freeze({
  catalogRow: (id) => `catalog-${id}`,
  // Observed live 2026-10-04: once Vinted has guessed a category from the photos, the open picker
  // lists it under "Suggested" as a radio keyed by the same leaf id.
  catalogSuggestion: (id) => `catalog-suggestion-${id}`,
  brand: (id) => `brand-${id}`,
  brandCustom: 'custom-select-brand',
  brandNone: 'empty-brand',
  brandPopularLabel: 'brand-popular-label',
  brandSearchInput: 'brand-search-input',
  condition: (id) => `condition-${id}`,
  conditionTitle: (id) => `condition-${id}--title`,
  color: (id) => `color-${id}`,
  colorCheckbox: (id) => `color-checkbox-${id}`,
  material: (id) => `material-${id}`,
  materialCheckbox: (id) => `material-checkbox-${id}`,
  listInput: (code) => `category-${code}-single-list-input`,
  listOption: (code, id) => `${code}-${id}`,
  packageSize: (id) => `package_type_selector_${id}`,
})

/**
 * Vinted's proof-of-authenticity prompts, observed live 2026-10-04 after a branded item's photos
 * were uploaded (Columbia): an inline hint under Brand, and a modal the hint's button opens. Both
 * are informational. The modal is only ever closed with its own Close button; "Add photos" and the
 * hint's "which proofs of authenticity are essential" button are never clicked.
 */
const AUTHENTICITY = Object.freeze({
  overlayHeading: 'How do you prove that your item is authentic?',
  overlayClose: 'Close',
  inlineHeading: 'Make sure you’ve added these photos:',
  neverClick: Object.freeze(['Add photos', 'which proofs of authenticity are essential']),
  hint:
    'Vinted asks for proof-of-authenticity photos for this brand (logo, care label, sewn or ' +
    'embroidered logos); without them the listing may be hidden or removed.',
})

/**
 * The element id of each field's input, keyed by its test id. Captured on the sell form and seen
 * again in every live run's accessibility tree (`ID: brand`, `ID: category`, …).
 */
const FIELD_IDS = Object.freeze({
  [CONTROLS.title]: 'title',
  [CONTROLS.description]: 'description',
  [CONTROLS.category]: 'category',
  [CONTROLS.brand]: 'brand',
  [CONTROLS.size]: 'size',
  [CONTROLS.condition]: 'condition',
  [CONTROLS.color]: 'color',
  [CONTROLS.material]: 'material',
  [CONTROLS.price]: 'price',
})

const OPTION_PATTERNS = Object.freeze({
  catalogSuggestion: /^catalog-suggestion-\d+$/,
  catalogRow: /^catalog-\d+$/,
  brand: /^brand-\d+$/,
  sizeOption: /^size-group-\d+-grid-option-\d+$/,
  colorCheckbox: /^color-checkbox-\d+$/,
  colorRow: /^color-\d+$/,
  materialRow: /^material-\d+$/,
  materialCheckbox: /^material-checkbox-\d+$/,
  packageSize: /^package_type_selector_\d+$/,
})

/** Vinted's condition ids (attribute 431), the same set on every fashion leaf. */
export const VINTED_CONDITIONS = Object.freeze({
  6: 'New with tags',
  1: 'New without tags',
  2: 'Very good',
  3: 'Good',
  4: 'Satisfactory',
})

/**
 * `marketplace_fields` keys the form reads as fixed controls. Any other key Fold sends is a
 * category-specific single list (`skirt_length` on Skirts was observed), rendered as
 * `#{code}` with options `#{code}-{id}`.
 */
export const VINTED_FIXED_FIELDS = Object.freeze([
  'category',
  'brand',
  'size',
  'condition',
  'color',
  'material',
  'package_size',
])

/**
 * Where Save draft lands and how the new draft is found, captured live 2026-10-04 (run 11, the first
 * real draft): Save draft lands on the seller's wardrobe, `/member/{memberId}`, not on a per-draft
 * URL. Each wardrobe card is `[data-testid=product-item-id-{itemId}]` with a status text
 * (`…--status-text`, "Draft") and an overlay link (`…--overlay-link`) to `/items/{itemId}/edit` —
 * the draft's stable URL, which re-renders the full form with every persisted value. The link's
 * `title` attribute summarises the listing; on the owner's own wardrobe `…--description-title` is
 * a view count, not the title (run 12).
 */
const WARDROBE_PATH_PATTERN = /^\/member\/(\d+)\/?$/
const DRAFT_EDIT_PATH_PATTERN = /^\/items\/(\d+)\/edit\/?$/
const WARDROBE = Object.freeze({
  cardLinkSelector: '[data-testid^="product-item-id-"][data-testid$="--overlay-link"]',
  cardLinkTestId: /^product-item-id-(\d+)--overlay-link$/,
  status: (id) => `product-item-id-${id}--status-text`,
  cardImageSelector: (id) => `[data-testid="product-item-id-${id}"] img`,
  // `${title}, brand: ${brand}, condition: ${condition}, size: ${size}, ${price}` — the overlay
  // link's title attribute and the image's alt (run 12). `--description-title` is a view count.
  summaryBrandSeparator: ', brand: ',
  summaryConditionPart: 'condition: ',
  noBrandLabel: 'List without brand',
  draftStatus: 'Draft',
})
/**
 * Removing a sold sibling, captured live 2026-10-04 (owner-authorized; a published listing,
 * 10242220778, and a draft, 10242595621):
 *
 * - A published listing's page `/items/{itemId}` (Vinted serves `/items/{itemId}-{slug}`) carries
 *   the owner panel. Only Delete is ever clicked; Bump, Mark as sold, Mark as reserved, Hide and
 *   Edit listing never are. Delete opens `[data-testid=item-delete-modal]` (role=dialog, "Delete
 *   item / Remember: if you sold this item on Vinted, click on 'mark as sold' instead of deleting
 *   it!") whose "Confirm and delete" button deletes; the page then lands on `/member/{memberId}`
 *   and the item is gone from the wardrobe (its page 404s).
 * - A draft's `/items/{itemId}/edit` page has "Delete draft", which deletes IMMEDIATELY with no
 *   confirmation and lands on the wardrobe. It is clicked only after the page is proven to be this
 *   listing's draft: the URL's item id, the draft-only control, and the exact title.
 */
const DELIST = Object.freeze({
  publishedDelete: Object.freeze({ testId: 'item-delete-button', name: 'Delete' }),
  publishedDialog: 'item-delete-modal',
  publishedDialogText: 'Delete item',
  publishedConfirm: Object.freeze({ testId: 'item-delete-confirmation-button', name: 'Confirm and delete' }),
  publishedCancel: 'item-delete-cancelation-button',
  draftDelete: Object.freeze({ testId: 'upload-form-delete-draft-button', name: 'Delete draft' }),
  ownerPanel: Object.freeze([
    'item-bump-button',
    'mark-as-sold-button',
    'mark-as-reserved-button',
    'item-hide-button',
    'item-edit-button',
    'item-delete-button',
  ]),
  itemUrlPattern: /^\/items\/(\d+)(?:-[^/]*)?(?:\/edit)?\/?$/,
})

/**
 * Edit-page controls seen live on a saved draft. The draft capability only reads them; Delete draft
 * is clicked by the delist capability alone, under the guards described above.
 */
const DRAFT_EDIT = Object.freeze({
  deleteDraftTestId: 'upload-form-delete-draft-button',
  photoDeleteSelector: '[data-testid^="media-select-grid-delete-button-"]',
})

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a non-empty string`)
  }
  return value
}

/** True for a name that reads like a publication control rather than a draft save. */
export function isVintedLiveActionName(value) {
  return typeof value === 'string' && LIVE_ACTION_PATTERN.test(value)
}

/** The leaf's id path root -> leaf and its title, or null for a leaf Vinted's tree does not hold. */
export function vintedCategoryPath(leafId) {
  const path = ancestry.leaves[String(leafId)]
  if (!Array.isArray(path)) return null
  return Object.freeze({
    leafId: String(leafId),
    ids: Object.freeze(path.map(String)),
    titles: Object.freeze(path.map((id) => ancestry.titles[String(id)])),
    title: ancestry.titles[String(leafId)],
  })
}

/**
 * The real vinted.com profile. Automated tests construct it only to drive fakes; reaching the real
 * origin always takes an explicit opt-in, the same rule the Depop profile follows.
 */
export function createVintedTargetProfile(options = {}) {
  if (options.enableRealVinted !== true) {
    throw new Error('Real Vinted targets are disabled until separately authorized')
  }
  const saveDraft = Object.freeze({
    testId: requiredString(options.saveDraftTestId ?? CONTROLS.saveDraft, 'saveDraftTestId'),
    name: requiredString(options.saveDraftName ?? VINTED_SAVE_DRAFT_NAME, 'saveDraftName'),
  })
  if (saveDraft.testId === VINTED_PUBLISH_TEST_ID || isVintedLiveActionName(saveDraft.name)) {
    throw new TypeError('Draft-save action must not resemble a live-publication action')
  }
  return Object.freeze({
    name: requiredString(options.name ?? 'vinted-authenticated-web-v1', 'profile name'),
    kind: 'vinted',
    origin: VINTED_ORIGIN,
    entryUrl: new URL(VINTED_CREATE_PATH, VINTED_ORIGIN).toString(),
    verificationPathPrefix: VINTED_VERIFICATION_PATH_PREFIX,
    wardrobePathPattern: WARDROBE_PATH_PATTERN,
    draftEditPathPattern: DRAFT_EDIT_PATH_PATTERN,
    wardrobe: WARDROBE,
    delist: DELIST,
    draftEdit: DRAFT_EDIT,
    controls: CONTROLS,
    options: OPTIONS,
    optionPatterns: OPTION_PATTERNS,
    fieldIds: FIELD_IDS,
    authenticity: AUTHENTICITY,
    actions: Object.freeze({
      saveDraft,
      publish: Object.freeze({ testId: VINTED_PUBLISH_TEST_ID, name: VINTED_PUBLISH_NAME }),
    }),
    conditions: VINTED_CONDITIONS,
    limits: Object.freeze({
      // Sell-form page configuration and the 2026-10-03 capture: 1-20 photos, USD 1-9,000. Title
      // and description limits are server-side only (Vinted Pro docs), matched to Fold's registry.
      maxPhotos: 20,
      maxTitleLength: 100,
      maxDescriptionLength: 2000,
      minPrice: 1,
      maxPrice: 9000,
      maxColors: 2,
      maxMaterials: 3,
    }),
  })
}

export function createAuthenticatedVintedTargetProfile(options = {}) {
  return createVintedTargetProfile({ ...options, enableRealVinted: true })
}

/** The seller's member id when `value` is their wardrobe URL, else null. */
export function vintedWardrobeMemberId(value, profile) {
  let url
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.origin !== profile.origin) return null
  return profile.wardrobePathPattern.exec(url.pathname)?.[1] ?? null
}

export function vintedWardrobeUrl(memberId, profile) {
  if (!/^\d+$/.test(String(memberId))) throw new TypeError('A Vinted member id is numeric')
  return new URL(`/member/${memberId}`, profile.origin).toString()
}

/** A saved draft's stable URL: the edit page Vinted's wardrobe links it to. */
export function vintedDraftEditUrl(externalIdentity, profile) {
  if (!/^\d+$/.test(String(externalIdentity))) {
    throw new TypeError('A Vinted draft identity is a numeric item id')
  }
  return new URL(`/items/${externalIdentity}/edit`, profile.origin).toString()
}

/** The item id of a draft edit URL, else null. */
export function vintedDraftIdentity(value, profile) {
  let url
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.origin !== profile.origin) return null
  const match = profile.draftEditPathPattern.exec(url.pathname)
  if (match === null) return null
  return Object.freeze({ external_identity: match[1], canonical_url: vintedDraftEditUrl(match[1], profile) })
}
