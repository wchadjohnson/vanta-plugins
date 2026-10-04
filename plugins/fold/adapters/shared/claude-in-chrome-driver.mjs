import { randomUUID } from 'node:crypto'

import { refElement } from './browser-driver.mjs'
import { withDetail } from './error-detail.mjs'

/**
 * A claude-in-chrome shim for the Layer C driver interface in `browser-driver.mjs`.
 *
 * The browser stays host-owned: the host passes in `callTool(name, args)`, which forwards one
 * claude-in-chrome MCP call and returns its result. Nothing here opens a browser, chooses a tab, or
 * decides that a target is authorized.
 *
 * Element lookup runs through `javascript_tool` rather than `find`. `find` resolves elements from a
 * natural-language description, which is a fuzzy match by construction, and this adapter's whole
 * safety argument rests on exact role/name and label/role matching — a fuzzy match that lands on a
 * real control is indistinguishable from a correct one once it reaches a marketplace form. The page script
 * below therefore does the matching itself and stamps each match with a fresh `data-vanta-ref`
 * token, so every later operation addresses exactly the element that was matched.
 *
 * Every value that crosses into page source is embedded with JSON.stringify. Listing text is
 * seller-authored and must never be able to close a string literal and become script.
 */

const NAVIGATION_TIMEOUT_MS = 30000
const NAVIGATION_POLL_MS = 200
const REF_ATTRIBUTE = 'data-vanta-ref'
const UPLOAD_ATTRIBUTE = 'data-vanta-upload'

