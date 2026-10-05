export const DEPOP_PUBLIC_ORIGIN = 'https://www.depop.com'
export const DEPOP_DRAFTS_PATH = '/sellinghub/drafts/'
export const DEPOP_CREATE_PATH = '/products/create/'
export const DEPOP_INCOMPLETE_DRAFTS_PATH = '/sellinghub/drafts/incomplete/'
/**
 * Depop's own bulk-listing page, observed read-only in an owner-supervised session on 2026-09-14.
 * Uploads there land as private drafts: Depop states on the page itself that imported listings
 * "will not automatically be posted".
 */
export const DEPOP_BULK_LISTING_PATH = '/sellinghub/bulklisting/'

/**
 * Depop's live Active/Selling page, where the per-listing "Manage" dropdown (Boost / Discount /
 * Copy / Mark as sold / Delete / Unboost) lives — observed read-only 2026-09-14. It never appears
 * on the Drafts views, so a delist run must land here rather than reusing any draft-view URL.
 */
export const DEPOP_ACTIVE_SELLING_PATH = '/sellinghub/selling/active/'

const DEFAULT_FIELDS = Object.freeze({
  title: Object.freeze({ label: 'Title', role: 'textbox' }),
  description: Object.freeze({ label: 'Description', role: 'textbox' }),
  sku: Object.freeze({ label: 'SKU', role: 'textbox' }),
  price: Object.freeze({ label: 'Price', role: 'textbox' }),
  photos: Object.freeze({ label: 'Photos', role: 'file' }),
  category: Object.freeze({ label: 'Category', role: 'combobox' }),
  condition: Object.freeze({ label: 'Condition', role: 'combobox' }),
  brand: Object.freeze({ label: 'Brand', role: 'combobox' }),
  size: Object.freeze({ label: 'Size', role: 'combobox' }),
  color: Object.freeze({ label: 'Color', role: 'combobox' }),
  material: Object.freeze({ label: 'Material', role: 'combobox' }),
  style: Object.freeze({ label: 'Style', role: 'combobox' }),
  source: Object.freeze({ label: 'Source', role: 'combobox' }),
  age: Object.freeze({ label: 'Age', role: 'combobox' }),
  audience: Object.freeze({ label: 'Audience', role: 'combobox' }),
  shipping: Object.freeze({ label: 'Shipping', role: 'combobox' }),
  // Depop auto-suggests a package size once Category is set. Fold has no data source for it, so the
  // adapter only reads it back to confirm Depop filled it and never selects a value: a wrong
  // package size costs the seller real shipping money.
  packageSize: Object.freeze({ label: 'Package size', role: 'combobox' }),
})

const DEFAULT_ACTIONS = Object.freeze({
  addDraft: Object.freeze({ role: 'button', name: 'Add draft' }),
  saveDraft: Object.freeze({ role: 'button', name: 'Save draft' }),
})

const AUTHENTICATED_DEPOP_ACTIONS = Object.freeze({
  saveDraft: Object.freeze({ role: 'button', name: 'Save as a draft' }),
  updateDraft: Object.freeze({ role: 'button', name: 'Update draft' }),
})

const AUTHENTICATED_DEPOP_FIELDS = Object.freeze({
  title: Object.freeze({ label: 'Description', role: 'composite' }),
  description: Object.freeze({ label: 'Description', role: 'textbox' }),
  sku: Object.freeze({ label: 'SKU', role: 'textbox' }),
  price: Object.freeze({ label: 'Item price', role: 'spinbutton' }),
  photos: Object.freeze({ label: 'Add a photo', role: 'button' }),
})

const SIMULATOR_FIELD_OVERRIDES = Object.freeze({
  price: Object.freeze({ label: 'Price (USD)', role: 'textbox' }),
  brand: Object.freeze({ label: 'Brand', role: 'textbox' }),
  // Size and color draw from Depop's own researched vocabularies, so the simulator renders them as
  // option lists rather than free text. Brand stays free text because Depop's Brand control is an
  // open autocomplete with no fixed vocabulary.
  size: Object.freeze({ label: 'Size', role: 'combobox' }),
  color: Object.freeze({ label: 'Primary color', role: 'combobox' }),
  material: Object.freeze({ label: 'Material', role: 'textbox' }),
  style: Object.freeze({ label: 'Style', role: 'textbox' }),
  source: Object.freeze({ label: 'Source', role: 'textbox' }),
  age: Object.freeze({ label: 'Age', role: 'textbox' }),
  shipping: Object.freeze({ label: 'Shipping', role: 'textbox' }),
})

const LIVE_ACTION_PATTERN = /\b(post|publish|list|make\s+live|ready\s+to\s+post)\b/i

/**
 * The bulk-listing page's observed contract. Inspection locates the trigger only to confirm page
 * identity. Upload activates it inside a driver-controlled file-chooser intercept on Codex, so no
 * operating-system dialog surfaces; Claude-in-Chrome stamps the input directly and never clicks the
 * trigger. The file input beside it carries no name, id or class, so it is addressed by role alone
 * and the surface probe requires exactly one of them.
 *
 * Upload has FOUR mutually exclusive terminal outcomes, and only one of them creates anything:
 * headers-don't-match (nothing imported, no detail), errors-found (nothing imported, per-row
 * per-field detail listed synchronously), platform-error (nothing imported, no detail, and Depop
 * itself invites a retry), and accepted (asynchronous import begins, poll per SKU).
 *
 * Depop therefore DOES surface per-row errors — synchronously and per field — on the errors-found
 * path. An earlier revision of this adapter recorded the opposite, having only ever seen the
 * header-rejection and clean-accept paths. A later revision modelled three states and implicitly
 * assumed that passing field validation meant the import had begun; the platform-error state
 * disproves that.
 */
