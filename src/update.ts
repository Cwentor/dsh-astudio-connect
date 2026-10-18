/**
 * Public update metadata and bounded version checking for AStudio Connect.
 *
 * Two upstreams, strictly layered so the judgement never depends on the
 * enrichment: npm's dist-tags decide whether a newer release exists, and only
 * then is GitHub's release list consulted — one request that feeds both the
 * "versions behind" count and the per-release notes. Every upstream answer is
 * treated as untrusted input: bodies are size-capped while streaming, releases
 * are re-validated on the browser side by {@link parseAStudioUpdateResult}
 * before anything renders.
 *
 * This module is host/browser shared and dependency-free by design (the client
 * bundle's runtime imports stay React + local modules only).
 *
 * @module dsh-astudio-connect/update
 */

import { ASTRO_PACKAGE_NAME, ASTRO_REPOSITORY_URL } from './version.ts'

export const ASTRO_UPDATE_PACKAGE_NAME = ASTRO_PACKAGE_NAME
export const ASTRO_UPDATE_NPM_METADATA_URL = `https://registry.npmjs.org/-/package/${ASTRO_UPDATE_PACKAGE_NAME}/dist-tags`
export const ASTRO_UPDATE_RELEASES_API_URL = `${ASTRO_REPOSITORY_URL.replace('https://github.com', 'https://api.github.com/repos')}/releases?per_page=100`
export const ASTRO_RELEASE_PAGE_BASE = `${ASTRO_REPOSITORY_URL}/releases/tag/`
export const ASTRO_UPDATE_TIMEOUT_MS = 8_000
export const ASTRO_UPDATE_MAX_METADATA_BYTES = 64 * 1024
export const ASTRO_UPDATE_MAX_RELEASES_BYTES = 1024 * 1024
/** GitHub caps one page at 100 releases; ours is far below that today. */
const RELEASES_LIST_MAX = 100
const RELEASE_NAME_MAX_CHARS = 200
const RELEASE_NOTES_MAX_CHARS = 16_000

/** One release between the current and latest version, newest first. */
export interface AStudioUpdateRelease {
  version: string
  /** Release title as written on GitHub, e.g. the bilingual summary line. */
  name?: string
  /** Cleaned release notes body, truncated. */
  notes?: string
  /** ISO publication time, validated loosely. */
  publishedAt?: string
}

export type AStudioUpdateResult =
  | {
    status: 'up-to-date'
    currentVersion: string
    latestVersion: string
  }
  | {
    status: 'update-available'
    currentVersion: string
    latestVersion: string
    releaseUrl: string
    /**
     * Releases between (current, latest], newest first. Empty — with
     * `versionsBehind` absent — when GitHub could not be reached: the
     * judgement (npm) stands, only the enrichment degrades.
     */
    releases: readonly AStudioUpdateRelease[]
    /** Present iff the release list was fetched; equals `releases.length`. */
    versionsBehind?: number
  }
  | {
    status: 'unavailable'
    currentVersion: string
    reason: 'invalid-current-version' | 'registry-unavailable' | 'invalid-registry-response'
  }

export type AStudioUpdateFetch = (input: string, init?: RequestInit) => Promise<Response>

interface ParsedVersion {
  major: number
  minor: number
  patch: number
  prerelease: Array<number | string>
}

/** Parse one exact SemVer version, accepting the conventional leading `v`. */
export function parseAStudioVersion(raw: string): ParsedVersion | undefined {
  if (typeof raw !== 'string') return undefined
  const normalized = raw.startsWith('v') ? raw.slice(1) : raw
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.exec(normalized)
  if (match === null) return undefined
  const rawPrerelease = match[4] === undefined ? [] : match[4].split('.')
  if (rawPrerelease.some(identifier => /^\d+$/u.test(identifier) && !/^(0|[1-9]\d*)$/u.test(identifier))) return undefined
  const prerelease = rawPrerelease.map(identifier => /^(0|[1-9]\d*)$/u.test(identifier) ? Number(identifier) : identifier)
  if (prerelease.some(identifier => typeof identifier === 'number' && !Number.isSafeInteger(identifier))) return undefined
  const parsed = {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  }
  return [parsed.major, parsed.minor, parsed.patch].every(Number.isSafeInteger) ? parsed : undefined
}

