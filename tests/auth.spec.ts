import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readTokenFromConfig } from '../src/auth.ts'
import { testAuth } from './support/auth.ts'
import { writeFileSync, unlinkSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeLoginSession } from '../src/login-session.ts'

const TOKEN_VALUE = '16c814c_test_token_for_unit_tests'
const CONFIG_CONTENT = `[model_providers.astron-spark]
base_url = "https://maas-api.cn-huabei-1.xf-yun.com/v1"
wire_api = "responses"
experimental_bearer_token = "${TOKEN_VALUE}"
`

describe('readTokenFromConfig', () => {
  let testFile: string

  beforeEach(() => {
    testFile = join(tmpdir(), `astudio-test-${Date.now()}.toml`)
  })

  afterEach(() => {
    if (existsSync(testFile)) unlinkSync(testFile)
  })

  it('returns the token when the file exists and the field is present', () => {
    writeFileSync(testFile, CONFIG_CONTENT, 'utf8')
    expect(readTokenFromConfig(testFile)).toBe(TOKEN_VALUE)
  })

  it('returns undefined when the file is missing', () => {
    expect(readTokenFromConfig(testFile)).toBeUndefined()
  })

  it('returns undefined when the file has no token field', () => {
    writeFileSync(testFile, '[model_providers.astron-spark]\nbase_url = "x"\n', 'utf8')
    expect(readTokenFromConfig(testFile)).toBeUndefined()
  })

  it('returns undefined when the token field is empty', () => {
    writeFileSync(testFile, 'experimental_bearer_token = ""', 'utf8')
    expect(readTokenFromConfig(testFile)).toBeUndefined()
  })

  it('handles multiline config correctly', () => {
    const multiline = `# AStudio config
[model_providers.astron-spark]
base_url = "https://maas-api.cn-huabei-1.xf-yun.com/v1"
wire_api = "responses"
supports_websockets = true
namespace_tools = true
experimental_bearer_token = "${TOKEN_VALUE}"

[other_section]
key = "value"
`
    writeFileSync(testFile, multiline, 'utf8')
    expect(readTokenFromConfig(testFile)).toBe(TOKEN_VALUE)
  })
})

describe('createAStudioAuth', () => {
  let testFile: string

  beforeEach(() => {
    testFile = join(tmpdir(), `astudio-test-${Date.now()}.toml`)
  })

  afterEach(() => {
    if (existsSync(testFile)) unlinkSync(testFile)
  })

  it('caches the token on first resolve', () => {
    writeFileSync(testFile, CONFIG_CONTENT, 'utf8')
    const store = testAuth({ configPath: testFile })
    expect(store.resolve()).toBe(TOKEN_VALUE)
    expect(store.resolve()).toBe(TOKEN_VALUE)
  })

  it('returns undefined when file is missing', () => {
    const store = testAuth({ configPath: testFile })
    expect(store.resolve()).toBeUndefined()
    expect(store.resolve()).toBeUndefined()
  })

  it('invalidate forces a re-read', () => {
    writeFileSync(testFile, CONFIG_CONTENT, 'utf8')
    const store = testAuth({ configPath: testFile })
    expect(store.resolve()).toBe(TOKEN_VALUE)

    // Overwrite file with no token
    writeFileSync(testFile, 'no token here', 'utf8')
    expect(store.resolve()).toBe(TOKEN_VALUE) // still cached

    store.invalidate()
    expect(store.resolve()).toBeUndefined() // re-reads, finds nothing
  })

  it('reports the astron-session.json it reads alongside the resolved config', () => {
    // The points section reads the account cookie from that same file, so the
    // store has to name it without the caller re-deriving AStudio's layout.
    const store = testAuth({ configPath: testFile })
    expect(store.sessionPath()).toMatch(/userdata[\\/]astron-session\.json$/u)
  })
})

describe('auth status and logout', () => {
  let testFile: string

  beforeEach(() => {
    testFile = join(tmpdir(), `astudio-test-${Date.now()}.toml`)
  })

  afterEach(() => {
    if (existsSync(testFile)) unlinkSync(testFile)
  })

  it('status reports signed-out with config path when no token is available', async () => {
    const store = testAuth({ configPath: testFile })
    const status = await store.status()
    expect(status.state).toBe('signed-out')
    expect(status.configPath).toBe(testFile)
    expect(status.hints.length).toBeGreaterThan(0)
  })

  it('status reports signed-in without exposing token material', async () => {
    writeFileSync(testFile, CONFIG_CONTENT, 'utf8')
    const store = testAuth({ configPath: testFile })
    const status = await store.status()
    expect(status.state).toBe('signed-in')
    expect(status.tokenLength).toBe(TOKEN_VALUE.length)
    expect(JSON.stringify(status)).not.toContain(TOKEN_VALUE)
  })

  it('logout clears the in-memory cache and keeps the config file', async () => {
    writeFileSync(testFile, CONFIG_CONTENT, 'utf8')
    const store = testAuth({ configPath: testFile })
    expect(store.resolve()).toBe(TOKEN_VALUE)
    await store.logout()
    writeFileSync(testFile, 'no token here', 'utf8')
    expect(store.resolve()).toBeUndefined()
    expect(existsSync(testFile)).toBe(true)
  })
})

