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
})
