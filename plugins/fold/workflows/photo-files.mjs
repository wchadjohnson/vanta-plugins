import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import path from 'node:path'

/**
 * Plain HTTP is accepted only from a local network: a local Fold signs photos through a local
 * Supabase, on loopback (`http://127.0.0.1:54321/...`) or bound to the machine's LAN address for
 * phone testing (`http://192.168.x.x:54321/...`). That means `localhost`, or a LITERAL address in
 * loopback, private IPv4 (10/8, 172.16/12, 192.168/16) or IPv6 unique-local / link-local
 * (fc00::/7, fe80::/10) space. A hostname is never trusted for looking or resolving private
 * (a private address wrapped in a wildcard-DNS hostname such as `nip.io` is refused). Every other
 * photo URL must be HTTPS, as production's are.
 */
function isLocalNetworkHost(hostname) {
  if (hostname === 'localhost') return true
  const address = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  const version = isIP(address)
  if (version === 4) {
    const [a, b] = address.split('.').map(Number)
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  }
  if (version === 6) {
    const lower = address.toLowerCase()
    if (lower === '::1') return true
    const first = Number.parseInt(lower.split(':')[0] || '0', 16)
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80
  }
  return false
}

/**
 * Vinted takes photos up to 9 MB each; a larger download is refused rather than written, and the
 * download is never followed through a redirect (a redirect could leave the allowed hosts).
 */
export const MAX_PHOTO_BYTES = 9 * 1024 * 1024

/**
 * The host half of a browser capability's photo contract, ready-made. A capability calls
 * `resolvePhotoFiles(photos)` with `[{ sourceUrl, filename, order }]` (Fold order) and needs one
 * absolute local path per photo, same order, each named exactly `filename` — browsers upload files,
 * not URLs. This resolver downloads each Fold-signed photo URL into its own fresh folder under
 * `directory` (two listings may both have a `front.jpg`) and returns those paths.
 *
 * Signed URLs are never logged or returned; a failed download reports the filename only.
 */
export function createPhotoFileResolver({ directory, fetch: fetchImpl = globalThis.fetch } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    throw new TypeError('directory must be an absolute path the browser can read')
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch must be a function')

  return async function resolvePhotoFiles(photos) {
    if (!Array.isArray(photos) || photos.length === 0) {
      throw new TypeError('resolvePhotoFiles(photos) needs the prepared photos array')
    }
    const folder = path.join(directory, randomUUID())
    await mkdir(folder, { recursive: true })
    return Promise.all(
      photos.map(async (photo, index) => {
        const filename = photo?.filename
        if (
          typeof filename !== 'string' ||
          filename === '' ||
          filename === '.' ||
          filename === '..' ||
          filename !== path.basename(filename) ||
          filename.includes('\\')
        ) {
          throw new TypeError(`Photo ${index} has no safe filename`)
        }
        let url
        try {
          url = new URL(photo.sourceUrl)
        } catch {
          throw new TypeError(`Photo ${filename} has no source URL`)
        }
        if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalNetworkHost(url.hostname))) {
          throw new TypeError(`Photo ${filename} is not an HTTPS URL`)
        }
        let response
        try {
          response = await fetchImpl(url, { redirect: 'error' })
        } catch (error) {
          throw new Error(`Photo ${filename} could not be downloaded (redirects are refused): ${error?.message ?? error}`)
        }
        if (!response.ok) throw new Error(`Photo ${filename} could not be downloaded (HTTP ${response.status})`)
        const declared = Number(response.headers?.get?.('content-length'))
        if (Number.isFinite(declared) && declared > MAX_PHOTO_BYTES) {
          throw new Error(`Photo ${filename} is ${declared} bytes; Vinted accepts at most ${MAX_PHOTO_BYTES}`)
        }
        const bytes = Buffer.from(await response.arrayBuffer())
        if (bytes.byteLength > MAX_PHOTO_BYTES) {
          throw new Error(`Photo ${filename} is ${bytes.byteLength} bytes; Vinted accepts at most ${MAX_PHOTO_BYTES}`)
        }
        const file = path.join(folder, filename)
        await writeFile(file, bytes)
        return file
      })
    )
  }
}