describe('the plugin\'s own sign-in', () => {
  let root: string
  let configFile: string
  let loginFile: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'astudio-own-login-'))
    // AStudio's own layout, so sessionPath() lands inside the same root.
    mkdirSync(join(root, 'runtime', 'acode-home'), { recursive: true })
    mkdirSync(join(root, 'userdata'), { recursive: true })
    configFile = join(root, 'runtime', 'acode-home', 'config.toml')
    loginFile = join(root, 'astudio-login.json')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function store(): ReturnType<typeof testAuth> {
    return testAuth({ configPath: configFile, loginSessionPath: loginFile })
  }

  /** The app's side of the story: a chat token plus a model key and cookie. */
  function writeClientSession(content: Record<string, unknown>): void {
    writeFileSync(join(root, 'userdata', 'astron-session.json'), JSON.stringify(content), 'utf8')
  }

  /** A sign-in of ours with no model key: signed in, but unusable for chat. */
  function ownSessionWithoutKey(): void {
    writeLoginSession({
      version: 1,
      accountId: 'acc-own',
      ssoSessionId: 'sso-own',
      nickname: 'own',
      loginMethod: 'wechat-qr',
      loggedInAt: '2026-11-02T13:00:00.000Z',
    }, loginFile)
  }

  function ownSession(overrides: Partial<Parameters<typeof writeLoginSession>[0]> = {}): void {
    writeLoginSession({
      version: 1,
      accountId: 'acc-own',
      ssoSessionId: 'sso-own',
      modelBearerToken: 'token-own',
      nickname: 'own',
      loginMethod: 'wechat-qr',
      loggedInAt: '2026-11-02T13:00:00.000Z',
      ...overrides,
    }, loginFile)
  }

  it('wins over the app\'s config.toml for both tokens', () => {
    writeFileSync(configFile, CONFIG_CONTENT, 'utf8')
    writeClientSession({ ssoSessionId: 'sso-app', modelBearerToken: 'model-app' })
    ownSession()
    const auth = store()
    expect(auth.resolve()).toBe('token-own')
    expect(auth.modelBearerToken()).toBe('token-own')
    expect(auth.ssoSessionId()).toBe('sso-own')
  })

  it('falls back to the app\'s files when there is no sign-in of ours', () => {
    writeFileSync(configFile, CONFIG_CONTENT, 'utf8')
    writeClientSession({ ssoSessionId: 'sso-app', modelBearerToken: 'model-app' })
    const auth = store()
    expect(auth.resolve()).toBe(TOKEN_VALUE)
    expect(auth.modelBearerToken()).toBe('model-app')
    expect(auth.ssoSessionId()).toBe('sso-app')
  })

  it('names the source in the sign-in summary, without either secret', () => {
    writeFileSync(configFile, CONFIG_CONTENT, 'utf8')
    ownSession()
    const described = store().login()
    expect(described).toEqual({
      source: 'dsh',
      accountId: 'acc-own',
      nickname: 'own',
      loggedInAt: '2026-11-02T13:00:00.000Z',
    })
    const serialized = JSON.stringify(described)
    expect(serialized).not.toContain('sso-own')
    expect(serialized).not.toContain('token-own')
  })

  it('reports the app as the source when only its files exist', () => {
    writeFileSync(configFile, CONFIG_CONTENT, 'utf8')
    writeClientSession({ accountId: 'acc-app', ssoSessionId: 'sso-app', loggedInAt: '2026-11-01T09:00:00.000Z' })
    expect(store().login()).toEqual({
      source: 'client',
      accountId: 'acc-app',
      loggedInAt: '2026-11-01T09:00:00.000Z',
    })
  })

  it('reports no source when neither side is signed in', () => {
    expect(store().login()).toEqual({ source: 'none' })
    expect(store().ssoSessionId()).toBeUndefined()
  })

  it('ignores a sign-in of ours that carries no model key', () => {
    // Signed in but unusable: falling back to the app keeps chat working, and
    // calling that "ours" would make the panel claim an account it cannot use.
    writeFileSync(configFile, CONFIG_CONTENT, 'utf8')
    ownSessionWithoutKey()
    const auth = store()
    expect(auth.resolve()).toBe(TOKEN_VALUE)
    expect(auth.login().source).toBe('client')
  })

  it('logout deletes our file and hands the question back to the app', async () => {
    writeFileSync(configFile, CONFIG_CONTENT, 'utf8')
    ownSession()
    const auth = store()
    expect(auth.resolve()).toBe('token-own')
    await auth.logout()
    expect(existsSync(loginFile)).toBe(false)
    expect(auth.resolve()).toBe(TOKEN_VALUE)
    expect(auth.login().source).toBe('client')
  })

  it('status reports the source it settled on', async () => {
    writeFileSync(configFile, CONFIG_CONTENT, 'utf8')
    ownSession()
    const status = await store().status()
    expect(status.state).toBe('signed-in')
    expect(status.source).toBe('dsh')
    expect(JSON.stringify(status)).not.toContain('token-own')
  })
})
