/**
 * AStudio credential store. Reads the chat bearer token from the AStudio
 * runtime config.toml and the model-manager token from astron-session.json,
 * caches both in memory, and never writes to disk.
 *
 * Both files live under one AStudio data root, discovered per platform rather
 * than assumed at a fixed absolute path; see ./locations.ts.
 *
 * A sign-in this plugin performed itself (`./login-session.ts`, from the QR
 * flow) takes precedence over both files. That is the point of the QR flow:
 * with no app installed there is no config.toml to read, and with one installed
 * the person who signed in here has already said which account to use.
 * Signing out of it falls back to the app's files.
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
import type { AStudioDailyRewardCredentials } from './daily-reward.ts'
import type { AStudioLoginSession } from './login-session.ts'
import { astudioLoginSessionPath, clearLoginSession, describeLoginSession, readLoginSession } from './login-session.ts'
import type { AStudioWebLogin } from './status-paths.ts'

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
  /** Which of the two sources the credential came from. */
  source: AStudioWebLogin['source']
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
  /**
   * The plugin's own sign-in file (see `./login-session.ts`).
   *
   * Defaults to {@link astudioLoginSessionPath}, under the DSH home. Overridable
   * so tests — and anyone running two DSH profiles — can point it elsewhere.
   */
  loginSessionPath?: string
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
 * Read one string field out of astron-session.json.
 *
 * Returns undefined for a missing file, malformed JSON, an absent field, or a
 * blank value — every one of which means "the app has not signed in", a normal
 * state rather than an error.
 */
function readSessionField(sessionPath: string, field: string): AStudioCredential {
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
  const value = (parsed as Record<string, unknown>)[field]
  if (typeof value !== 'string' || value.trim() === '') return undefined
  return value.trim()
}

/**
 * Read the model-manager token from astron-session.json.
 *
 * AStudio issues this separately from the chat token; it authenticates the
 * model-manager API that serves the authoritative roster.
 */
export function readModelBearerToken(sessionPath: string): AStudioCredential {
  return readSessionField(sessionPath, 'modelBearerToken')
}

/**
 * Read the account cookie from astron-session.json.
 *
 * The balance, popup and model-config APIs authenticate with this cookie rather
 * than with either bearer token.
 */
