/**
 * AStudio credential store. Reads the experimental_bearer_token from the
 * AStudio runtime config.toml, caches it in memory, and never writes to disk.
 *
 * @module dsh-astudio-connect/auth
 */

import { existsSync, readFileSync } from 'node:fs'

/** Default config path — the AStudio runtime config.toml. */
export const DEFAULT_CONFIG_PATH =
  'D:\\IDE\\AStudio Data\\runtime\\acode-home\\config.toml'

/** Regex for the bearer-token field in config.toml. */
const TOKEN_PATTERN = /experimental_bearer_token\s*=\s*"([^"]+)"/

/** What the shim and upstream need from a credential. */
export interface AStudioCredentialStore {
  /** Resolve the current bearer token, or undefined when unavailable. */
  resolve(): AStudioCredential
}

/** The credential type — a bearer token string or undefined. */
export type AStudioCredential = string | undefined

/** Options for constructing the store. */
export interface AStudioAuthOptions {
  /** Override the config path (used by tests). */
  configPath?: string
}

/**
 * Read the bearer token from config.toml.
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
 * Create a credential store that reads from config.toml and caches the result
 * in memory. The cache is populated once on the first `resolve()` call;
 * subsequent calls return the same value. Call `invalidate()` to force a re-read
 * (e.g. after the user re-logs in).
 */
export function createAStudioAuth(options: AStudioAuthOptions = {}): AStudioCredentialStore & {
  invalidate: () => void
} {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH
  let cached: AStudioCredential | null = null

  return {
    resolve(): AStudioCredential {
      if (cached !== null) return cached
      cached = readTokenFromConfig(configPath)
      return cached
    },
    invalidate(): void {
      cached = null
    },
  }
}