/**
 * NOT to be confused with **Depop Import**, which is a different Depop product: a one-time tool for
 * migrating a shop from Poshmark, driven by a Poshmark username and US-only. Nothing in Depop
 * Import's documentation applies to this path — not its stated processing times, not its
 * package-size behaviour. The feature automated here is **Bulk listing**, the CSV upload at
 * `/sellinghub/bulklisting/`.
 */
const BULK_LISTING_TRIGGER = Object.freeze({ role: 'button', name: 'Upload file' })

/**
 * Depop's own template guide states a maximum of 100 listings per CSV. Declared here so the
 * workflow refuses an over-long batch before spending an upload on a file the platform will not
 * take whole — and so the number lives with the other target-shape facts rather than in code.
 */
const BULK_LISTING_MAX_LISTINGS = 100
const BULK_LISTING_FILE_INPUT = Object.freeze({ role: 'file' })
const BULK_LISTING_ACCEPT = '.csv'

/**
 * The Active/Selling page's own row shape, captured live 2026-09-14 (Manage dropdown: Manage /
 * Boost / Discount / Copy / Mark as sold / Delete / Unboost) and 2026-09-19 (row/SKU pairing and
 * Delete's own confirmation dialog, against a real account with exactly one active listing — see
 * `delist-capability.mjs`'s module header for what that does and does not cover).
 *
 * Two corrections from the 2026-09-19 pass, both silent-failure risks the earlier guesses carried:
 *
 * - The Manage button's accessible NAME is "Manage listings", not its visible text "Manage" — an
 *   `aria-label` attribute overrides visible text in accessible-name computation, and this button
 *   has one. `byRole('button', 'Manage')` matches nothing on the real page.
 * - Each row's SKU is exposed twice in the DOM (a screen-reader-only span plus a visually-hidden
 *   duplicate with `aria-hidden="true"`, Depop's own accessible-duplicate pattern for the same
 *   text) with the literal text `"SKU: <value>"`, not the bare value — the `"SKU: "` label is
 *   stripped in `findSiblingRow()`, not here, since this selector only locates the node.
 *   `[data-testid="listing-sku"]` does not exist anywhere in the real DOM (0 matches) — it was an
 *   invented placeholder. `[class*="skuText"]` is a CSS Modules class suffix (the build-hashed
 *   prefix before it, e.g. `r33SmW`, is expected to rotate across Depop deploys and is
 *   deliberately excluded from the match) that selects exactly the one non-`aria-hidden` node per
 *   row, observed live.
 *
 * `createDepopDelistCapability.findSiblingRow()` still fails closed
 * (`delist_row_shape_unrecognized`) if the SKU-node and Manage-button counts disagree, so a future
 * markup change here can only ever cause a refusal, never a mis-pairing.
 */
const DELIST_ROW_SKU_SELECTOR = '[class*="skuText"]'
/**
 * Observed live 2026-10-03 after the owner manually deleted SKU FLD-0055: Active page with zero
 * listings shows "There's nothing here yet". Only the TEXT was captured, not the element's exact
 * tag or role, so this selector is deliberately limited to a small set of plain text-bearing
 * elements and `findSiblingRow()` still requires exact text equality on one element. A miss fails
 * closed rather than concluding the page is empty.
 */
const DELIST_EMPTY_STATE = Object.freeze({
  selector: 'h1, h2, h3, h4, h5, h6, p, span',
  text: "There's nothing here yet",
})
/**
 * A sold piece's Depop sibling may still be a draft (Fold creates drafts; the seller may never have
 * posted it). Captured live 2026-10-04 on the drafts tables (read-only except one stale leftover
 * draft, SKU FLD-0053, deleted to capture the flow):
 *
 * - Views `/sellinghub/drafts/incomplete/` and `/sellinghub/drafts/readyToPost/` (directly
 *   navigable; their tab buttons carry aria-labels "Show Incomplete drafts" / "Show Ready-to-post
 *   drafts", used here only as a rendered-page signal and never clicked).
 * - Rows are `tr`; each row's SKU is `span[class*=skuText]` with the bare value ("FLD-0056"; an
 *   empty draft shows "Optional"); each row's checkbox is `tbody input[type=checkbox]` whose id
 *   (and aria-label) is the draft's uuid, matching its `/sellinghub/drafts/edit/{uuid}/` link.
 * - Ticking a row's checkbox shows "1 selected" and enables the toolbar Delete, whose accessible
 *   name is its aria-label "Select one or more drafts to delete". Delete opens
 *   `[role=dialog][aria-label="Are you sure?"]` reading "This draft listing will be permanently
 *   deleted." with Close, Cancel and Confirm; Confirm removes the row and stays on the view.
 * - Never clicked: "Select All" (header checkbox), the toolbar "Edit", and Ready-to-post's "Post".
 */
