/**
 * Private-file plumbing shared by every phased workflow (post drafts, go live, delist). Phases
 * never hold a Fold call open across host calls: they write the calls they need to a private
 * file, the host's exec step runs them and writes the answers beside it, and the next phase reads
 * them back. Every folder is mkdtemp + 0700 and every file 0600.
 */
import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
// Imported, never the global: the ChatGPT app's browser runtime loads node: modules but does not
// define Node's `process` global.
import process from 'node:process'

export function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function errorCode(error, fallback) {
  return typeof error?.code === 'string' ? error.code : fallback
}

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

export function assertAbsolutePath(value, label) {
  if (!nonEmptyString(value) || !path.isAbsolute(value)) {
    throw new TypeError(`${label} must be an absolute path`)
  }
  return value
}

export function assertOptions(value) {
  if (value !== undefined && !isPlainObject(value)) throw new TypeError('options must be an object')
  return value ?? {}
}

export async function privateTempDir(prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix))
  await chmod(directory, 0o700)
  return directory
}

export async function writeJsonPrivate(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

export async function readJsonFile(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

export async function writeFoldCallFile(directory, foldCalls) {
  if (!Array.isArray(foldCalls) || foldCalls.length === 0) {
    return { fold_calls_path: null, results_path: null }
  }
  const id = randomUUID()
  const foldCallsPath = path.join(directory, `fold-calls-${id}.json`)
  const resultsPath = path.join(directory, `fold-results-${id}.json`)
  await writeJsonPrivate(foldCallsPath, { fold_calls: foldCalls, results_path: resultsPath })
  return { fold_calls_path: foldCallsPath, results_path: resultsPath }
}

export function hasDotDotSegment(value) {
  return nonEmptyString(value) && value.split(/[\\/]+/).includes('..')
}

export function pathInside(directory, candidate) {
  return (
    nonEmptyString(candidate) &&
    path.isAbsolute(candidate) &&
    !hasDotDotSegment(candidate) &&
    path.normalize(candidate) === candidate &&
    path.dirname(candidate) === directory
  )
}

/**
 * The temp roots a private workspace may sit directly under, each resolved through realpath: this
 * runtime's `os.tmpdir()`, `/tmp`, and `TMPDIR` when it is set. The ChatGPT app's exec step makes
 * input folders under `${TMPDIR:-/tmp}` while the js runtime's `os.tmpdir()` may differ (macOS
 * `/var/folders/…/T` vs `/private/tmp`), so all three count — and nothing else does.
 */
export async function allowedTempRoots() {
  const candidates = [os.tmpdir(), '/tmp']
  const fromEnv = process.env?.TMPDIR
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '' && path.isAbsolute(fromEnv)) candidates.push(fromEnv)
  const roots = new Set()
  for (const candidate of candidates) {
    try {
      roots.add(await realpath(path.normalize(candidate)))
    } catch {
      // A root that does not exist cannot hold a workspace.
    }
  }
  return roots
}

export async function sameTmpParent(parent) {
  let realParent
  try {
    realParent = await realpath(parent)
  } catch {
    return false
  }
  return (await allowedTempRoots()).has(realParent)
}

export async function validatePrivateWorkspace({ workspaceDir, statePath, prefix, stateFile }) {
  if (!nonEmptyString(workspaceDir)) return 'workspace_dir must be a non-empty string'
  if (!pathInside(workspaceDir, statePath)) return 'state path is outside its workspace directory'
  if (path.basename(statePath) !== stateFile) return `state path must end in ${stateFile}`
  if (!path.basename(workspaceDir).startsWith(prefix)) return `workspace_dir must start with ${prefix}`
  if (!(await sameTmpParent(path.dirname(workspaceDir)))) return 'workspace_dir must be directly under the private temp directory'
  let directoryStats
  let stateStats
  try {
    directoryStats = await stat(workspaceDir)
    stateStats = await stat(statePath)
  } catch (error) {
    return errorMessage(error)
  }
  if (!directoryStats.isDirectory()) return 'workspace_dir is not a directory'
  if ((directoryStats.mode & 0o777) !== 0o700) return 'workspace_dir mode is not 0700'
  if ((stateStats.mode & 0o777) !== 0o600) return 'state file mode is not 0600'
  if (typeof process.getuid === 'function' && directoryStats.uid !== process.getuid()) {
    return 'workspace_dir is not owned by the current user'
  }
  return null
}

export async function tryReadJson(file) {
  try {
    return { ok: true, value: await readJsonFile(file) }
  } catch (error) {
    return { ok: false, failure_code: errorCode(error, 'file_unreadable'), reason: errorMessage(error) }
  }
}

export function toolText(result) {
  const parts = Array.isArray(result?.content) ? result.content : []
  const text = parts
    .filter((part) => part?.type === 'text' && nonEmptyString(part.text))
    .map((part) => part.text.trim())
    .join('\n')
  return nonEmptyString(text) ? text : null
}

export function structuredFrom(result) {
  if (isPlainObject(result?.structuredContent)) return result.structuredContent
  for (const part of Array.isArray(result?.content) ? result.content : []) {
    if (part?.type !== 'text' || !nonEmptyString(part.text)) continue
    try {
      const parsed = JSON.parse(part.text)
      if (isPlainObject(parsed)) return parsed
    } catch {
      // Text-only refusals are handled by the caller.
    }
  }
  if (isPlainObject(result) && !('content' in result) && !('structuredContent' in result)) return result
  return null
}

export function unansweredResult() {
  return { unanswered: true, isError: true, content: [{ type: 'text', text: 'Fold tool call was not answered' }] }
}

export async function readResultsForCalls(resultsPath, foldCalls) {
  let raw
  try {
    raw = await readJsonFile(resultsPath)
  } catch {
    raw = null
  }
  if (!Array.isArray(raw)) raw = []
  if (raw.length !== foldCalls.length) {
    return foldCalls.map((call) => ({ name: call.name, result: unansweredResult() }))
  }
  return foldCalls.map((call, index) => {
    const entry = raw[index]
    if (!isPlainObject(entry) || entry.name !== call.name) {
      return { name: call.name, result: unansweredResult() }
    }
    return { name: call.name, result: entry.result ?? unansweredResult() }
  })
}

export function foldFailureFromResult(result, unansweredCode = 'fold_tool_unanswered') {
  if (result?.unanswered === true) return { failure_code: unansweredCode, reason: 'Fold tool call was not answered' }
  if (result?.isError === true) return { failure_code: 'fold_tool_refused', reason: toolText(result) ?? 'Fold refused the call' }
  const data = structuredFrom(result)
  if (!isPlainObject(data)) return { failure_code: 'fold_tool_result_unreadable', reason: 'Fold returned no structured content' }
  return null
}
