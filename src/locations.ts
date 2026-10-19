/**
 * AStudio install-location discovery.
 *
 * AStudio records where it keeps its data in the Windows registry
 * (`HKCU\Software\AStudioStorage`, values prefixed per release profile). That
 * record — not a guess derived from the executable's path — is the authority
 * for `config.toml` and `astron-session.json`. The probe order is:
 *
 *   1. an explicit path (settings), used verbatim
 *   2. `ASTUDIO_DATA_HOME`, used verbatim
 *   3. the registry record for the release profile
 *   4. the install-sibling `<install dir> Data` directory
 *
 * A present-but-unreadable record is an error, never a silent fallthrough: a
 * stale older install must not win over a newer one this plugin cannot read.
 *
 * @module dsh-astudio-connect/locations
 */

import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'

/** Environment variable that overrides the AStudio data root. */
export const ASTRO_HOME_ENV = 'ASTUDIO_DATA_HOME'

/** Registry key AStudio writes its storage location into. */
export const ASTRO_STORAGE_REGISTRY_KEY = 'HKCU\\Software\\AStudioStorage'

/** Release profile this bundle targets. */
export const DEFAULT_PROFILE = 'production' as const

/** Release profiles AStudio distinguishes in its registry record. */
export type AStudioProfile = 'production' | 'canary' | 'development'

/** The two paths a resolved AStudio storage record carries. */
export interface AStudioStorageRecord {
  /** Directory holding `userdata`, `runtime`, and the electron profile. */
  dataRoot: string
  /** Directory holding `config.toml`. */
  acodeHome: string
}

/** Where a resolved home came from, for diagnostics. */
export type AStudioHomeSource = 'explicit' | 'env' | 'registry' | 'install-sibling'

/** Inputs to discovery; every dependency is injectable for tests. */
export interface AStudioHomeInput {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** Explicit path from settings, used verbatim when present. */
  explicit?: string
  /** Raw text of a `reg query` run, when the caller already has one. */
  registryOutput?: string
  /** An already-parsed registry record, when the caller has one. */
  registryRecord?: AStudioStorageRecord
  /** The AStudio executable path, when the caller knows it. */
  executablePath?: string
  /** Predicate deciding whether a candidate home is usable. */
  isReadable?: (path: string) => boolean
}

/** Outcome of {@link resolveAstudioHome}. */
export type AStudioHomeResult =
  | { ok: true; home: string; source: AStudioHomeSource; record?: AStudioStorageRecord }
  | { ok: false; reason: string; tried: readonly string[] }

/** The registry value-name prefix for one profile. */
export function profilePrefix(profile: AStudioProfile): string {
  if (profile === 'production') return 'Production'
  if (profile === 'canary') return 'Canary'
  return 'Development'
}

/** Read one registry value out of parsed `reg query` output. */
function registryValues(output: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const line of output.split(/\r?\n/u)) {
    // "    Name    REG_SZ    Value" — the type column separates name from value.
    const match = /^\s{2,}(\S+)\s+REG_\w+\s+(.*)$/u.exec(line)
    if (match === null) continue
    const name = match[1]
    const value = match[2]
    if (name === undefined || value === undefined) continue
    values.set(name, value.trim())
  }
  return values
}

/**
 * Parse AStudio's storage registry record for one profile.
 *
 * Returns undefined when the record is absent, and throws when the record is
 * present but incomplete or of an unsupported schema version.
 */
export function parseStorageRegistry(output: string, profile: AStudioProfile): AStudioStorageRecord | undefined {
  const values = registryValues(output)
  const prefix = profilePrefix(profile)
  const schemaVersion = values.get(`${prefix}SchemaVersion`)
  const dataRoot = values.get(`${prefix}DataRoot`)
  const acodeHome = values.get(`${prefix}AcodeHome`)

  if (schemaVersion === undefined && dataRoot === undefined && acodeHome === undefined) return undefined
  if (schemaVersion === undefined) throw new Error(`AStudio ${prefix} storage location record is incomplete.`)
  if (schemaVersion !== '0x1' && schemaVersion !== '1') {
    throw new Error(`Unsupported AStudio storage location schema: ${schemaVersion}`)
  }
  if (dataRoot === undefined || dataRoot === '' || acodeHome === undefined || acodeHome === '') {
    throw new Error(`AStudio ${prefix} storage location record is incomplete.`)
  }
  return { dataRoot, acodeHome }
}

/** Derive the install-sibling data directory AStudio uses on Windows. */
function installSiblingHome(executablePath: string, profile: AStudioProfile): string {
  const directoryName = profile === 'canary'
    ? 'AStudio Canary Data'
    : profile === 'development' ? 'AStudio Dev Data' : 'AStudio Data'
  return join(dirname(executablePath), '..', directoryName)
}

/** Result of running one subprocess, reduced to what the probe needs. */
export interface ProbeRunResult {
  status: number | null
  stdout: string
}

/** Options for {@link readStorageRegistry}. */
export interface ReadStorageRegistryOptions {
  platform?: NodeJS.Platform
  profile?: AStudioProfile
  /** Injected runner, so tests never spawn a real process. */
  run?: (command: string, args: readonly string[]) => ProbeRunResult
}

