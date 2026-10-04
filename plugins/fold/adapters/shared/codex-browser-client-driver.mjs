import { DRIVER_METHODS, refCount, refElement } from './browser-driver.mjs'
import { withDetail } from './error-detail.mjs'

const NAVIGATION_TIMEOUT_MS = 30000
const ACTION_TIMEOUT_MS = 30000

function driverError(code, message, cause) {
  const error = new Error(cause === undefined ? message : withDetail(message, cause))
  error.code = code
  return error
}

function requiredObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`)
  }
  return value
}

function requiredFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`)
  return value
}

function requiredPositiveTimeout(value, name) {
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer`)
  return value
}

function locatorFor(playwright, query) {
  if (query?.by === 'label') return playwright.getByLabel(query.label, { exact: true })
  if (query?.by === 'role') {
    if (query.role === 'file') {
      return query.name === undefined
        ? playwright.locator('input[type="file"]')
        : playwright.getByLabel(query.name, { exact: true })
    }
    return query.name === undefined
      ? playwright.getByRole(query.role)
      : playwright.getByRole(query.role, { name: query.name, exact: true })
  }
  if (query?.by === 'testId') return playwright.getByTestId(query.testId)
  if (query?.by === 'id') return playwright.locator(`[id="${attributeSelectorValue(query.id)}"]`)
  if (query?.by === 'css') return playwright.locator(query.selector)
  throw driverError('browser_query_unsupported', 'Browser query type is unsupported')
}

/**
 * Reads the small semantic descriptor Layer B needs from one already-exact Codex locator.
 * Evaluation is deliberately read-only: it never assigns a property, dispatches an event, stamps
 * the DOM, or calls a page-owned function.
 */
async function evaluatedLocatorDescription(locator) {
  return locator.evaluate((node) => {
    const text = (value) => (value?.textContent ?? '').replace(/\s+/g, ' ').trim()
    const labelledBy = (value) => {
      const ids = (value.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean)
      if (ids.length === 0) return null
      return ids.map((id) => text(value.ownerDocument.getElementById(id))).join(' ').trim()
    }
    const labelOf = (value) => {
      const aria = value.getAttribute('aria-label')
      if (aria !== null) return aria.trim()
      const referenced = labelledBy(value)
      if (referenced !== null) return referenced
      if (value.labels?.length) return Array.from(value.labels).map(text).join(' ').trim()
      const wrapping = value.closest('label')
      return wrapping === null ? null : text(wrapping)
    }
    const roleOf = (value) => {
      const explicit = value.getAttribute('role')
      if (explicit) return explicit
      const tag = value.tagName.toLowerCase()
      const type = (value.getAttribute('type') ?? '').toLowerCase()
      if (tag === 'select') return 'combobox'
      if (tag === 'textarea') return 'textbox'
      if (tag === 'option') return 'option'
      if (tag === 'a') return value.hasAttribute('href') ? 'link' : ''
      if (tag === 'button') return 'button'
      if (/^h[1-6]$/.test(tag)) return 'heading'
      if (tag !== 'input') return ''
      if (type === 'file') return 'file'
      if (type === 'number') return 'spinbutton'
      if (['submit', 'button', 'reset'].includes(type)) return 'button'
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      return 'textbox'
    }
    const nameOf = (value) => labelOf(value) ?? text(value)
    const checkedOf = (value) => {
      const tag = value.tagName.toLowerCase()
      const type = (value.getAttribute('type') ?? '').toLowerCase()
      if (tag === 'input' && (type === 'checkbox' || type === 'radio')) return value.checked === true
      const aria = value.getAttribute('aria-checked')
      if (aria === 'true') return true
      if (aria === 'false') return false
      return undefined
    }
    const groupOf = (value) => {
      const group = value.closest('[role=group],[role=listbox] > [role=presentation],optgroup')
      if (group !== null) {
        if (group.tagName.toLowerCase() === 'optgroup') return group.label ?? undefined
        const aria = group.getAttribute('aria-label')
        if (aria !== null) return aria.trim()
        const referenced = labelledBy(group)
        if (referenced !== null) return referenced
        const heading = group.querySelector('[role=presentation],h1,h2,h3,h4,h5,h6,header')
        if (heading !== null && !heading.contains(value)) return text(heading)
      }
      const sibling = value.previousElementSibling
      const parent = value.parentElement
      if (
        sibling !== null &&
        parent?.children.length === 2 &&
        parent.parentElement?.getAttribute('role') === 'listbox'
      ) {
        const label = text(sibling)
        if (label !== '') return label
      }
      return undefined
    }
    return {
      role: roleOf(node),
      name: nameOf(node),
      group: groupOf(node),
      value: typeof node.value === 'string' ? node.value : undefined,
      href: node.getAttribute('href') ?? undefined,
      id: node.getAttribute('id') ?? undefined,
      testId: node.getAttribute('data-testid') ?? undefined,
      title: node.getAttribute('title') ?? undefined,
      alt: node.getAttribute('alt') ?? undefined,
      checked: checkedOf(node),
    }
  })
}

async function safeAttribute(locator, name, timeoutMs) {
  try {
    return await locator.getAttribute(name, { timeoutMs })
  } catch {
    return null
  }
}

function attributeSelectorValue(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

async function optionGroup(playwright, locator, optionText, timeoutMs) {
  const id = await safeAttribute(locator, 'id', timeoutMs)
  if (typeof id !== 'string' || id === '') return undefined
  const wrapper = playwright.locator(
    `[role="listbox"] > *:has(> [id="${attributeSelectorValue(id)}"])`
  )
  if ((await wrapper.count()) !== 1) return undefined
  const wrapperText = ((await wrapper.textContent({ timeoutMs })) ?? '').replace(/\s+/g, ' ').trim()
  if (wrapperText === '' || optionText === '' || !wrapperText.endsWith(optionText)) return undefined
  const group = wrapperText.slice(0, -optionText.length).trim()
  return group === '' ? undefined : group
}

/**
 * Browser-client page evaluation is not guaranteed on extension-owned Chrome tabs. Prefer the
 * locator's supported read primitives for role and CSS queries, which are also faster and avoid a
 * fixed evaluate timeout. The evaluated fallback keeps compatibility with older injected test and
 * simulator locators that expose only the original narrow surface.
 */
async function describeLocator(playwright, locator, query, timeoutMs) {
  const supportsDirectReads =
    typeof locator.textContent === 'function' && typeof locator.getAttribute === 'function'
  if (!supportsDirectReads || !['role', 'css', 'id', 'testId'].includes(query?.by)) {
    return evaluatedLocatorDescription(locator)
  }

  const text = ((await locator.textContent({ timeoutMs })) ?? '').replace(/\s+/g, ' ').trim()
  const ariaLabel = await safeAttribute(locator, 'aria-label', timeoutMs)
  const explicitRole = await safeAttribute(locator, 'role', timeoutMs)
  const valueAttribute = await safeAttribute(locator, 'value', timeoutMs)
  const href = await safeAttribute(locator, 'href', timeoutMs)
  const id = await safeAttribute(locator, 'id', timeoutMs)
  const testId = await safeAttribute(locator, 'data-testid', timeoutMs)
  const title = await safeAttribute(locator, 'title', timeoutMs)
  const alt = await safeAttribute(locator, 'alt', timeoutMs)
  const role = query.by === 'role' ? query.role : (explicitRole ?? '')
  // Id and test-id queries reach native inputs whose live value and checked state the attributes
  // do not track, so those two read the live properties when the locator offers them.
  const exactNode = query.by === 'id' || query.by === 'testId'
  return {
    role,
    name: query.name ?? ariaLabel ?? text,
    group: role === 'option' ? await optionGroup(playwright, locator, text, timeoutMs) : undefined,
    value: (exactNode ? await liveValue(locator, timeoutMs) : undefined) ?? valueAttribute ?? undefined,
    href: href ?? undefined,
    id: id ?? undefined,
    testId: testId ?? undefined,
    title: title ?? undefined,
    alt: alt ?? undefined,
    checked: await checkedState(
      locator,
      exactNode || role === 'checkbox' || role === 'radio',
      timeoutMs
    ),
  }
}

/**
 * Codex's documented locator has no `inputValue()` or `isChecked()`; its read-only `evaluate` is the
 * supported way to read a live property. Either Playwright-style method is still used when present.
 */
async function liveValue(locator, timeoutMs) {
  try {
    if (typeof locator.inputValue === 'function') return await locator.inputValue({ timeoutMs })
    if (typeof locator.evaluate === 'function') {
      const value = await locator.evaluate(
        (node) => (typeof node.value === 'string' ? node.value : null),
        undefined,
        { timeoutMs }
      )
      return value ?? undefined
    }
  } catch {}
  return undefined
}

async function checkedState(locator, checkable, timeoutMs) {
  if (checkable) {
    try {
      if (typeof locator.isChecked === 'function') return (await locator.isChecked({ timeoutMs })) === true
      if (typeof locator.evaluate === 'function') {
        const checked = await locator.evaluate(
          (node) => {
            const type = (node.getAttribute('type') ?? '').toLowerCase()
            if (node.tagName.toLowerCase() === 'input' && (type === 'checkbox' || type === 'radio')) {
              return node.checked === true
            }
            const aria = node.getAttribute('aria-checked')
            return aria === 'true' ? true : aria === 'false' ? false : null
          },
          undefined,
          { timeoutMs }
        )
        if (typeof checked === 'boolean') return checked
      }
    } catch {}
  }
  const aria = await safeAttribute(locator, 'aria-checked', timeoutMs)
  if (aria === 'true') return true
  if (aria === 'false') return false
  return undefined
}

/**
 * Describes every match of an id, test-id, or checkbox/radio query in ONE read-only `evaluateAll`
 * call instead of several attribute reads per element — the difference between a form fitting in a
 * host's per-call time budget or not. Field for field it matches the direct-read path below.
 */
function describeAllInPage(nodes, query) {
  return nodes.map((node) => {
    const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim()
    const type = (node.getAttribute('type') ?? '').toLowerCase()
    const checkable = node.tagName.toLowerCase() === 'input' && (type === 'checkbox' || type === 'radio')
    const aria = node.getAttribute('aria-checked')
    return {
      role: query.by === 'role' ? query.role : (node.getAttribute('role') ?? ''),
      name: query.name ?? node.getAttribute('aria-label') ?? text,
      value: typeof node.value === 'string' ? node.value : (node.getAttribute('value') ?? undefined),
      href: node.getAttribute('href') ?? undefined,
      id: node.getAttribute('id') ?? undefined,
      testId: node.getAttribute('data-testid') ?? undefined,
      title: node.getAttribute('title') ?? undefined,
      alt: node.getAttribute('alt') ?? undefined,
      checked: checkable ? node.checked === true : aria === 'true' ? true : aria === 'false' ? false : undefined,
    }
  })
}

function batchDescribable(query) {
  return (
    query?.by === 'id' ||
    query?.by === 'css' ||
    query?.by === 'testId' ||
    (query?.by === 'role' && (query.role === 'checkbox' || query.role === 'radio'))
  )
}

function locatorHandle(ref) {
  const handle = refElement(ref).handle
  if (handle === null || typeof handle !== 'object') {
    throw driverError('browser_ref_invalid', 'Located element carries no usable Codex locator')
  }
  return handle
}

function uploadOptions(options) {
  if (options === undefined) return {}
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options must be an object')
  }
  const { trigger } = options
  if (trigger !== undefined && refCount(trigger) !== 1) {
    throw new TypeError('options.trigger must be a ref with exactly one element')
  }
  return { trigger }
}

function settleEvent(promise) {
  return promise.then(
    (value) => ({ value }),
    (error) => ({ error })
  )
}

/** Maps one host-selected Codex browser-client tab to the Layer C browser driver contract. */
export function createCodexBrowserClientDriver(options = {}) {
  const tab = requiredObject(options.tab, 'tab')
  const playwright = requiredObject(tab.playwright, 'tab.playwright')
  for (const method of [
    'getByLabel',
    'getByRole',
    'getByTestId',
    'locator',
    'expectNavigation',
    'waitForEvent',
  ]) {
    requiredFunction(playwright[method], `tab.playwright.${method}`)
  }
  const navigationTimeoutMs = requiredPositiveTimeout(
    options.navigationTimeoutMs ?? NAVIGATION_TIMEOUT_MS,
    'navigationTimeoutMs'
  )
  const actionTimeoutMs = requiredPositiveTimeout(
    options.actionTimeoutMs ?? ACTION_TIMEOUT_MS,
    'actionTimeoutMs'
  )

  let batchReadsUnsupported = false

  return Object.freeze({
    async locate(query) {
      let locator
      try {
        locator = locatorFor(playwright, query)
        requiredFunction(locator.count, 'locator.count')
        requiredFunction(locator.nth, 'locator.nth')
        if (batchDescribable(query) && !batchReadsUnsupported && typeof locator.evaluateAll === 'function') {
          try {
            const described = await locator.evaluateAll(describeAllInPage, query, { timeoutMs: actionTimeoutMs })
            if (Array.isArray(described)) {
              return {
                query,
                elements: described.map((element, index) => ({ handle: locator.nth(index), ...element })),
              }
            }
          } catch {}
          // A host that cannot evaluate in page keeps the per-element reads for the rest of the run.
          batchReadsUnsupported = true
        }
        const count = await locator.count()
        const elements = []
        for (let index = 0; index < count; index += 1) {
          const handle = locator.nth(index)
          elements.push({
            handle,
            ...(await describeLocator(playwright, handle, query, actionTimeoutMs)),
          })
        }
        return { query, elements }
      } catch (error) {
        if (error?.code === 'browser_query_unsupported') throw error
        throw driverError('browser_locate_failed', 'Codex browser locator could not be read', error)
      }
    },

    async fill(ref, value) {
      try {
        await locatorHandle(ref).fill(String(value), { timeoutMs: actionTimeoutMs })
      } catch (error) {
        throw driverError('browser_fill_failed', 'Located field could not be filled', error)
      }
    },

    async click(ref) {
      try {
        await locatorHandle(ref).click({ timeoutMs: actionTimeoutMs })
      } catch (error) {
        throw driverError('browser_click_failed', 'Located control could not be activated', error)
      }
    },

    async clickAndWaitForNavigation(ref) {
      let clickFailed = false
      try {
        await playwright.expectNavigation(
          async () => {
            try {
              await locatorHandle(ref).click({ timeoutMs: actionTimeoutMs })
            } catch (error) {
              clickFailed = true
              throw error
            }
          },
          { timeoutMs: navigationTimeoutMs, waitUntil: 'domcontentloaded' }
        )
      } catch (error) {
        if (clickFailed) {
          throw driverError('browser_click_failed', 'Located control could not be activated')
        }
        throw driverError(
          'browser_navigation_timeout',
          'Navigation-triggering control did not settle',
          error
        )
      }
    },

    async selectOption(ref, value) {
      const handle = locatorHandle(ref)
      const wanted = String(value)
      try {
        const matches = await handle.evaluate(
          (element, exactLabel) => Array.from(element.options ?? []).filter(
            (option) =>
              !option.disabled &&
              !option.hidden &&
              option.closest('optgroup')?.disabled !== true &&
              (option.label === exactLabel || option.text.trim() === exactLabel)
          ).length,
          wanted
        )
        if (matches !== 1) {
          throw driverError(
            'browser_option_ambiguous',
            'Combobox does not expose one exact qualified option'
          )
        }
        await handle.selectOption(
          { label: wanted },
          { timeoutMs: actionTimeoutMs }
        )
      } catch (error) {
        if (error?.code === 'browser_option_ambiguous') throw error
        throw driverError(
          'browser_option_ambiguous',
          'Combobox does not expose one exact qualified option'
        )
      }
    },

    async inspectFileUpload(ref) {
      try {
        const direct = playwright.locator('main form input[type="file"]')
        if (
          typeof direct?.count === 'function' &&
          typeof direct?.nth === 'function' &&
          typeof direct.nth(0)?.getAttribute === 'function'
        ) {
          const count = await direct.count()
          return {
            present: count === 1,
            multiple:
              count === 1 &&
              (await direct.nth(0).getAttribute('multiple', { timeoutMs: actionTimeoutMs })) !== null,
          }
        }
        const result = await locatorHandle(ref).evaluate((element) => {
          const inputs = element.matches('input[type=file]')
            ? [element]
            : Array.from(element.querySelectorAll('input[type=file]'))
          if (inputs.length === 0) {
            inputs.push(...Array.from(element.closest('form')?.querySelectorAll('input[type=file]') ?? []))
          }
          return {
            present: inputs.length === 1,
            multiple: inputs.length === 1 && inputs[0].multiple === true,
          }
        })
        return { present: result?.present === true, multiple: result?.multiple === true }
      } catch (error) {
        throw driverError(
          'browser_file_upload_unsupported',
          'Photo control could not be inspected safely',
          error
        )
      }
    },

    async uploadFiles(ref, paths, options) {
      if (!Array.isArray(paths) || paths.length === 0 || !paths.every((path) => typeof path === 'string')) {
        throw new TypeError('paths must be a non-empty string array')
      }
      const { trigger } = uploadOptions(options)
      const chooserResult = settleEvent(
        playwright.waitForEvent('filechooser', { timeoutMs: actionTimeoutMs })
      )
      try {
        await locatorHandle(trigger ?? ref).click({ timeoutMs: actionTimeoutMs })
      } catch (error) {
        await chooserResult
        throw driverError('browser_photo_input_missing', 'Photo control did not open a file chooser', error)
      }
      const settled = await chooserResult
      if (settled.error !== undefined) {
        throw driverError(
          'browser_file_upload_unsupported',
          'Photo control did not expose a supported file chooser',
          settled.error
        )
      }
      const chooser = settled.value
      if (typeof chooser?.isMultiple !== 'function' || typeof chooser?.setFiles !== 'function') {
        throw driverError(
          'browser_file_upload_unsupported',
          'Photo control exposed an incomplete file chooser'
        )
      }
      const multiple = chooser.isMultiple() === true
      if (paths.length > 1 && !multiple) {
        throw driverError('browser_photo_input_not_multiple', 'Photo input does not accept a batch')
      }
      try {
        await chooser.setFiles(paths, { timeoutMs: actionTimeoutMs })
      } catch (error) {
        throw driverError('browser_photo_upload_incomplete', 'Photo files were not delivered', error)
      }
      return { multiple }
    },

    /** Codex exposes no page keyboard; `locator.press` delivers the key at that element. */
    async pressKey(ref, key) {
      try {
        await locatorHandle(ref).press(String(key), { timeoutMs: actionTimeoutMs })
      } catch (error) {
        throw driverError('browser_key_press_failed', 'A key could not be pressed', error)
      }
    },

    async readText(ref) {
      try {
        return await locatorHandle(ref).textContent({ timeoutMs: actionTimeoutMs })
      } catch (error) {
        throw driverError('browser_read_text_failed', 'Located element text could not be read', error)
      }
    },
  })
}

/**
 * Wraps a host-selected or host-claimed Codex tab. This module never opens Chrome, chooses a tab,
 * claims a tab, chooses an account, or decides whether the user authorized it.
 */
export function createCodexBrowserClientTab(options = {}) {
  let hostTab = requiredObject(options.tab, 'tab')
  requiredFunction(hostTab.goto, 'tab.goto')
  requiredFunction(hostTab.url, 'tab.url')
  const reacquireTab = options.reacquireTab
  if (reacquireTab !== undefined) requiredFunction(reacquireTab, 'reacquireTab')
  const releaseTab = options.releaseTab
  if (releaseTab !== undefined) requiredFunction(releaseTab, 'releaseTab')
  if (reacquireTab !== undefined && releaseTab === undefined) {
    throw new TypeError('releaseTab is required when reacquireTab can create a replacement binding')
  }
  const openFreshTab = options.openFreshTab
  if (openFreshTab !== undefined) requiredFunction(openFreshTab, 'openFreshTab')
  if (openFreshTab !== undefined && releaseTab === undefined) {
    throw new TypeError('releaseTab is required when openFreshTab opens replacement tabs')
  }
  let tabId = hostTab.id
  if (
    (reacquireTab !== undefined || openFreshTab !== undefined) &&
    !((typeof tabId === 'string' && tabId.trim() !== '') || Number.isInteger(tabId))
  ) {
    throw new TypeError('tab.id must identify the host-selected tab when reacquireTab is supplied')
  }

  let activeDriver = createCodexBrowserClientDriver({ ...options, tab: hostTab })

  async function reacquireAfterNavigation() {
    if (reacquireTab === undefined) return
    let replacementId = null
    try {
      const navigatedUrl = await hostTab.url()
      const nextTab = requiredObject(await reacquireTab(tabId, navigatedUrl), 'reacquired tab')
      requiredFunction(nextTab.goto, 'reacquired tab.goto')
      requiredFunction(nextTab.url, 'reacquired tab.url')
      const nextId = nextTab.id
      if (!((typeof nextId === 'string' && nextId.trim() !== '') || Number.isInteger(nextId))) {
        throw new TypeError('reacquired tab must have a stable id')
      }
      replacementId = nextId
      if (new URL(await nextTab.url()).toString() !== new URL(navigatedUrl).toString()) {
        throw new TypeError('reacquired tab must preserve the navigated URL')
      }
      const nextDriver = createCodexBrowserClientDriver({ ...options, tab: nextTab })
      if (nextId !== tabId) await releaseTab(tabId, nextId)
      activeDriver = nextDriver
      hostTab = nextTab
      tabId = nextId
    } catch (error) {
      if (replacementId !== null && replacementId !== tabId) {
        try {
          await releaseTab(replacementId, tabId)
        } catch {}
      }
      throw driverError(
        'browser_tab_reacquire_failed',
        'Navigated browser page could not be rebound safely',
        error
      )
    }
  }

  const driver = {}
  for (const method of [...DRIVER_METHODS, 'inspectFileUpload', 'pressKey']) {
    if (method === 'clickAndWaitForNavigation') {
      driver[method] = async (...args) => {
        const result = await activeDriver[method](...args)
        await reacquireAfterNavigation()
        return result
      }
    } else {
      driver[method] = (...args) => activeDriver[method](...args)
    }
  }

  return Object.freeze({
    driver: Object.freeze(driver),
    async goto(url) {
      try {
        await hostTab.goto(url)
      } catch (error) {
        throw driverError('browser_navigation_failed', 'The host tab could not open the page', error)
      }
      await reacquireAfterNavigation()
    },
    async url() {
      return await hostTab.url()
    },
    /**
     * Present only when the host supplied `openFreshTab(url)`: opens `url` in a new tab of the same
     * browser, moves the driver onto it, then releases the previous tab. A form left half-filled in
     * the old tab is closed with it, unsaved; a page guarding unsaved input cannot block this the
     * way it blocks navigating the same tab.
     */
    ...(openFreshTab === undefined
      ? {}
      : {
        async openFresh(url) {
          const previousId = tabId
          let nextTab
          try {
            nextTab = requiredObject(await openFreshTab(url), 'fresh tab')
            requiredFunction(nextTab.goto, 'fresh tab.goto')
            requiredFunction(nextTab.url, 'fresh tab.url')
            if (!((typeof nextTab.id === 'string' && nextTab.id.trim() !== '') || Number.isInteger(nextTab.id))) {
              throw new TypeError('fresh tab must have a stable id')
            }
          } catch (error) {
            throw driverError('browser_fresh_tab_failed', 'The host could not open a fresh tab', error)
          }
          activeDriver = createCodexBrowserClientDriver({ ...options, tab: nextTab })
          hostTab = nextTab
          tabId = nextTab.id
          if (previousId !== tabId) {
            try {
              await releaseTab(previousId, tabId)
            } catch {}
          }
        },
      }),
  })
}