/**
 * One canonical spelling per SemVer value: leading `v` and build metadata
 * fold away, so `v0.6.4`, `0.6.4`, and `0.6.4+build` dedupe as one release.
 * Returns `undefined` for unparseable input; callers drop those first.
 */
export function canonicalAStudioVersion(version: string): string | undefined {
  const parsed = parseAStudioVersion(version)
  if (parsed === undefined) return undefined
  return `${String(parsed.major)}.${String(parsed.minor)}.${String(parsed.patch)}`
    + (parsed.prerelease.length === 0 ? '' : `-${parsed.prerelease.join('.')}`)
}

function compareIdentifiers(left: number | string, right: number | string): number {
  if (typeof left === 'number' && typeof right === 'number') return left < right ? -1 : left > right ? 1 : 0
  if (typeof left === 'number') return -1
  if (typeof right === 'number') return 1
  return left < right ? -1 : left > right ? 1 : 0
}

/** Compare two versions using SemVer precedence (build metadata ignored). */
export function compareAStudioVersions(left: string, right: string): number {
  const a = parseAStudioVersion(left)
  const b = parseAStudioVersion(right)
  if (a === undefined || b === undefined) throw new TypeError('invalid AStudio Connect version')
  for (const [aPart, bPart] of [[a.major, b.major], [a.minor, b.minor], [a.patch, b.patch]] as const) {
    if (aPart !== bPart) return aPart < bPart ? -1 : 1
  }
  if (a.prerelease.length === 0 && b.prerelease.length !== 0) return 1
  if (a.prerelease.length !== 0 && b.prerelease.length === 0) return -1
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const aPart = a.prerelease[index]
    const bPart = b.prerelease[index]
    if (aPart === undefined) return -1
    if (bPart === undefined) return 1
    const comparison = compareIdentifiers(aPart, bPart)
    if (comparison !== 0) return comparison
  }
  return 0
}

function boundedText(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value)
  if (bytes.byteLength > maxBytes) throw new RangeError('update response is too large')
  return value
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) return boundedText(await response.text(), maxBytes)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new RangeError('update response is too large')
      }
      chunks.push(decoder.decode(next.value, { stream: true }))
    }
    chunks.push(decoder.decode())
    return chunks.join('')
  } finally {
    reader.releaseLock()
  }
}

async function fetchBounded(
  fetchImpl: AStudioUpdateFetch,
  url: string,
  maxBytes: number,
  timeoutMs: number,
  headers: Record<string, string>,
): Promise<{ response: Response, text: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort(new Error('update request timed out')) }, timeoutMs)
  try {
    const response = await fetchImpl(url, { headers, signal: controller.signal })
    const text = await readBoundedText(response, maxBytes)
    return { response, text }
  } finally {
    clearTimeout(timer)
  }
}

/** Strip control characters, normalize newlines, and cap the length. */
function cleanReleaseText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const clean = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '')
    .replace(/\r\n?/gu, '\n')
    .trim()
    .slice(0, maxLength)
  return clean.length === 0 ? undefined : clean
}

function cleanPublishedAt(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/iu.test(value) ? value.slice(0, 64) : undefined
}

/**
 * The `latest` dist-tag only. Pre-release channels are not this plugin's
 * release line, so recommending one would be wrong even when newer.
 */
function latestDistTag(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const tags = (value as Record<string, unknown>)['dist-tags'] ?? value
  if (typeof tags !== 'object' || tags === null || Array.isArray(tags)) return undefined
  const candidate = (tags as Record<string, unknown>)['latest']
  return typeof candidate === 'string' && parseAStudioVersion(candidate) !== undefined ? candidate : undefined
}

