import { describe, it, expect } from 'vitest'
import { apply, Config, ASTRO_PROVIDER, inject, ASTRO_SETTINGS_NS } from '../src/index.ts'
import type { Context } from '@deepseek-ai/cordis'
import { writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** Mock Context for testing the apply function. */
function createMockContext(): Context {
  const disposers: Array<() => void> = []
  const ctx = {
    logger: {
      info: (..._args: unknown[]) => {},
      warn: (..._args: unknown[]) => {},
      error: (..._args: unknown[]) => {},
    },
    llm: {
      registerAdapter: () => () => {},
    },
    effect: (fn: () => () => void) => {
      disposers.push(fn())
    },
    dispose: (fn: () => void) => {
      disposers.push(fn)
    },
    _disposers: disposers,
  }
  return ctx as unknown as Context
}

describe('apply', () => {
  it('exports Config schema', () => {
    expect(Config).toBeDefined()
    expect(Config.type).toBe('object')
  })

  it('exports ASTRO_PROVIDER constant', () => {
    expect(ASTRO_PROVIDER).toBe('astudio')
  })

  it('exports inject as llm seam', () => {
    expect(inject).toEqual(['llm'])
  })

  it('exports ASTRO_SETTINGS_NS', () => {
    expect(ASTRO_SETTINGS_NS).toBe('astudio')
  })

  it('applies without throwing when config file exists', async () => {
    const testFile = join(tmpdir(), `astudio-index-test-${Date.now()}.toml`)
    writeFileSync(testFile, `experimental_bearer_token = "test_token"`, 'utf8')

    const ctx = createMockContext()
    try {
      expect(() => apply(ctx, { configPath: testFile })).not.toThrow()
    } finally {
      if (existsSync(testFile)) unlinkSync(testFile)
    }
  })

  it('applies without throwing when config file is missing', async () => {
    const ctx = createMockContext()
    expect(() => apply(ctx, { configPath: '/nonexistent/path.toml' })).not.toThrow()
  })

  it('applies with default config', () => {
    const ctx = createMockContext()
    expect(() => apply(ctx, {})).not.toThrow()
  })
})