const DELIST_DRAFTS = Object.freeze({
  views: Object.freeze([
    Object.freeze({ id: 'incomplete', path: '/sellinghub/drafts/incomplete/', tabLabel: 'Show Incomplete drafts' }),
    Object.freeze({ id: 'readyToPost', path: '/sellinghub/drafts/readyToPost/', tabLabel: 'Show Ready-to-post drafts' }),
  ]),
  rowCheckboxSelector: 'tbody input[type="checkbox"]',
  selectionTextSelector: 'span, p, div',
  selectedText: (count) => `${count} selected`,
  deleteAction: Object.freeze({ role: 'button', name: 'Select one or more drafts to delete' }),
  dialog: Object.freeze({ role: 'dialog', name: 'Are you sure?' }),
  dialogText: 'This draft listing will be permanently deleted.',
  confirmAction: Object.freeze({ role: 'button', name: 'Confirm' }),
  neverClick: Object.freeze(['Select All', 'Edit', 'Post']),
})
const DELIST_MANAGE_ACTION = Object.freeze({ role: 'button', name: 'Manage listings' })
const DELIST_DELETE_ACTION = Object.freeze({ role: 'menuitem', name: 'Delete' })
/**
 * Observed live 2026-09-19: Delete's own confirmation is `role="dialog"`, not `alertdialog` — the
 * earlier value was an unverified assumption carried over from a generic "confirmation dialog"
 * expectation, never actually observed. It would have made `confirmDelete()` and
 * `readConfirmationDialog()` report `delist_confirm_dialog_missing` against a real page even
 * though Depop's own dialog was on screen — a real-Delete-blocked-forever bug, not merely an
 * unverified placeholder like the two fields below it.
 */
const DELIST_CONFIRM_DIALOG_ROLE = 'dialog'
/**
 * Depop's own "Are you sure?" wording, captured live 2026-09-19 for Delete specifically: "Are you
 * sure? This will permanently delete your listing." — distinct from Mark as sold's own wording
 * ("Are you sure? This will mark your listing as sold."), confirming the two controls really do
 * produce different dialogs rather than sharing one generic confirmation. The dialog's own Confirm
 * button has no `aria-label` override, so its accessible name is its visible text, "Confirm".
 * The full sequence — Manage listings -> Delete -> this Confirm button — was exercised for real
 * against this account on 2026-09-19 (one listing, SKU FLD-0015, owner-approved as disposable) and
 * genuinely deleted it; Active/Selling showed zero items immediately after, verified with a fresh
 * page load rather than trusting the in-page state alone.
 */
const DELIST_CONFIRM_ACTION = Object.freeze({ role: 'button', name: 'Confirm' })

/**
 * The minimal destructive-intent signature Delete's own dialog text must carry before the confirm
 * control is ever clicked — checked independently of how that control's name was resolved (the
 * known captured name, or a bounded-inference decision when Depop has renamed it). Captured live
 * text was "Are you sure? This will permanently delete your listing." — this checks for the two
 * things that actually matter (an explicit delete action, an explicit permanence/no-undo cue), not
 * that exact sentence, so a minor Depop copy edit does not need a code change to keep working,
 * while a dialog that stopped saying either of these things still refuses regardless of which
 * button an inference decision named.
 */
const DELIST_CONFIRM_CONTENT_PATTERN = Object.freeze({
  action: /delete/i,
  permanence: /permanent|cannot\s+be\s+undone|can'?t\s+be\s+undone|no\s+undo/i,
})

/**
 * Fixed, non-overridable descriptions of what each delist control must actually do — never Depop's
 * current wording for it. These are what a bounded-inference decision is grounded against when the
 * known captured name for a control matches nothing live (see `resolveControlCandidates` in
 * `delist-capability.mjs`): the candidates are always real, currently-observed controls; this text
 * is the only thing that says which one of them is being asked for.
 */
const DELIST_INTENTS = Object.freeze({
  manageAction:
    "The control on one listing row that opens that row's own management menu of actions " +
    '(such as Boost, Discount, Copy, Mark as sold, Delete, Unboost) — never a bulk- or page-level ' +
    'action, and never a control that belongs to a different row.',
  deleteAction:
    "The single menu item, inside that row's own open management menu, that permanently deletes " +
    'the listing — distinct from Mark as sold (which records a sale rather than removing the ' +
    'listing) and from every other item in that same menu.',
  confirmAction:
    "The open confirmation dialog's own destructive action that proceeds with the permanent " +
    'delete — distinct from Cancel or a close control, either of which abandon it instead.',
})

/**
 * The post-upload banner, observed live 2026-09-14 after two real uploads. It is a `role="alert"`
 * element, a sibling of the file input inside `main`:
 *
 *     button [type="file"]
 *     alert
 *       generic "Upload successful! We're creating drafts from your file now..."
 *       generic "We'll send you an email once all your drafts are ready."
 *
 * and, for a rejected file, the same position with a single text child:
 *
 *     alert "CSV headers don't match. Are you using the correct template?"
 *
 * The success alert has TWO text children, so the alert's accessible name is their concatenation.
 * Notice matching is therefore substring-against-each-observed-string, never equality against the
 * whole alert name — equality would silently stop matching the success case. One observed role, two
 * observed texts, no candidate-role guessing.
 *
 * Reading this alert is an expected and required step, but deliberately not fatal: a recognized
 * rejection fails the run fast, while an absent or unrecognized alert degrades to `accepted: null`
 * and lets per-SKU polling decide. "Required" means the alert is expected and waited for, not that
 * a platform redesign should stop a run correlation can still resolve.
 */