export function releasePageUrl(version: string): string {
  return `${ASTRO_RELEASE_PAGE_BASE}v${version}`
}

/**
 * Parse GitHub's release-list page into the in-range releases, newest first.
 * Unknown entry shapes are skipped, never fatal: the count and the notes both
 * degrade per-entry rather than dropping the whole judgement.
 */
function releasesInRange(currentVersion: string, latestVersion: string, value: unknown): AStudioUpdateRelease[] | undefined {
  if (!Array.isArray(value) || value.length > RELEASES_LIST_MAX) return undefined
  const releases: AStudioUpdateRelease[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const entry = raw as Record<string, unknown>
    const tag = entry['tag_name']
    if (typeof tag !== 'string') continue
    const version = parseAStudioVersion(tag)
    if (version === undefined) continue
    if (compareAStudioVersions(tag, currentVersion) <= 0 || compareAStudioVersions(tag, latestVersion) > 0) continue
    // Dedupe by SemVer value, not spelling: `v0.6.4` and `0.6.4` are one
    // release, and neither the count nor the rows may list it twice.
    const canonical = canonicalAStudioVersion(tag)
    if (canonical === undefined || seen.has(canonical)) continue
    seen.add(canonical)
    const name = cleanReleaseText(entry['name'], RELEASE_NAME_MAX_CHARS)
    const notes = cleanReleaseText(entry['body'], RELEASE_NOTES_MAX_CHARS)
    const publishedAt = cleanPublishedAt(entry['published_at'])
    releases.push({ version: tag, ...name === undefined ? {} : { name }, ...notes === undefined ? {} : { notes }, ...publishedAt === undefined ? {} : { publishedAt } })
  }
  releases.sort((left, right) => compareAStudioVersions(right.version, left.version))
  return releases
}

/** Enrich an available update from GitHub's release list; degrade on failure. */
async function releaseList(
  currentVersion: string,
  latestVersion: string,
  fetchImpl: AStudioUpdateFetch,
  timeoutMs: number,
): Promise<AStudioUpdateRelease[] | undefined> {
  try {
    const { response, text } = await fetchBounded(
      fetchImpl,
      ASTRO_UPDATE_RELEASES_API_URL,
      ASTRO_UPDATE_MAX_RELEASES_BYTES,
      timeoutMs,
      { accept: 'application/vnd.github+json' },
    )
    if (!response.ok) return undefined
    return releasesInRange(currentVersion, latestVersion, JSON.parse(text) as unknown)
  } catch {
    return undefined
  }
}

/** Check npm's public dist-tags and enrich an available update with release notes. */
export async function checkAStudioUpdate(options: {
  currentVersion: string
  fetchImpl?: AStudioUpdateFetch
  timeoutMs?: number
}): Promise<AStudioUpdateResult> {
  const { currentVersion } = options
  if (parseAStudioVersion(currentVersion) === undefined) {
    return { status: 'unavailable', currentVersion, reason: 'invalid-current-version' }
  }
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? ASTRO_UPDATE_TIMEOUT_MS
  let metadata: unknown
  try {
    const { response, text } = await fetchBounded(
      fetchImpl,
      ASTRO_UPDATE_NPM_METADATA_URL,
      ASTRO_UPDATE_MAX_METADATA_BYTES,
      timeoutMs,
      { accept: 'application/json' },
    )
    if (!response.ok) return { status: 'unavailable', currentVersion, reason: 'registry-unavailable' }
    metadata = JSON.parse(text) as unknown
  } catch (error: unknown) {
    return {
      status: 'unavailable',
      currentVersion,
      reason: error instanceof SyntaxError || error instanceof RangeError ? 'invalid-registry-response' : 'registry-unavailable',
    }
  }
  const latestVersion = latestDistTag(metadata)
  if (latestVersion === undefined) return { status: 'unavailable', currentVersion, reason: 'invalid-registry-response' }
  if (compareAStudioVersions(latestVersion, currentVersion) <= 0) {
    return { status: 'up-to-date', currentVersion, latestVersion: currentVersion }
  }
  const releases = await releaseList(currentVersion, latestVersion, fetchImpl, timeoutMs)
  return {
    status: 'update-available',
    currentVersion,
    latestVersion,
    releaseUrl: releasePageUrl(latestVersion),
    releases: releases ?? [],
    ...releases === undefined ? {} : { versionsBehind: releases.length },
  }
}