function driverError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function requiredFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`)
  return value
}

function requiredTabId(value) {
  if (!Number.isInteger(value)) throw new TypeError('tabId must be an integer')
  return value
}

/**
 * claude-in-chrome results reach the shim either as the tool's raw value or wrapped in MCP content
 * blocks, depending on how the host forwards them. Both shapes collapse to the same text here.
 */
function resultText(result) {
  if (typeof result === 'string') return result
  if (Array.isArray(result?.content)) {
    return result.content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('')
  }
  if (typeof result?.text === 'string') return result.text
  return typeof result === 'object' && result !== null ? JSON.stringify(result) : String(result ?? '')
}

/** A JS source fragment that resolves to the page-side selector for one stamped element. */
function stampedSelector(attribute, token) {
  return `'[${attribute}=' + ${JSON.stringify(JSON.stringify(token))} + ']'`
}

/** The page-side matcher, evaluated once per locate. Returns a JSON string. */
function locateScript(query, token) {
  return `(() => {
  const query = ${JSON.stringify(query)}
  const token = ${JSON.stringify(token)}
  const text = (node) => (node?.textContent ?? '').replace(/\\s+/g, ' ').trim()
  const roleOf = (node) => {
    const explicit = node.getAttribute('role')
    if (explicit) return explicit
    const tag = node.tagName.toLowerCase()
    const type = (node.getAttribute('type') ?? '').toLowerCase()
    if (tag === 'select') return 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'option') return 'option'
    if (tag === 'a') return node.hasAttribute('href') ? 'link' : ''
    if (tag === 'button') return 'button'
    if (/^h[1-6]$/.test(tag)) return 'heading'
    if (tag === 'input') {
      if (type === 'file') return 'file'
      if (type === 'number') return 'spinbutton'
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button'
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      return 'textbox'
    }
    return ''
  }
  const labelledBy = (node) => {
    const ids = (node.getAttribute('aria-labelledby') ?? '').split(/\\s+/).filter(Boolean)
    if (ids.length === 0) return null
    return ids.map((id) => text(document.getElementById(id))).join(' ').trim()
  }
  const labelOf = (node) => {
    const aria = node.getAttribute('aria-label')
    if (aria !== null) return aria.trim()
    const referenced = labelledBy(node)
    if (referenced !== null) return referenced
    const wrapping = node.closest('label')
    if (wrapping) return text(wrapping)
    const id = node.getAttribute('id')
    if (id) {
      const external = document.querySelector('label[for=' + JSON.stringify(id) + ']')
      if (external) return text(external)
    }
    return null
  }
  const nameOf = (node) => {
    const aria = node.getAttribute('aria-label')
    if (aria !== null) return aria.trim()
    const referenced = labelledBy(node)
    if (referenced !== null) return referenced
    const label = labelOf(node)
    if (label !== null) return label
    return text(node)
  }

  const groupOf = (node) => {
    const group = node.closest('[role=group],[role=listbox] > [role=presentation],optgroup')
    if (group) {
      if (group.tagName.toLowerCase() === 'optgroup') return group.label ?? null
      const aria = group.getAttribute('aria-label')
      if (aria !== null) return aria.trim()
      const referenced = labelledBy(group)
      if (referenced !== null) return referenced
      const heading = group.querySelector('[role=presentation],h1,h2,h3,h4,h5,h6,header')
      if (heading && !heading.contains(node)) return text(heading)
    }
    return null
  }

  const checkedOf = (node) => {
    const tag = node.tagName.toLowerCase()
    const type = (node.getAttribute('type') ?? '').toLowerCase()
    if (tag === 'input' && (type === 'checkbox' || type === 'radio')) return node.checked === true
    const aria = node.getAttribute('aria-checked')
    if (aria === 'true') return true
    if (aria === 'false') return false
    return undefined
  }

  let matches
  if (query.by === 'css') {
    matches = Array.from(document.querySelectorAll(query.selector))
  } else if (query.by === 'id') {
    matches = Array.from(document.querySelectorAll('[id=' + JSON.stringify(query.id) + ']'))
  } else if (query.by === 'testId') {
    matches = Array.from(document.querySelectorAll('[data-testid=' + JSON.stringify(query.testId) + ']'))
  } else {
    const all = Array.from(document.querySelectorAll('*'))
    if (query.by === 'label') {
      matches = all.filter((node) => roleOf(node) !== '' && labelOf(node) === query.label)
    } else {
      matches = all.filter((node) => roleOf(node) === query.role &&
        (query.name === undefined || nameOf(node) === query.name))
    }
  }

  return JSON.stringify(matches.map((node, index) => {
    const handle = token + ':' + index
    node.setAttribute('${REF_ATTRIBUTE}', handle)
    return {
      handle,
      role: roleOf(node),
      name: nameOf(node),
      group: groupOf(node) ?? undefined,
      value: typeof node.value === 'string' ? node.value : undefined,
      href: node.getAttribute('href') ?? undefined,
      id: node.getAttribute('id') ?? undefined,
      testId: node.getAttribute('data-testid') ?? undefined,
      title: node.getAttribute('title') ?? undefined,
      alt: node.getAttribute('alt') ?? undefined,
      checked: checkedOf(node),
    }
  }))
})()`
}

function elementScript(handle, body) {
  return `(() => {
  const element = document.querySelector(${stampedSelector(REF_ATTRIBUTE, handle)})
  if (element === null) return JSON.stringify({ error: 'element_detached' })
  ${body}
})()`
}

/**
 * React and other controlled-input frameworks track the last value they wrote on the DOM node. A
 * plain assignment leaves that tracker stale and the framework discards the change on its next
 * render, so the native setter is invoked directly and the tracker is cleared first.
 */
const NATIVE_SET = `
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (element._valueTracker) element._valueTracker.setValue('')
  if (setter) setter.call(element, next)
  else element.value = next
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
`

/**
 * Serializes every MCP call this shim makes against one tab. The atomic navigation operation stamps
 * the current document before clicking; FIFO ordering keeps those two steps adjacent.
 */
function createTabChannel({ callTool, tabId }) {
  let tail = Promise.resolve()

  function call(name, args) {
    const queued = tail.then(() => callTool(name, { tabId, ...args }))
    tail = queued.then(
      () => undefined,
      () => undefined
    )
    return queued
  }

  async function evaluate(script) {
    const text = resultText(
      await call('javascript_tool', { action: 'javascript_exec', text: script })
    ).trim()
    try {
      const parsed = JSON.parse(text)
      return typeof parsed === 'string' ? JSON.parse(parsed) : parsed
    } catch {
      throw driverError('browser_script_result_invalid', 'Page script did not return readable JSON')
    }
  }

  return { call, evaluate }
}

export function createClaudeInChromeDriver(options = {}) {
  const callTool = requiredFunction(options.callTool, 'callTool')
  const tabId = requiredTabId(options.tabId)
  const navigationTimeoutMs = options.navigationTimeoutMs ?? NAVIGATION_TIMEOUT_MS
  const { call, evaluate } = options.channel ?? createTabChannel({ callTool, tabId })

  async function actOnElement(ref, body, code, message) {
    const handle = refElement(ref).handle
    if (typeof handle !== 'string' || handle === '') {
      throw driverError('browser_ref_invalid', 'Located element carries no usable handle')
    }
    const outcome = await evaluate(elementScript(handle, body))
    if (outcome?.error !== undefined) throw driverError(code, message)
    return outcome
  }

  async function clickElement(ref) {
    await actOnElement(
      ref,
      `element.scrollIntoView({ block: 'center' })
      element.click()
      return JSON.stringify({ clicked: true })`,
      'browser_click_failed',
      'Located control was no longer present when activating it'
    )
  }

  return Object.freeze({
    async locate(query) {
      const elements = await evaluate(locateScript(query, randomUUID()))
      if (!Array.isArray(elements)) {
        throw driverError('browser_locate_failed', 'Page script did not return a match list')
      }
      return { query, elements }
    },

    async fill(ref, value) {
      await actOnElement(
        ref,
        `const next = ${JSON.stringify(String(value))}
      ${NATIVE_SET}
      return JSON.stringify({ value: element.value })`,
        'browser_fill_failed',
        'Located field was no longer present when writing its value'
      )
    },

    async click(ref) {
      await clickElement(ref)
    },

    /**
     * claude-in-chrome exposes no navigation event, so the current document is stamped before the
     * click. A navigation is settled once the stamp is gone and the new document has finished
     * loading, or once the address changed for a same-document route.
     */
    async clickAndWaitForNavigation(ref) {
      const token = randomUUID()
      const { href } = await evaluate(`(() => {
  window.__vantaNavigation = ${JSON.stringify(token)}
  return JSON.stringify({ href: window.location.href })
})()`)
      await clickElement(ref)
      const deadline = Date.now() + navigationTimeoutMs
      for (;;) {
        const state = await evaluate(`(() => JSON.stringify({
  href: window.location.href,
  stamped: window.__vantaNavigation === ${JSON.stringify(token)},
  ready: document.readyState,
}))()`)
        if (state.href !== href) return
        if (!state.stamped && state.ready === 'complete') return
        if (Date.now() >= deadline) {
          throw driverError('browser_navigation_timeout', 'Navigation did not settle')
        }
        await new Promise((resolve) => setTimeout(resolve, NAVIGATION_POLL_MS))
      }
    },

    async selectOption(ref, value) {
      const outcome = await actOnElement(
        ref,
        `const wanted = ${JSON.stringify(String(value))}
      const options = Array.from(element.options ?? [])
      const matched = options.filter((option) => option.label === wanted || option.text.trim() === wanted)
      if (matched.length !== 1) return JSON.stringify({ matched: matched.length })
      const next = matched[0].value
      ${NATIVE_SET}
      return JSON.stringify({ matched: 1, value: element.value })`,
        'browser_select_failed',
        'Located combobox was no longer present when selecting its option'
      )
      if (outcome.matched !== 1) {
        throw driverError(
          'browser_option_ambiguous',
          'Combobox does not expose one exact qualified option'
        )
      }
    },

    async inspectFileUpload(ref) {
      const result = await actOnElement(
        ref,
        `const inputs = element.matches('input[type=file]')
        ? [element]
        : Array.from(element.querySelectorAll('input[type=file]'))
      if (inputs.length === 0) {
        inputs.push(...Array.from(element.closest('form')?.querySelectorAll('input[type=file]') ?? []))
      }
      return JSON.stringify({
        present: inputs.length === 1,
        multiple: inputs.length === 1 && inputs[0].multiple === true,
      })`,
        'browser_file_upload_unsupported',
        'Photo control could not be inspected safely'
      )
      return { present: result.present === true, multiple: result.multiple === true }
    },

    /**
     * `file_upload` needs an element reference minted by `find` or `read_page`, so the file input is
     * first pinned exactly in page script and stamped, then handed to `find` only to mint that
     * reference. `options.trigger` is accepted for Layer C compatibility and ignored: this driver
     * never clicks the trigger. The upload is confirmed afterwards by reading the input's own file
     * list, so a reference that resolved to some other element cannot pass as a successful upload.
     */
    async uploadFiles(ref, paths, options) {
      const token = randomUUID()
      const target = await actOnElement(
        ref,
        `const token = ${JSON.stringify(token)}
      const inputs = element.matches('input[type=file]')
        ? [element]
        : Array.from(element.querySelectorAll('input[type=file]'))
      if (inputs.length === 0) {
        inputs.push(...Array.from(element.closest('form')?.querySelectorAll('input[type=file]') ?? []))
      }
      if (inputs.length !== 1) return JSON.stringify({ error: 'file_input_not_exact' })
      const input = inputs[0]
      input.setAttribute('${UPLOAD_ATTRIBUTE}', token)
      return JSON.stringify({ multiple: input.multiple === true })`,
        'browser_photo_input_missing',
        'No file input is reachable from the located photo control'
      )
      if (paths.length > 1 && target.multiple !== true) {
        throw driverError('browser_photo_input_not_multiple', 'Photo input does not accept a batch')
      }

      const found = resultText(
        await call('find', {
          query: `file input whose ${UPLOAD_ATTRIBUTE} attribute is ${token}`,
        })
      )
      const references = [...new Set(found.match(/\bref_\d+\b/g) ?? [])]
      if (references.length !== 1) {
        throw driverError(
          'browser_photo_input_ambiguous',
          'The stamped photo input did not resolve to exactly one element reference'
        )
      }
      await call('file_upload', { ref: references[0], paths })

      const delivered = await evaluate(`(() => {
  const input = document.querySelector(${stampedSelector(UPLOAD_ATTRIBUTE, token)})
  if (input === null) return JSON.stringify({ names: null })
  return JSON.stringify({ names: Array.from(input.files ?? []).map((file) => file.name) })
})()`)
      const expected = paths.map((filePath) => filePath.split('/').at(-1))
      if (
        !Array.isArray(delivered.names) ||
        delivered.names.length !== expected.length ||
        delivered.names.some((name, index) => name !== expected[index])
      ) {
        throw driverError(
          'browser_photo_upload_incomplete',
          'The photo input did not receive the prepared file set in order'
        )
      }
      return { multiple: target.multiple === true }
    },

    /** Dispatches keydown then keyup at the element; both bubble to the document. */
    async pressKey(ref, key) {
      await actOnElement(
        ref,
        `const key = ${JSON.stringify(String(key))}
      const init = { key, code: key, keyCode: key === 'Escape' ? 27 : 0, which: key === 'Escape' ? 27 : 0, bubbles: true, cancelable: true }
      element.dispatchEvent(new KeyboardEvent('keydown', init))
      element.dispatchEvent(new KeyboardEvent('keyup', init))
      return JSON.stringify({ pressed: true })`,
        'browser_key_press_failed',
        'Located element was no longer present when pressing a key'
      )
    },

    async readText(ref) {
      const outcome = await actOnElement(
        ref,
        `return JSON.stringify({ text: element.textContent })`,
        'browser_read_text_failed',
        'Located element was no longer present when reading its text'
      )
      return outcome.text
    },
  })
}

/**
 * Wraps a host-selected claude-in-chrome tab as the `tab` every marketplace browser capability
 * expects. The host chooses the tab and is responsible for it already being an authorized target.
 */
export function createClaudeInChromeTab(options = {}) {
  const callTool = requiredFunction(options.callTool, 'callTool')
  const tabId = requiredTabId(options.tabId)
  const channel = createTabChannel({ callTool, tabId })

  return Object.freeze({
    driver: createClaudeInChromeDriver({ ...options, channel }),
    async goto(url) {
      try {
        await channel.call('navigate', { url })
      } catch (error) {
        throw driverError(
          'browser_navigation_failed',
          withDetail('The host tab could not open the page', error)
        )
      }
    },
    async url() {
      const state = await channel.evaluate(
        '(() => JSON.stringify({ href: window.location.href }))()'
      )
      return state.href
    },
  })
}