const BULK_LISTING_NOTICE_ROLE = 'alert'
const BULK_LISTING_ACCEPTED_TEXT = Object.freeze([
  "Upload successful! We're creating drafts from your file now...",
  "We'll send you an email once all your drafts are ready.",
])
const BULK_LISTING_REJECTED_TEXT = Object.freeze([
  "CSV headers don't match. Are you using the correct template?",
])
const BULK_LISTING_ERRORS_FOUND_TEXT = Object.freeze([
  'We found some errors in your file. Try fixing these and upload your file again.',
])
/**
 * A fourth terminal state, observed 2026-09-14 and reproduced twice on the same file: field
 * validation passed, then Depop failed during processing with no per-row detail at all and created
 * nothing. Isolated empirically — the trigger was photo URLs Depop's own fetcher could not
 * retrieve, and immediately re-uploading a different file on the same account, tab and minute
 * produced the ordinary errors-found banner, so it is neither rate limiting nor a stale session.
 *
 * This is why "passed field validation" and "the import began" are different events, and only the
 * accepted banner indicates the second.
 */
const BULK_LISTING_PLATFORM_ERROR_TEXT = Object.freeze([
  'Something went wrong. Please upload the file again.',
])

/**
 * Per-row, per-field validation errors, observed live 2026-09-14 on an errors-found upload. They
 * are NOT headings — both halves are generic elements inside a list under the same alert:
 *
 *     alert
 *       generic "We found some errors in your file. Try fixing these and upload your file again."
 *       list
 *         listitem
 *           generic "Row 4 - Brand"
 *           generic "\"Carhartt\" could not be found"
 *         listitem
 *           generic "Row 4 - Location"
 *           generic "Can't be empty"
 *
 * One row yields several list items, one per offending field. The label/message split is
 * positional within the list item — first child is the label, second is the message — and is not
 * role-distinguished, so a list item that does not expose exactly two parts is malformed and gets
 * reported unmapped rather than guessed at.
 *
 * These are CSS selectors rather than role queries on purpose. Both halves are generic elements,
 * and the drivers' role mapping does not reach an unroled div: making it do so would either miss
 * them entirely or force enumerating every generic on the page. The selectors below are structural
 * and derived from the observed shape — no build-hashed class names — and they are used only to
 * READ text, never to locate a control to act on.
 */
const BULK_LISTING_ROW_ERROR_ITEM_SELECTOR = '[role="alert"] li'
const BULK_LISTING_ROW_ERROR_PART_SELECTOR = '[role="alert"] li > *'
/** `Row <file line> - <Depop's own field label>`. Field labels pass through verbatim. */
const BULK_LISTING_ROW_ERROR_LABEL = /^Row\s+(\d+)\s+-\s+(.+)$/

/**
 * The placeholder the drafts table renders in place of rows while it fetches. Its text is observed;
 * the element carrying it is **not** — it could not be caught mid-fetch reliably — so these
 * candidate roles are a guess and the loading read stays best-effort.
 *
 * That is tolerable here and nowhere else on this path, because correlation pairs a SKU to a URL by
 * reading the SKU out of the draft itself, never by the draft being new. An undercounted baseline
 * snapshot can therefore only cost extra page-opens; it can never mis-pair a row. Do not "simplify"
 * correlation into a novelty diff — that property is the reason a missed loading state is harmless.
 */
const DRAFT_LIST_LOADING_TEXT = 'Loading…'
const DRAFT_LIST_LOADING_ROLES = Object.freeze(['status', 'alert', 'heading'])

/**
 * Depop's three draft views, each directly URL-addressable. Verified live 2026-09-14 by clicking
 * each toggle and watching the URL, then navigating to each path directly.
 *
 * Note the casing: the Ready-to-post view is camelCase `readyToPost`. An earlier revision recorded
 * these as pure client-side state reachable only by clicking a tab toggle, because a kebab-case
 * `ready-to-post` guess 404s. That was wrong, and the consequence was significant — see below.
 *
 * WHY NAVIGATION RATHER THAN CLICKING THE TOGGLES, which matters enough not to "simplify" back:
 * the toggle for this view is `button "Show Ready-to-post drafts"`, and `isLiveActionName` matches
 * it, because the live-action pattern's word boundary fires on the hyphenated "post" inside the
 * name. Clicking it therefore required punching a byte-exact three-name hole through the
 * live-action guard — on the one page that carries a real `Post` control. Reaching the same view by
 * URL needs no such exception, so the guard has no carve-out at all and this path clicks nothing.
 * `Post` and `Schedule listing` really are present on the Ready-to-post view, so the guard still
 * earns its keep there; the difference is that nothing ever asks to click them.
 */
const DEPOP_DRAFT_VIEWS = Object.freeze([
  Object.freeze({ id: 'incomplete', path: '/sellinghub/drafts/incomplete/' }),
  Object.freeze({ id: 'readyToPost', path: '/sellinghub/drafts/readyToPost/' }),
  Object.freeze({ id: 'scheduled', path: '/sellinghub/drafts/scheduled/' }),
])

