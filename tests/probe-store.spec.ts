import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createAStudioProbeStore } from '../src/probe-store.ts'

let path: string

beforeEach(() => {
  path = join(mkdtempSync(join(tmpdir(), 'astudio-probe-')), 'probe.json')
})

describe('AStudio probe store', () => {
  it('saves and reads one validating record', async () => {
    const store = createAStudioProbeStore(path)
    await store.put({ account: 'astudio-local', modelId: 'spark-x2.5', validation: 'validating', efforts: ['low', 'high'], expiresAtMs: Date.now() + 60_000 })
    const record = store.get('astudio-local', 'spark-x2.5')
    expect(record?.validation).toBe('validating')
    expect(record?.efforts).toEqual(['low', 'high'])
  })

  it('does not return expired records', async () => {
    const store = createAStudioProbeStore(path)
    await store.put({ account: 'astudio-local', modelId: 'spark-x2.5', validation: 'validating', efforts: ['low'], expiresAtMs: Date.now() - 1 })
    expect(store.get('astudio-local', 'spark-x2.5')).toBeUndefined()
  })

  it('clears records for one account without touching others', async () => {
    const store = createAStudioProbeStore(path)
    await store.put({ account: 'astudio-local', modelId: 'spark-x2.5', validation: 'validating', efforts: ['low'], expiresAtMs: Date.now() + 60_000 })
    await store.put({ account: 'astudio-local', modelId: 'xopglm52', validation: 'validating', efforts: ['high'], expiresAtMs: Date.now() + 60_000 })
    await store.clear('astudio-local')
    expect(store.get('astudio-local', 'spark-x2.5')).toBeUndefined()
    expect(store.get('astudio-local', 'xopglm52')).toBeUndefined()
  })
})