/**
 * Query AStudio's storage registry record through `reg.exe`.
 *
 * A non-zero exit or an unparseable answer reads as "no record" so a machine
 * without AStudio degrades to the other candidates instead of failing. A
 * record that *is* present but incomplete still throws, via
 * {@link parseStorageRegistry}.
 */
export function readStorageRegistry(options: ReadStorageRegistryOptions = {}): AStudioStorageRecord | undefined {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return undefined

  const run = options.run ?? defaultRun
  const result = run('reg.exe', ['query', ASTRO_STORAGE_REGISTRY_KEY])
  if (result.status !== 0 || result.stdout.trim() === '') return undefined
  return parseStorageRegistry(result.stdout, options.profile ?? DEFAULT_PROFILE)
}

/** Run one subprocess synchronously and capture its stdout. */
function defaultRun(command: string, args: readonly string[]): ProbeRunResult {
  const result = spawnSync(command, [...args], { encoding: 'utf8', timeout: 5_000, windowsHide: true })
  return { status: result.status, stdout: result.stdout ?? '' }
}

/** Whether a path exists, used as the default usability predicate. */
function exists(path: string): boolean {
  return existsSync(path)
}

/** One probe candidate together with the rule that produced it. */
interface Candidate {
  home: string
  source: AStudioHomeSource
}

/** The registry record a discovery run works from, if any. */
function storageRecordFor(input: AStudioHomeInput): AStudioStorageRecord | undefined {
  if (input.registryRecord !== undefined) return input.registryRecord
  if (input.registryOutput === undefined) return undefined
  return parseStorageRegistry(input.registryOutput, DEFAULT_PROFILE)
}

/** Enumerate probe candidates, keeping each one's provenance. */
function probeCandidates(input: AStudioHomeInput = {}): readonly Candidate[] {
  const platform = input.platform ?? process.platform
  const env = input.env ?? process.env

  if (input.explicit !== undefined && input.explicit !== '') {
    return [{ home: input.explicit, source: 'explicit' }]
  }
  const fromEnv = env[ASTRO_HOME_ENV]?.trim()
  if (fromEnv !== undefined && fromEnv !== '') return [{ home: fromEnv, source: 'env' }]

  if (platform !== 'win32') return []

  const candidates: Candidate[] = []
  const record = storageRecordFor(input)
  if (record !== undefined) candidates.push({ home: record.dataRoot, source: 'registry' })
  if (input.executablePath !== undefined && input.executablePath !== '') {
    candidates.push({ home: installSiblingHome(input.executablePath, DEFAULT_PROFILE), source: 'install-sibling' })
  }
  const seen = new Set<string>()
  return candidates.filter(candidate => {
    if (seen.has(candidate.home)) return false
    seen.add(candidate.home)
    return true
  })
}

/**
 * Enumerate candidate AStudio data roots in probe order.
 *
 * An explicit path or the environment override short-circuits the list: both
 * are used verbatim rather than treated as the head of a probe.
 */
export function candidateAstudioHomes(input: AStudioHomeInput = {}): readonly string[] {
  return probeCandidates(input).map(candidate => candidate.home)
}

/**
 * Resolve the AStudio data root to the first readable candidate.
 *
 * Returns a diagnostic rather than throwing so the status card can explain an
 * unresolved home instead of surfacing an opaque failure.
 */
export function resolveAstudioHome(input: AStudioHomeInput = {}): AStudioHomeResult {
  const isReadable = input.isReadable ?? exists
  const platform = input.platform ?? process.platform

  const candidates = probeCandidates(input)

  if (candidates.length === 0) {
    return {
      ok: false,
      reason: platform === 'win32'
        ? 'No AStudio data directory was found. Start AStudio once, or set ASTUDIO_DATA_HOME.'
        : `Automatic AStudio location discovery is only implemented for Windows (this platform is ${platform}). Set ASTUDIO_DATA_HOME.`,
      tried: [],
    }
  }

  for (const candidate of candidates) {
    // An explicit path or the env override is a declaration, not a probe: it
    // names where the caller says AStudio lives, so existence is not required
    // to make it the answer.
    const declared = candidate.source === 'explicit' || candidate.source === 'env'
    if (!declared && !isReadable(candidate.home)) continue
    const record = storageRecordFor(input)
    return { ok: true, home: candidate.home, source: candidate.source, ...(record === undefined ? {} : { record }) }
  }

  return {
    ok: false,
    reason: `AStudio data directory not found. Tried: ${candidates.map(candidate => candidate.home).join(' or ')}. Start AStudio once, or set ${ASTRO_HOME_ENV}.`,
    tried: candidates.map(candidate => candidate.home),
  }
}

/** Path to AStudio's runtime config.toml inside one data root. */
export function configPathForHome(home: string): string {
  return join(home, 'runtime', 'acode-home', 'config.toml')
}

/** Path to AStudio's astron-session.json inside one data root. */
export function sessionFilePathForHome(home: string): string {
  return join(home, 'userdata', 'astron-session.json')
}