/** A Depop draft edit path whose last segment is a real UUID (case-insensitive). */
const DEPOP_DRAFT_EDIT_UUID_PATH =
  /^\/sellinghub\/drafts\/edit\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i

/**
 * Taking a draft live, captured 2026-10-04 on throwaway test drafts (posted, captured, then
 * deleted; live capture 2026-10-04):
 *
 * - The draft edit page `/sellinghub/drafts/edit/{uuid}/` ("Edit Draft - Depop", heading "Draft")
 *   carries `button[type=submit]` "Post" — the one go-live control — plus "Update draft"
 *   (type=button) and "Delete" (data-testid=buttonLink), which is ALSO type=submit. So Post is
 *   matched by its exact name and cross-checked among the submit buttons, never by type alone.
 * - Incomplete draft: Post is blocked by inline validation ("This field is required" under each
 *   missing field); the URL stays on the edit page and no dialog opens.
 * - Complete draft: no confirmation dialog; redirects to `/products/create/success/?productId={n}`
 *   ("Nice! It's listed") with a link "View listing" -> `/products/{slug}/manage/`.
 * - Public URL `/products/{slug}/` (for the owner it redirects to `/products/{slug}/manage/`).
 *   Fold records the normalised `/products/{slug}/`; never `/products/create...` or
 *   `/products/edit/...`.
 * - Active/Selling `/sellinghub/selling/active/` lists the item with `SKU: {sku}` and a link to
 *   `/products/{slug}/manage/` — the SKU fallback, and the live proof.
 * - The draft is consumed once posted (gone from Drafts).
 */
const GO_LIVE = Object.freeze({
  draftPathPattern: DEPOP_DRAFT_EDIT_UUID_PATH,
  draftHeading: Object.freeze({ role: 'heading', name: 'Draft' }),
  postAction: Object.freeze({ role: 'button', name: 'Post' }),
  submitSelector: 'button[type="submit"]',
  neverClick: Object.freeze(['Update draft', 'Delete']),
  successPathPattern: /^\/products\/create\/success\/?$/,
  viewListingLink: Object.freeze({ role: 'link', name: 'View listing' }),
  publicPathPattern: /^\/products\/([^/]+)(?:\/manage)?\/?$/,
  reservedSlugs: Object.freeze(['create', 'edit']),
  activePath: DEPOP_ACTIVE_SELLING_PATH,
  activeRowSkuSelector: DELIST_ROW_SKU_SELECTOR,
  requiredErrorText: 'This field is required',
  requiredErrorSelector: 'p, span, div',
  invalidFieldSelector: '[aria-invalid="true"]',
})

/**
 * Deleting a drafted sibling after a sale or a Delist all, captured 2026-10-04 on throwaway test
 * drafts (live draft-delete capture, 2026-10-04):
 *
 * - On `/sellinghub/drafts/edit/{uuid}/`, `button[data-testid="buttonLink"]` "Delete" (type=submit,
 *   like Post) opens a `role=dialog` "Delete draft" — "Are you sure you want to delete this draft?
 *   You won't be able to recover it." — with Close, Cancel and "Delete draft" (all type=submit).
 *   Confirm is the exact text "Delete draft". It then navigates to the drafts list.
 * - Once deleted, the edit URL shows "There was a problem getting the draft details" — the deleted
 *   marker, and the already-deleted marker on a later run.
 * - Post (go-live) is on the same page; the delete path matches by test id and exact text only and
 *   refuses Post, Update draft, Close and Cancel by name.
 */
const DRAFT_DELETE = Object.freeze({
  draftPathPattern: DEPOP_DRAFT_EDIT_UUID_PATH,
  draftHeading: Object.freeze({ role: 'heading', name: 'Draft' }),
  deleteControl: Object.freeze({ testId: 'buttonLink', name: 'Delete' }),
  dialog: Object.freeze({ role: 'dialog', name: 'Delete draft' }),
  confirmAction: Object.freeze({ role: 'button', name: 'Delete draft' }),
  neverClick: Object.freeze(['Post', 'Update draft', 'Close', 'Cancel']),
  goneText: 'There was a problem getting the draft details',
  goneTextSelector: 'h1, h2, h3, h4, p, span, div',
})

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a non-empty string`)
  }
  return value
}

function normalizedOrigin(value) {
  const url = new URL(requiredString(value, 'target origin'))
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError('Target origin must not include credentials, query parameters, or a hash')
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new TypeError('Target origin must not include a path')
  }
  return url.origin
}

export function isLoopbackOrigin(value) {
  const url = new URL(value)
  return (
    url.protocol === 'http:' &&
    (url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === 'localhost')
  )
}

function normalizedPath(value, name) {
  const path = requiredString(value, name)
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new TypeError(`${name} must be an absolute path`)
  }
  return path
}

function exactLocator(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`)
  }
  return Object.freeze({
    role: requiredString(value.role, `${name}.role`),
    name: requiredString(value.name, `${name}.name`),
  })
}

function exactTextMarker(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`)
  }
  return Object.freeze({
    selector: requiredString(value.selector, `${name}.selector`),
    text: requiredString(value.text, `${name}.text`),
  })
}

function exactField(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`)
  }
  return Object.freeze({
    label: requiredString(value.label, `${name}.label`),
    role: requiredString(value.role, `${name}.role`),
  })
}

