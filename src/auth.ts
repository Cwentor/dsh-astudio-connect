/**
 * AStudio credential store. Reads the chat bearer token from the AStudio
 * runtime config.toml and the model-manager token from astron-session.json,
 * caches both in memory, and never writes to disk.
 *
 * Both files live under one AStudio data root, discovered per platform rather
 * than assumed at a fixed absolute path; see ./locations.ts.
 *
 * @module dsh-astudio-connect/auth
 */

import { existsSync, readFileSync } from 'node:fs'
import {
  configPathForHome,
  sessionFilePathForHome,
  readStorageRegistry,
  resolveAstudioHome,
} from './locations.ts'

/** Regex for the bearer-token field in config.toml. */
const TOKEN_PATTERN = /experimental_bearer_token\s*=\s*"([^"]+)"/

/** What the shim and upstream need from a credential. */
export interface AStudioCredentialStore {
  /** Resolve the current chat bearer token, or undefined when unavailable. */
  resolve(): AStudioCredential
  /** Resolve the model-manager token, or undefined when unavailable. */
  modelBearerToken?(): AStudioCredential
}

/** Secret-free sign-in summary for status and doctor output. */
export interface AStudioAuthStatus {
  state: 'signed-in' | 'signed-out'
  configPath: string
  tokenLength?: number
  /** Whether a model-manager token was also found. */
  hasModelToken?: boolean
  hints: string[]
}

/** The credential type — a bearer token string or undefined. */
export type AStudioCredential = string | undefined

/** Options for constructing the store. */
export interface AStudioAuthOptions {
  /** Override the config.toml path (used by tests and settings). */
  configPath?: string
  /** Override the whole AStudio data root (used by tests). */
  dataHome?: string
}

/** Options for {@link resolveDefaultConfigPath}. */
export interface ResolveConfigPathOptions {
  explicit?: string
  dataHome?: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
}

/**
 * Read the chat bearer token from a config.toml.
 *
 * Returns undefined when the file is missing, the field is absent, or the
 * format is unexpected. Never throws — a missing credential is a normal state
 * the plugin surfaces as "not connected" in the UI.
 */
export function readTokenFromConfig(configPath: string): AStudioCredential {
  if (!existsSync(configPath)) return undefined
  let content: string
  try {
    content = readFileSync(configPath, 'utf8')
  } catch {
    return undefined
  }
  const match = TOKEN_PATTERN.exec(content)
  return match?.[1] ?? undefined
}

/**
 * Read the model-manager token from astron-session.json.
 *
 * AStudio issues this separately from the chat token; it authenticates the
 * model-manager API that serves the authoritative roster. Returns undefined
 * for a missing file, malformed JSON, an absent field, or a blank value.
 */
export function readModelBearerToken(sessionPath: string): AStudioCredential {
  if (!existsSync(sessionPath)) return undefined
  let content: string
  try {
    content = readFileSync(sessionPath, 'utf8')
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const value = (parsed as Record<string, unknown>)['modelBearerToken']
  if (typeof value !== 'string' || value.trim() === '') return undefined
  return value.trim()
}

/**
 * Resolve config.toml for a data root or an explicit override.
 *
 * Falls back to the discovered AStudio home, keeping the plugin usable with
 * zero configuration on a machine where AStudio is installed normally.
 */
export function resolveDefaultConfigPath(options: ResolveConfigPathOptions = {}): string {
  if (options.explicit !== undefined && options.explicit !== '') return options.explicit
  if (options.dataHome !== undefined && options.dataHome !== '') return configPathForHome(options.dataHome)

  const resolved = resolveHomeForOptions(options)
  return resolved === undefined ? '' : configPathForHome(resolved)
}

/** Resolve the AStudio data root from discovery, or undefined when unknown. */
function resolveHomeForOptions(options: ResolveConfigPathOptions): string | undefined {
  const registryRecord = readStorageRegistry({
    ...(options.platform === undefined ? {} : { platform: options.platform }),
  })
  const resolved = resolveAstudioHome({
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(registryRecord === undefined ? {} : { registryRecord }),
  })
  return resolved.ok ? resolved.home : undefined
}

/**
 * Create a credential store that reads both AStudio files and caches the
 * results in memory. Call `invalidate()` to force a re-read (e.g. after the
 * user signs in again).
 */
export function createAStudioAuth(options: AStudioAuthOptions = {}) {
  const dataHome = options.dataHome
  const explicitConfig = options.configPath
  let cachedToken: AStudioCredential | null = null
  let cachedModelToken: AStudioCredential | null = null
  let cachedConfigPath: string | undefined

  const configPath = (): string => {
    if (cachedConfigPath !== undefined) return cachedConfigPath
    cachedConfigPath = resolveDefaultConfigPath({
      ...(explicitConfig === undefined ? {} : { explicit: explicitConfig }),
      ...(dataHome === undefined ? {} : { dataHome }),
    })
    return cachedConfigPath
  }

  /** The astron-session.json beside the resolved config.toml. */
  const sessionPath = (): string => {
    if (dataHome !== undefined && dataHome !== '') return sessionFilePathForHome(dataHome)
    const home = resolveHomeForOptions({})
    if (home !== undefined) return sessionFilePathForHome(home)
    return sessionFilePathForHome(resolvedHomeFromConfig(configPath()))
  }

  const current = (): AStudioCredential => {
    if (cachedToken !== null) return cachedToken
    cachedToken = readTokenFromConfig(configPath())
    return cachedToken
  }

  const currentModelToken = (): AStudioCredential => {
    if (cachedModelToken !== null) return cachedModelToken
    cachedModelToken = readModelBearerToken(sessionPath())
    return cachedModelToken
  }

  return {
    resolve(): AStudioCredential {
      return current()
    },
    modelBearerToken(): AStudioCredential {
      return currentModelToken()
    },
    invalidate(): void {
      cachedToken = null
      cachedModelToken = null
    },
    async status(): Promise<AStudioAuthStatus> {
      const token = current()
      if (token === undefined) {
        return {
          state: 'signed-out',
          configPath: configPath(),
          hints: ['AStudio config.toml was not found or has no experimental_bearer_token. Open AStudio and sign in.'],
        }
      }
      const hasModelToken = currentModelToken() !== undefined
      return {
        state: 'signed-in',
        configPath: configPath(),
        tokenLength: token.length,
        hasModelToken,
        hints: hasModelToken
          ? []
          : ['astron-session.json has no modelBearerToken; the model catalog will serve the built-in roster.'],
      }
    },
    async logout(): Promise<void> {
      cachedToken = null
      cachedModelToken = null
    },
  }
}

/** Walk back from a config.toml path to the data root that contains it. */
function resolvedHomeFromConfig(configPath: string): string {
  // <home>/runtime/acode-home/config.toml -> <home>
  const fromRuntime = configPath.replace(/[\\/]runtime[\\/]acode-home[\\/]config\.toml$/iu, '')
  return fromRuntime === configPath ? configPath : fromRuntime
}