export function readClientSsoSessionId(sessionPath: string): AStudioCredential {
  return readSessionField(sessionPath, 'ssoSessionId')
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
 *
 * The plugin's own sign-in is read on every call rather than cached. It is one
 * small file, and it is the one credential that can change without this store
 * being told: a person scanning a code, or signing out, has to take effect on
 * the next read, not on the next restart.
 */
export function createAStudioAuth(options: AStudioAuthOptions = {}) {
  const dataHome = options.dataHome
  const explicitConfig = options.configPath
  const loginPath = options.loginSessionPath ?? astudioLoginSessionPath()
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

  /** The plugin's own sign-in, if any. */
  const own = (): AStudioLoginSession | undefined => readLoginSession(loginPath)

  /** The app's chat token, from config.toml. Cached: only AStudio rewrites it. */
  const clientToken = (): AStudioCredential => {
    if (cachedToken !== null) return cachedToken
    cachedToken = readTokenFromConfig(configPath())
    return cachedToken
  }

  /** The app's model key, from astron-session.json. Cached for the same reason. */
  const clientModelToken = (): AStudioCredential => {
    if (cachedModelToken !== null) return cachedModelToken
    cachedModelToken = readModelBearerToken(sessionPath())
    return cachedModelToken
  }

  /**
   * Which source the credential came from.
   *
   * `dsh` and `client` are decided by whether our own file holds a usable key —
   * an own sign-in that somehow lacks one does not make the app's token "ours".
   */
  const login = (): AStudioWebLogin => {
    const session = own()
    if (session !== undefined && session.modelBearerToken !== undefined) return describeLoginSession(session)
    const token = clientToken()
    if (token === undefined) return { source: 'none' }
    const accountId = readSessionField(sessionPath(), 'accountId')
    const loggedInAt = readSessionField(sessionPath(), 'loggedInAt')
    return {
      source: 'client',
      ...(accountId === undefined ? {} : { accountId }),
      ...(loggedInAt === undefined ? {} : { loggedInAt }),
    }
  }

  /** The chat token in use: our own sign-in wins over the app's. */
  const resolvedToken = (): AStudioCredential => own()?.modelBearerToken ?? clientToken()

  /**
   * The cookie parts the account APIs authenticate with.
   *
   * The desktop client sends all four cookies (`ssoSessionId`, `sso_sessionid`,
   * `account_id`, `token`) on every account call, and the reward endpoints are
   * the ones that care about the extra two: `pending` is written against an
   * identified account, not just a session. `token` is missing for a sign-in
   * this plugin made itself — the QR exchange returns a model key, not an
   * account token — so it is omitted rather than faked.
   */
  const claimCredentials = (): AStudioDailyRewardCredentials | undefined => {
    const session = own()
    if (session !== undefined) {
      return { ssoSessionId: session.ssoSessionId, accountId: session.accountId }
    }
    const ssoSessionId = readClientSsoSessionId(sessionPath())
    if (ssoSessionId === undefined) return undefined
    const accountId = readSessionField(sessionPath(), 'accountId')
    const token = readSessionField(sessionPath(), 'token')
    return {
      ssoSessionId,
      ...(accountId === undefined ? {} : { accountId }),
      ...(token === undefined ? {} : { token }),
    }
  }
  /** The model key in use, with the same precedence. */
  const resolvedModelToken = (): AStudioCredential => own()?.modelBearerToken ?? clientModelToken()

  return {
    resolve(): AStudioCredential {
      return resolvedToken()
    },
    modelBearerToken(): AStudioCredential {
      return resolvedModelToken()
    },
    /**
     * The account cookie the balance, popup and claim routes authenticate with.
     *
     * Resolved here because this is the module that knows both places a
     * credential can live; a caller that re-derived it would have to know the
     * precedence too.
     */
    ssoSessionId(): AStudioCredential {
      return own()?.ssoSessionId ?? readClientSsoSessionId(sessionPath())
    },
    /**
     * The same credential, in the shape the claim's cookie needs.
     *
     * Separate from {@link ssoSessionId} because the reward endpoints want the
     * account identified by cookie rather than by session alone, and only this
     * module knows where the account id and token live.
     */
    claimCredentials(): AStudioDailyRewardCredentials | undefined {
      return claimCredentials()
    },
    /**
     * The `astron-session.json` this store reads the app's credentials from.
     *
     * Still reported for the status card, which names the file it looked at —
     * not used for the plugin's own sign-in.
     */
    sessionPath(): string {
      return sessionPath()
    },
    /** The file the plugin's own sign-in lives in, for diagnostics. */
    loginSessionPath(): string {
      return loginPath
    },
    /** Which sign-in is in use, in UI-safe terms. */
    login,
    invalidate(): void {
      cachedToken = null
      cachedModelToken = null
    },
    async status(): Promise<AStudioAuthStatus> {
      const source = login().source
      const token = resolvedToken()
      if (token === undefined) {
        return {
          state: 'signed-out',
          configPath: configPath(),
          source,
          hints: [
            source === 'none'
              ? 'No sign-in found: neither this plugin nor the AStudio app holds a credential. Sign in from the AStudio points section, or open AStudio.'
              : 'A sign-in was found but carries no model key; re-run the QR sign-in or open AStudio.',
          ],
        }
      }
      const hasModelToken = resolvedModelToken() !== undefined
      return {
        state: 'signed-in',
        configPath: configPath(),
        tokenLength: token.length,
        hasModelToken,
        source,
        hints: hasModelToken
          ? []
          : ['No model key is available; no model list can be read, so no models will be offered.'],
      }
    },
    /**
     * Forget the plugin's own sign-in.
     *
     * Only our file is deleted — the app's session is the app's to clear. After
     * this the store falls back to whatever AStudio has on disk, which is why
     * `invalidate()` follows: the cached fallback may predate this call.
     */
    async logout(): Promise<void> {
      clearLoginSession(loginPath)
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