function mergedFields(overrides = {}) {
  const fields = {}
  for (const [key, value] of Object.entries(DEFAULT_FIELDS)) {
    fields[key] = exactField(overrides[key] ?? value, `fields.${key}`)
  }
  return Object.freeze(fields)
}

/**
 * Creates an isolated target profile. Automated use is intentionally loopback-only.
 * A real Depop origin requires an explicit future-runtime opt-in and is never enabled by default.
 */
export function createDepopTargetProfile(options = {}) {
  const kind = options.kind ?? 'simulator'
  if (kind !== 'simulator' && kind !== 'depop') {
    throw new TypeError('Target profile kind must be simulator or depop')
  }

  const origin = normalizedOrigin(
    options.origin ?? (kind === 'depop' ? DEPOP_PUBLIC_ORIGIN : 'http://127.0.0.1:4477')
  )
  if (kind === 'simulator' && !isLoopbackOrigin(origin)) {
    throw new TypeError('Simulator target origin must be loopback HTTP')
  }
  if (kind === 'depop') {
    if (origin !== DEPOP_PUBLIC_ORIGIN) {
      throw new TypeError(`Depop target origin must be ${DEPOP_PUBLIC_ORIGIN}`)
    }
    if (options.enableRealDepop !== true) {
      throw new Error('Real Depop targets are disabled until separately authorized and qualified')
    }
  }

  const draftsPath = normalizedPath(
    options.draftsPath ?? (kind === 'depop' ? DEPOP_INCOMPLETE_DRAFTS_PATH : DEPOP_DRAFTS_PATH),
    'draftsPath'
  )
  const entryPath = normalizedPath(
    options.entryPath ?? (kind === 'depop' ? DEPOP_CREATE_PATH : draftsPath),
    'entryPath'
  )
  const draftPathPattern =
    options.draftPathPattern ?? (kind === 'depop'
      ? /^\/sellinghub\/drafts\/edit\/[0-9a-f-]{36}\/?$/i
      : /^\/sellinghub\/drafts\/[A-Za-z0-9_-]+\/?$/)
  if (!(draftPathPattern instanceof RegExp)) {
    throw new TypeError('draftPathPattern must be a RegExp')
  }

  const addDraft = exactLocator(options.actions?.addDraft ?? DEFAULT_ACTIONS.addDraft, 'actions.addDraft')
  const saveDraft = exactLocator(
    options.actions?.saveDraft ?? (kind === 'depop'
      ? AUTHENTICATED_DEPOP_ACTIONS.saveDraft
      : DEFAULT_ACTIONS.saveDraft),
    'actions.saveDraft'
  )
  const updateDraft = kind === 'depop'
    ? exactLocator(
      options.actions?.updateDraft ?? AUTHENTICATED_DEPOP_ACTIONS.updateDraft,
      'actions.updateDraft'
    )
    : undefined
  if (LIVE_ACTION_PATTERN.test(saveDraft.name)) {
    throw new TypeError('Draft-save action must not resemble a live-publication action')
  }

  const maxPhotos = options.maxPhotos ?? 8
  if (!Number.isInteger(maxPhotos) || maxPhotos < 1) {
    throw new TypeError('maxPhotos must be a positive integer')
  }

  const bulkListingOptions = options.bulkListing ?? {}
  const bulkListingPath = normalizedPath(
    bulkListingOptions.path ?? DEPOP_BULK_LISTING_PATH,
    'bulkListing.path'
  )
  const bulkListingTrigger = exactLocator(
    bulkListingOptions.trigger ?? BULK_LISTING_TRIGGER,
    'bulkListing.trigger'
  )
  if (LIVE_ACTION_PATTERN.test(bulkListingTrigger.name)) {
    throw new TypeError('Bulk-import trigger must not resemble a live-publication action')
  }
  const bulkListingFileRole = requiredString(
    bulkListingOptions.fileInput?.role ?? BULK_LISTING_FILE_INPUT.role,
    'bulkListing.fileInput.role'
  )
  const bulkListingDraftsPath = normalizedPath(
    bulkListingOptions.draftsPath ?? DEPOP_DRAFTS_PATH,
    'bulkListing.draftsPath'
  )
  // The entry point redirects, so both spellings count as "already on the drafts surface".
  const bulkListingDraftListPaths = (
    bulkListingOptions.draftListPaths ?? [
      DEPOP_DRAFTS_PATH,
      ...DEPOP_DRAFT_VIEWS.map((view) => view.path),
    ]
  ).map((value, index) => normalizedPath(value, `bulkListing.draftListPaths[${index}]`))
  if (bulkListingDraftListPaths.length === 0) {
    throw new TypeError('bulkListing.draftListPaths must name at least one draft surface')
  }
  const bulkListingDraftViews = (bulkListingOptions.draftViews ?? DEPOP_DRAFT_VIEWS).map(
    (value, index) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`bulkListing.draftViews[${index}] must be an object`)
      }
      return Object.freeze({
        id: requiredString(value.id, `bulkListing.draftViews[${index}].id`),
        path: normalizedPath(value.path, `bulkListing.draftViews[${index}].path`),
        url: new URL(
          normalizedPath(value.path, `bulkListing.draftViews[${index}].path`),
          origin
        ).toString(),
      })
    }
  )
  if (bulkListingDraftViews.length === 0) {
    throw new TypeError('bulkListing.draftViews must name at least one draft view')
  }

  const delistOptions = options.delist ?? {}
  const delistPath = normalizedPath(delistOptions.path ?? DEPOP_ACTIVE_SELLING_PATH, 'delist.path')
  const delistManageAction = exactLocator(
    delistOptions.manageAction ?? DELIST_MANAGE_ACTION,
    'delist.manageAction'
  )
  const delistDeleteAction = exactLocator(
    delistOptions.deleteAction ?? DELIST_DELETE_ACTION,
    'delist.deleteAction'
  )
  const delistEmptyStateSource = Object.hasOwn(delistOptions, 'emptyState')
    ? delistOptions.emptyState
    : DELIST_EMPTY_STATE
  const delistEmptyState = exactTextMarker(
    delistEmptyStateSource,
    'delist.emptyState'
  )
  // The confirm action's `name` accepts an explicit `null` override (DELIST_CONFIRM_ACTION's own
  // default is the real captured "Confirm" — see above) so a test or a future re-verification pass
  // can still model the not-yet-captured state without a real name being coerced into
  // `exactLocator`'s non-empty-string requirement early.
  const delistConfirmActionSource = delistOptions.confirmAction ?? DELIST_CONFIRM_ACTION
  const delistConfirmAction =
    typeof delistConfirmActionSource?.name === 'string' && delistConfirmActionSource.name.trim() !== ''
      ? exactLocator(delistConfirmActionSource, 'delist.confirmAction')
      : Object.freeze({
        role: requiredString(delistConfirmActionSource?.role ?? 'button', 'delist.confirmAction.role'),
        name: null,
      })

  return Object.freeze({
    name: requiredString(
      options.name ?? (kind === 'depop' ? 'depop-qualified' : 'depop-simulator'),
      'profile name'
    ),
    kind,
    origin,
    workflow: kind === 'depop' ? 'authenticated-single-item-v1' : 'simulator-v1',
    draftsPath,
    entryUrl: new URL(entryPath, origin).toString(),
    draftListUrl: new URL(draftsPath, origin).toString(),
    draftPathPattern,
    actions: Object.freeze({ addDraft, saveDraft, ...(updateDraft ? { updateDraft } : {}) }),
    bulkListing: Object.freeze({
      path: bulkListingPath,
      url: new URL(bulkListingPath, origin).toString(),
      // Depop's own input declares accept=".csv" and multiple:false, so one marketplace file per
      // upload is the platform's rule, not a convention this repository chose.
      accept: BULK_LISTING_ACCEPT,
      multiple: false,
      maxListings: BULK_LISTING_MAX_LISTINGS,
      trigger: bulkListingTrigger,
      fileInput: Object.freeze({ role: bulkListingFileRole }),
      // One entry-point URL plus in-page view toggles, because Depop's three draft views are tabs
      // on a single page and the entry point redirects to the Incomplete view.
      draftsUrl: new URL(bulkListingDraftsPath, origin).toString(),
      draftListPaths: Object.freeze([...bulkListingDraftListPaths]),
      draftViews: Object.freeze(bulkListingDraftViews),
      acceptedText: Object.freeze([
        ...(bulkListingOptions.acceptedText ?? BULK_LISTING_ACCEPTED_TEXT),
      ]),
      rejectedText: Object.freeze([
        ...(bulkListingOptions.rejectedText ?? BULK_LISTING_REJECTED_TEXT),
      ]),
      errorsFoundText: Object.freeze([
        ...(bulkListingOptions.errorsFoundText ?? BULK_LISTING_ERRORS_FOUND_TEXT),
      ]),
      platformErrorText: Object.freeze([
        ...(bulkListingOptions.platformErrorText ?? BULK_LISTING_PLATFORM_ERROR_TEXT),
      ]),
      rowErrorItemSelector: requiredString(
        bulkListingOptions.rowErrorItemSelector ?? BULK_LISTING_ROW_ERROR_ITEM_SELECTOR,
        'bulkListing.rowErrorItemSelector'
      ),
      rowErrorPartSelector: requiredString(
        bulkListingOptions.rowErrorPartSelector ?? BULK_LISTING_ROW_ERROR_PART_SELECTOR,
        'bulkListing.rowErrorPartSelector'
      ),
      rowErrorLabel: BULK_LISTING_ROW_ERROR_LABEL,
      // Observed role — the upload confirmation is required, not best-effort.
      noticeRole: requiredString(
        bulkListingOptions.noticeRole ?? BULK_LISTING_NOTICE_ROLE,
        'bulkListing.noticeRole'
      ),
      loadingText: bulkListingOptions.loadingText ?? DRAFT_LIST_LOADING_TEXT,
      // Unobserved element, so still a candidate list and still best-effort.
      loadingRoles: Object.freeze([
        ...(bulkListingOptions.loadingRoles ?? DRAFT_LIST_LOADING_ROLES),
      ]),
    }),
    delist: Object.freeze({
      path: delistPath,
      url: new URL(delistPath, origin).toString(),
      rowSkuSelector: requiredString(
        delistOptions.rowSkuSelector ?? DELIST_ROW_SKU_SELECTOR,
        'delist.rowSkuSelector'
      ),
      manageAction: delistManageAction,
      deleteAction: delistDeleteAction,
      emptyState: delistEmptyState,
      confirmDialogRole: requiredString(
        delistOptions.confirmDialogRole ?? DELIST_CONFIRM_DIALOG_ROLE,
        'delist.confirmDialogRole'
      ),
      // Real captured name by default ("Confirm") — see DELIST_CONFIRM_ACTION. Still overridable
      // to `null` (e.g. in tests) to model an unverified confirm control.
      confirmAction: delistConfirmAction,
      // Fixed regardless of profile overrides — see DELIST_CONFIRM_CONTENT_PATTERN.
      confirmContentPattern: DELIST_CONFIRM_CONTENT_PATTERN,
      // Fixed regardless of profile overrides — see DELIST_INTENTS.
      intents: DELIST_INTENTS,
      // Drafts are searched after Active/Selling on the real site only: the Marketplace Simulator
      // models no drafts tables.
      drafts: Object.freeze({
        ...DELIST_DRAFTS,
        views: Object.freeze(
          (kind === 'depop' ? DELIST_DRAFTS.views : []).map((view) =>
            Object.freeze({ ...view, url: new URL(view.path, origin).toString() })
          )
        ),
      }),
    }),
    // Real Depop only: the simulator models no go-live surface.
    ...(kind === 'depop' ? { goLive: GO_LIVE, draftDelete: DRAFT_DELETE } : {}),
    fields: mergedFields({
      ...(kind === 'depop' ? AUTHENTICATED_DEPOP_FIELDS : {}),
      ...options.fields,
    }),
    limits: Object.freeze({
      // Public Depop help currently conflicts between four and eight images. Eight is
      // therefore an isolated simulator/profile assumption, never an authenticated claim.
      maxPhotos,
      maxHashtags: options.maxHashtags ?? 5,
      maxDescriptionLength: options.maxDescriptionLength ?? 1000,
      maxSkuLength: options.maxSkuLength ?? 50,
    }),
  })
}