/**
 * Validate a route response before the browser renders it. Same distrust as
 * the host side: the versions must parse, `update-available` must still hold
 * under a fresh comparison, the release URL must equal the one derived from
 * the version, and every listed release must fall in (current, latest] — a
 * host that invents content fails closed here.
 */
export function parseAStudioUpdateResult(value: unknown): AStudioUpdateResult | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const currentVersion = record['currentVersion']
  if (typeof currentVersion !== 'string' || parseAStudioVersion(currentVersion) === undefined) return undefined
  if (record['status'] === 'unavailable') {
    const reason = record['reason']
    return reason === 'invalid-current-version' || reason === 'registry-unavailable' || reason === 'invalid-registry-response'
      ? { status: 'unavailable', currentVersion, reason }
      : undefined
  }
  const latestVersion = record['latestVersion']
  if (typeof latestVersion !== 'string' || parseAStudioVersion(latestVersion) === undefined) return undefined
  if (record['status'] === 'up-to-date') {
    return { status: 'up-to-date', currentVersion, latestVersion }
  }
  if (record['status'] !== 'update-available' || compareAStudioVersions(latestVersion, currentVersion) <= 0) return undefined
  const expectedUrl = releasePageUrl(latestVersion)
  if (record['releaseUrl'] !== expectedUrl) return undefined
  if (!Array.isArray(record['releases']) || record['releases'].length > RELEASES_LIST_MAX) return undefined
  const seen = new Set<string>()
  const releases: AStudioUpdateRelease[] = []
  for (const raw of record['releases']) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
    const entry = raw as Record<string, unknown>
    const version = entry['version']
    if (typeof version !== 'string' || parseAStudioVersion(version) === undefined) return undefined
    // The range is re-derived, not trusted: an out-of-range or duplicate
    // entry means the document is not what this checker produced. Duplicates
    // count by SemVer value — two spellings of one version are as rejectable
    // as the same string twice.
    if (compareAStudioVersions(version, currentVersion) <= 0 || compareAStudioVersions(version, latestVersion) > 0) return undefined
    const canonical = canonicalAStudioVersion(version)
    if (canonical === undefined || seen.has(canonical)) return undefined
    seen.add(canonical)
    const name = cleanReleaseText(entry['name'], RELEASE_NAME_MAX_CHARS)
    const notes = cleanReleaseText(entry['notes'], RELEASE_NOTES_MAX_CHARS)
    const publishedAt = cleanPublishedAt(entry['publishedAt'])
    releases.push({ version, ...name === undefined ? {} : { name }, ...notes === undefined ? {} : { notes }, ...publishedAt === undefined ? {} : { publishedAt } })
  }
  const rawVersionsBehind = record['versionsBehind']
  if (rawVersionsBehind !== undefined
    && (typeof rawVersionsBehind !== 'number' || !Number.isSafeInteger(rawVersionsBehind) || rawVersionsBehind !== releases.length)) return undefined
  return {
    status: 'update-available',
    currentVersion,
    latestVersion,
    releaseUrl: expectedUrl,
    releases,
    ...rawVersionsBehind === undefined ? {} : { versionsBehind: rawVersionsBehind },
  }
}
