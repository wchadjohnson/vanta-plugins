/**
 * The minimal browser driver interface (Layer C) every marketplace browser capability depends on.
 *
 * Layer A is the adapter-facing capability object. Layer B is each marketplace's
 * `browser-capability.mjs`, which implements Layer A. Layer C is this interface: the smallest set of operations any automation tool
 * must supply for Layer B to work. Nothing here names a specific automation tool, and Layer B never
 * reaches past it.
 *
 * Every query matches exactly. Exactness is a determinism guarantee, not a per-call option: a fuzzy
 * or nearest match that lands on a real control is indistinguishable from a correct one once it
 * reaches a browser form, so a driver that cannot match exactly cannot back this adapter.
 *
 * ## Required methods
 *
 * - `locate(query)` resolves a query to a ref. It never throws for a miss; a miss is a ref with no
 *   elements. Each element descriptor carries the semantic `role` the driver observed, the current
 *   `value` of a form control, the `href` of a link, and an opaque `handle` the driver alone reads.
 * - `fill(ref, value)` writes exactly `value` into the single located control.
 * - `click(ref)` activates the single located control when no navigation is expected.
 * - `clickAndWaitForNavigation(ref)` atomically arms navigation observation, activates the single
 *   located control, and waits for the resulting navigation to settle. The operation must refuse
 *   when the host cannot make that ordering guarantee.
 * - `selectOption(ref, value)` picks the option whose label is exactly `value`.
 * - `uploadFiles(ref, paths, options)` delivers exactly `paths`, in order, to the file control the
 *   ref designates. `options.trigger`, when present, is a single-element ref for the visible
 *   control that opens that input's file chooser. It resolves to `{ multiple }` describing whether
 *   that control accepts a batch, and must refuse before delivering anything when `paths` holds
 *   more than one file and it does not.
 * - `readText(ref)` returns the text content of the single located element.
 *
 * ## Optional methods
 *
 * - `pressKey(ref, key)` delivers one keyboard key (e.g. `'Escape'`) at the single located element,
 *   bubbling to the document. Capabilities that need it check for it and refuse without it.
 *
 * A ref is plain data:
 * `{ query, elements: [{ handle, role, name, value, href, group, id, testId, title, alt, checked }] }`,
 * where
 * `name` is the element's accessible name and `group` is the label of the grouping it sits under —
 * an option's group header, for a listbox that scopes the same option label under several headers.
 * `id`, `testId`, `title` and `alt` echo the element's own attributes, so a caller that enumerated
 * a role can still confirm which family of control it matched, or read a label kept only there. `checked` is the live
 * checked state of a checkbox or radio (the `checked` property of a native input, else
 * `aria-checked`), and is left undefined when the element carries neither. Drivers may add fields.
 * Layer B reads refs only through `refCount`, `refElement`, and `refAt`.
 *
 * Timeouts are the driver's own policy, because only the driver knows what its tool can promise.
 * Every operation must eventually settle: a driver that hangs stalls a supervised run with an
 * external write already in flight, which is the one outcome this adapter has no safe answer for.
 */

export const DRIVER_METHODS = Object.freeze([
  'locate',
  'fill',
  'click',
  'clickAndWaitForNavigation',
  'selectOption',
  'uploadFiles',
  'readText',
])

/** Semantic roles Layer B currently queries or validates in descriptors. */
export const DRIVER_ROLES = Object.freeze([
  // `alert` and `status` are read-only roles: the bulk-listing path matches a page notice's exact
  // text under them and never acts on the element it finds.
  'alert',
  'button',
  'checkbox',
  'combobox',
  'file',
  'heading',
  'link',
  'option',
  'radio',
  'spinbutton',
  'status',
  'textbox',
])

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a non-empty string`)
  }
  return value
}

/** Matches a form control by its exact accessible label. */
export function byLabel(label) {
  return Object.freeze({ by: 'label', label: requiredString(label, 'label') })
}

/**
 * Matches an element by its exact semantic role and accessible name. Omitting the name matches every
 * element of that role, which is how a listbox is enumerated when its option labels are not known in
 * advance. Enumerating is not loosening: the caller still compares each reported name exactly and
 * still decides which single match it will act on.
 */
export function byRole(role, name) {
  const query = { by: 'role', role: requiredString(role, 'role') }
  if (name !== undefined) query.name = requiredString(name, 'name')
  return Object.freeze(query)
}

/** Matches an element by its exact test identifier. */
export function byTestId(testId) {
  return Object.freeze({ by: 'testId', testId: requiredString(testId, 'testId') })
}

/**
 * Matches the element whose `id` attribute is exactly this value. For marketplaces that key their
 * option controls by platform id (`#catalog-1773`, `#brand-12`) rather than by an accessible name:
 * an id is as exact as a test identifier, and an absent or duplicated one is still a miss or an
 * ambiguity the caller refuses.
 */
export function byId(id) {
  return Object.freeze({ by: 'id', id: requiredString(id, 'id') })
}

/**
 * Matches elements by CSS selector. Reserved for counting presentational nodes that carry no
 * accessible name, such as uploaded photo previews; never for locating a control to act on.
 */
export function byCss(selector) {
  return Object.freeze({ by: 'css', selector: requiredString(selector, 'selector') })
}

export function requireBrowserDriver(driver, name = 'driver') {
  if (driver === null || typeof driver !== 'object' || Array.isArray(driver)) {
    throw new TypeError(`${name} must be an object`)
  }
  for (const method of DRIVER_METHODS) {
    if (typeof driver[method] !== 'function') {
      throw new TypeError(`${name}.${method} must be a function`)
    }
  }
  return driver
}

function requiredElements(ref) {
  if (ref === null || typeof ref !== 'object' || Array.isArray(ref) || !Array.isArray(ref.elements)) {
    throw new TypeError('Browser driver returned a ref without an elements array')
  }
  return ref.elements
}

/** How many elements the query matched. */
export function refCount(ref) {
  return requiredElements(ref).length
}

/**
 * Narrows a multi-match ref to one of its elements, so an action can be taken on a single element
 * of an enumerated set. Actions always receive a ref holding exactly one element.
 */
export function refAt(ref, index) {
  return { query: ref.query, elements: [refElement(ref, index)] }
}

/** The descriptor for one matched element. */
export function refElement(ref, index = 0) {
  const element = requiredElements(ref)[index]
  if (element === null || typeof element !== 'object' || Array.isArray(element)) {
    throw new TypeError('Browser driver returned a ref element that is not a descriptor')
  }
  return element
}