/**
 * Current authenticated web profile observed during the owner-supervised qualification run.
 * Real-origin use is always explicit and is never selected by automated tests.
 */
export function createAuthenticatedDepopTargetProfile(options = {}) {
  return createDepopTargetProfile({
    ...options,
    kind: 'depop',
    enableRealDepop: true,
    name: options.name ?? 'depop-authenticated-web-v1',
  })
}

/** Exact loopback surface used for installed-plugin simulator qualification. */
export function createDepopSimulatorTargetProfile(options = {}) {
  return createDepopTargetProfile({
    ...options,
    kind: 'simulator',
    name: options.name ?? 'depop-simulator',
    maxPhotos: options.maxPhotos ?? 4,
    fields: { ...SIMULATOR_FIELD_OVERRIDES, ...options.fields },
  })
}

/**
 * The draft URL Fold recorded, normalised, when it is exactly a Depop draft edit URL: https on the
 * profile's own origin, `/sellinghub/drafts/edit/{uuid}/`, no credentials, query or fragment.
 * Anything else is null, and the go-live capability refuses it before navigating.
 */
export function depopGoLiveDraftUrl(value, profile) {
  return exactDraftUrl(value, profile, profile?.goLive?.draftPathPattern)
}

/** The same exact-shape check for the draft-delete path, against its own profile section. */
export function depopDeleteDraftUrl(value, profile) {
  return exactDraftUrl(value, profile, profile?.draftDelete?.draftPathPattern)
}

