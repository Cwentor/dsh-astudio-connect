import { describe, it, expect } from 'vitest'
import { create, act } from 'react-test-renderer'
import AStudioSettingsPage, { desensitizeToken } from '../src/client/index.tsx'
import { createAStudioAuth } from '../src/auth.ts'
import { createAStudioCatalog, DEFAULT_CATALOG } from '../src/catalog.ts'
import { writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('desensitizeToken', () => {
  it('shows dash for undefined', () => {
    expect(desensitizeToken(undefined)).toBe('—')
  })

  it('shows full token when short', () => {
    expect(desensitizeToken('abc')).toBe('abc… (len=3)')
  })

  it('shows prefix and length for long tokens', () => {
    const token = '16c814c_test_token_for_unit_tests'
    const result = desensitizeToken(token)
    expect(result.startsWith('16c814c…')).toBe(true)
    expect(result).toContain(`len=${token.length}`)
  })

  it('does not contain the full token', () => {
    const token = '16c814c_test_token_for_unit_tests'
    const result = desensitizeToken(token)
    expect(result.includes(token)).toBe(false)
  })
})

function renderPage(store: ReturnType<typeof createAStudioAuth>, catalog: ReturnType<typeof createAStudioCatalog>) {
  let renderer: ReturnType<typeof create> | null = null
  act(() => {
    renderer = create(<AStudioSettingsPage store={store} catalog={catalog} />)
  })
  const json = renderer!.toJSON()
  return JSON.stringify(json)
}

describe('AStudioSettingsPage', () => {
  it('renders connected status with token', () => {
    const testFile = join(tmpdir(), `astudio-client-test-${Date.now()}.toml`)
    writeFileSync(testFile, `experimental_bearer_token = "16c814c_test_token"`, 'utf8')

    const store = createAStudioAuth({ configPath: testFile })
    const catalog = createAStudioCatalog({
      upstream: { chat: async () => { throw new Error('not used') } },
      token: () => store.resolve(),
    })

    const html = renderPage(store, catalog)

    expect(html).toContain('Connected')
    expect(html).toContain('16c814c…')
    expect(html).toContain('Models')
    expect(html).toContain(DEFAULT_CATALOG[0]?.name ?? '')

    if (existsSync(testFile)) unlinkSync(testFile)
  })

  it('renders not-connected status without token', () => {
    const store = createAStudioAuth({ configPath: '/nonexistent' })
    const catalog = createAStudioCatalog({
      upstream: { chat: async () => { throw new Error('not used') } },
      token: () => store.resolve(),
    })

    const html = renderPage(store, catalog)

    expect(html).toContain('Not connected')
    expect(html).toContain('—')
    expect(html).toContain('Models')
  })

  it('renders model list', () => {
    const store = createAStudioAuth({ configPath: '/nonexistent' })
    const catalog = createAStudioCatalog({
      upstream: { chat: async () => { throw new Error('not used') } },
      token: () => store.resolve(),
    })

    const html = renderPage(store, catalog)

    // All default models should appear
    for (const model of DEFAULT_CATALOG) {
      expect(html).toContain(model.name)
    }
  })
})
