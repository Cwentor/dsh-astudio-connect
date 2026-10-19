import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createAStudioAuth, readTokenFromConfig } from '../src/auth.ts'
import { writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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
    const store = createAStudioAuth({ configPath: testFile })
    expect(store.resolve()).toBe(TOKEN_VALUE)
    expect(store.resolve()).toBe(TOKEN_VALUE)
  })

  it('returns undefined when file is missing', () => {
    const store = createAStudioAuth({ configPath: testFile })
    expect(store.resolve()).toBeUndefined()
    expect(store.resolve()).toBeUndefined()
  })

  it('invalidate forces a re-read', () => {
    writeFileSync(testFile, CONFIG_CONTENT, 'utf8')
    const store = createAStudioAuth({ configPath: testFile })
    expect(store.resolve()).toBe(TOKEN_VALUE)

    // Overwrite file with no token
    writeFileSync(testFile, 'no token here', 'utf8')
    expect(store.resolve()).toBe(TOKEN_VALUE) // still cached

    store.invalidate()
    expect(store.resolve()).toBeUndefined() // re-reads, finds nothing
  })

  it('reports the astron-session.json it reads alongside the resolved config', () => {
    // The points badge reads the account cookie from that same file, so the
    // store has to name it without the caller re-deriving AStudio's layout.
    const store = createAStudioAuth({ configPath: testFile })
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
    const store = createAStudioAuth({ configPath: testFile })
    const status = await store.status()
    expect(status.state).toBe('signed-out')
    expect(status.configPath).toBe(testFile)
    expect(status.hints.length).toBeGreaterThan(0)
  })

  it('status reports signed-in without exposing token material', async () => {
    writeFileSync(testFile, CONFIG_CONTENT, 'utf8')
    const store = createAStudioAuth({ configPath: testFile })
    const status = await store.status()
    expect(status.state).toBe('signed-in')
    expect(status.tokenLength).toBe(TOKEN_VALUE.length)
    expect(JSON.stringify(status)).not.toContain(TOKEN_VALUE)
  })

  it('logout clears the in-memory cache and keeps the config file', async () => {
    writeFileSync(testFile, CONFIG_CONTENT, 'utf8')
    const store = createAStudioAuth({ configPath: testFile })
    expect(store.resolve()).toBe(TOKEN_VALUE)
    await store.logout()
    writeFileSync(testFile, 'no token here', 'utf8')
    expect(store.resolve()).toBeUndefined()
    expect(existsSync(testFile)).toBe(true)
  })
})