function exactDraftUrl(value, profile, pattern) {
  if (typeof value !== 'string' || !(pattern instanceof RegExp)) return null
  let url
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.origin !== profile.origin) return null
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return null
  if (!pattern.test(url.pathname)) return null
  const path = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`
  return new URL(path, profile.origin).toString()
}

/**
 * The normalised public URL `{origin}/products/{slug}/` for a Depop product URL or path
 * (`/products/{slug}/` or the owner's `/products/{slug}/manage/`), else null. Never
 * `/products/create...` or `/products/edit/...`.
 */
export function depopPublicProductUrl(value, profile) {
  if (typeof value !== 'string' || !profile?.goLive) return null
  let url
  try {
    url = new URL(value, profile.origin)
  } catch {
    return null
  }
  if (url.origin !== profile.origin) return null
  const slug = profile.goLive.publicPathPattern.exec(url.pathname)?.[1]
  if (slug === undefined || profile.goLive.reservedSlugs.includes(slug)) return null
  return new URL(`/products/${slug}/`, profile.origin).toString()
}

export function isLiveActionName(value) {
  return typeof value === 'string' && LIVE_ACTION_PATTERN.test(value)
}

/**
 * Depop group headers read `AUDIENCE > SECTION`, so the audience is the segment before the first
 * `>`. Both the browser capability and the adapter's category gate compare against it, so it lives
 * here with the other target-shape facts rather than being duplicated in either of them.
 */
export function depopAudienceOfGroup(groupLabel) {
  if (typeof groupLabel !== 'string') return null
  const audience = groupLabel.split('>')[0].trim()
  if (/^men$/i.test(audience)) return 'MEN'
  if (/^women$/i.test(audience)) return 'WOMEN'
  return audience === '' ? null : audience
}
