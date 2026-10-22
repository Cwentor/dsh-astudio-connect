import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { deleteCatalogSnapshot, readCatalogSnapshot, writeCatalogSnapshot } from '../src/catalog-store.ts'

let path: string

beforeEach(() => {
  path = join(mkdtempSync(join(tmpdir(), 'astudio-catalog-store-')), 'catalog.json')
})

describe('AStudio catalog store', () => {
  it('writes and reads a snapshot for one identity', async () => {
    await writeCatalogSnapshot(path, 'astudio-local', [{ id: 'spark-x2.5', name: 'Spark X2.5', reasoning: { supports: true }, contextWindow: 131072, maxTokens: 8192 }], Date.now())
    const snapshot = await readCatalogSnapshot(path, 'astudio-local')
    expect(snapshot?.models[0]?.id).toBe('spark-x2.5')
  })

  it('keeps snapshots for other identities', async () => {
    await writeCatalogSnapshot(path, 'astudio-local', [{ id: 'one', name: 'One', reasoning: { supports: false }, contextWindow: 1, maxTokens: 1 }], Date.now())
    await writeCatalogSnapshot(path, 'other', [{ id: 'two', name: 'Two', reasoning: { supports: false }, contextWindow: 1, maxTokens: 1 }], Date.now())
    const local = await readCatalogSnapshot(path, 'astudio-local')
    const other = await readCatalogSnapshot(path, 'other')
    expect(local?.models[0]?.id).toBe('one')
    expect(other?.models[0]?.id).toBe('two')
  })

  it('returns undefined for a missing identity and corrupt files', async () => {
    expect(await readCatalogSnapshot(path, 'astudio-local')).toBeUndefined()
    await writeCatalogSnapshot(path, 'astudio-local', [{ id: 'one', name: 'One', reasoning: { supports: false }, contextWindow: 1, maxTokens: 1 }], Date.now())
    await deleteCatalogSnapshot(path, 'astudio-local')
    expect(await readCatalogSnapshot(path, 'astudio-local')).toBeUndefined()
  })

  it('refuses a version 1 snapshot, whose rows may come from the old built-in roster', async () => {
    writeFileSync(path, JSON.stringify({
      version: 1,
      catalogs: {
        'astudio-local': {
          fetchedAtMs: Date.now(),
          models: [{ id: 'spark-x2.5-4b', name: 'Spark X2.5 4B', contextWindow: 1048576, maxTokens: 110000 }],
        },
      },
    }), 'utf8')
    expect(await readCatalogSnapshot(path, 'astudio-local')).toBeUndefined()

    // Writing over it drops the old rows instead of carrying them forward.
    await writeCatalogSnapshot(path, 'astudio-local', [], Date.now())
    const file = JSON.parse(readFileSync(path, 'utf8')) as { version: number, catalogs: Record<string, unknown> }
    expect(file.version).toBe(2)
    expect(file.catalogs['astudio-local']).toEqual({ fetchedAtMs: expect.any(Number), models: [] })
  })
})
