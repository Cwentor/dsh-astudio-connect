import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { run } from '../src/bin.ts'

let stdout: string[]
let stderr: string[]
let testFile: string

beforeEach(() => {
  stdout = []
  stderr = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk))
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk))
    return true
  })
  testFile = join(tmpdir(), `astudio-bin-${Date.now()}.toml`)
})

afterEach(() => {
  vi.restoreAllMocks()
  if (existsSync(testFile)) unlinkSync(testFile)
})

/**
 * Isolate a run from the developer's own AStudio install.
 *
 * `status` now reports what a real fetch produced, and reads the model-manager
 * session plus the catalog snapshot from the machine it runs on. Without this
 * the test would answer from the signed-in desktop app next to it.
 */
function isolated(): { dataHome: string, catalogPath: string } {
  const dataHome = join(tmpdir(), `astudio-bin-home-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  return { dataHome, catalogPath: join(dataHome, 'catalog.json') }
}

describe('run', () => {
  it('status --json outputs an empty catalog when nothing can be fetched', async () => {
    writeFileSync(testFile, `experimental_bearer_token = "16c814c_test_token"`, 'utf8')
    const code = await run(['status', '--json'], { configPath: testFile, ...isolated() })
    expect(code).toBe(0)
    const body = JSON.parse(stdout.join('')) as { state: string; source: string; modelCount: number; failure?: string }
    expect(body.state).toBe('signed-in')
    // Nothing is served without a fetched roster: no built-in list, and no
    // placeholder standing in for one.
    expect(body.source).toBe('empty')
    expect(body.modelCount).toBe(0)
    expect(body.failure).toBe('no-model-token')
    expect(stdout.join('')).not.toContain('16c814c')
  })

  it('doctor outputs config path, file presence, and hints', async () => {
    writeFileSync(testFile, `experimental_bearer_token = "16c814c_test_token"`, 'utf8')
    const code = await run(['doctor'], { configPath: testFile })
    expect(code).toBe(0)
    const out = stdout.join('')
    expect(out).toContain(testFile)
    expect(out).toContain('present')
    expect(out).toContain('Sign-in state')
  })

  it('logout clears the cache and does not delete the config file', async () => {
    writeFileSync(testFile, `experimental_bearer_token = "16c814c_test_token"`, 'utf8')
    const code = await run(['logout'], { configPath: testFile })
    expect(code).toBe(0)
    expect(stdout.join('')).toContain('cleared')
    expect(existsSync(testFile)).toBe(true)
  })

  it('rejects a non-astudio --provider', async () => {
    const code = await run(['status', '--provider', 'workbuddy'], isolated())
    expect(code).toBe(1)
    expect(stderr.join('')).toContain('unknown provider')
  })

  it('status --json reports signed-out without a config file', async () => {
    const missing = join(tmpdir(), `astudio-bin-missing-${Date.now()}.toml`)
    const code = await run(['status', '--json'], { configPath: missing, ...isolated() })
    expect(code).toBe(1)
    const body = JSON.parse(stdout.join('')) as { state: string }
    expect(body.state).toBe('signed-out')
    if (existsSync(missing)) unlinkSync(missing)
  })
})
