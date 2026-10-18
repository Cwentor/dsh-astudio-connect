import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createAStudioProbeService } from '../src/probe-service.ts'
import { probeBody, probeModel } from '../src/probe.ts'
import { createAStudioProbeStore } from '../src/probe-store.ts'

let path: string
let store: ReturnType<typeof createAStudioProbeStore>

beforeEach(() => {
  path = join(mkdtempSync(join(tmpdir(), 'astudio-probe-service-')), 'probe.json')
  store = createAStudioProbeStore(path)
})

describe('probe helpers', () => {
  it('builds a minimal probe body', () => {
    const body = probeBody('spark-x2.5', 'low', 'probe-sentinel')
    expect(body.model).toBe('spark-x2.5')
    expect(body.reasoning_effort).toBe('low')
    expect((body.messages as Array<{ content: string }>)[0]?.content).toBe('probe-sentinel')
  })
})

describe('probe service', () => {
  it('does not send a request without consent', async () => {
    const service = createAStudioProbeService({
      upstream: { chat: async () => { throw new Error('should not run') } },
      token: () => 'token',
      store,
    })
    const result = await service.probe('spark-x2.5', 'low', false)
    expect(result.state).toBe('unauthorized')
    expect(store.get('astudio-local', 'spark-x2.5')).toBeUndefined()
  })

  it('sends a probe and saves a validating observation on success', async () => {
    const service = createAStudioProbeService({
      upstream: {
        chat: async () => ({ ok: true, status: 200, kind: 'ok' as const, message: '', response: {} as Response }),
      },
      token: () => 'token',
      store,
    })
    const result = await service.probe('spark-x2.5', 'low', true)
    expect(result.state).toBe('ok')
    expect(result.validation).toBe('validating')
    expect(store.get('astudio-local', 'spark-x2.5')?.efforts).toEqual(['low'])
  })

  it('classifies an invalid_parameter_value rejection as non-validating', async () => {
    const service = createAStudioProbeService({
      upstream: {
        chat: async () => ({ ok: false, status: 400, kind: 'client' as const, message: 'invalid_parameter_value', response: {} as Response }),
      },
      token: () => 'token',
      store,
    })
    const result = await service.probe('spark-x2.5', 'low', true)
    expect(result.state).toBe('rejected')
    expect(result.validation).toBe('non-validating')
  })
})

describe('probeModel', () => {
  it('returns ok with a validating observation', async () => {
    const result = await probeModel({
      upstream: {
        chat: async () => ({ ok: true, status: 200, kind: 'ok' as const, message: '', response: {} as Response }),
      },
      token: 'token',
      modelId: 'spark-x2.5',
      effort: 'high',
    })
    expect(result.state).toBe('ok')
    expect(result.efforts).toEqual(['high'])
  })

  it('aborts a hanging probe after the timeout', async () => {
    const result = await probeModel({
      upstream: {
        chat: (_token, _body, signal) => new Promise((resolve) => {
          signal?.addEventListener('abort', () => {
            resolve({ ok: false, status: 0, kind: 'server', message: 'aborted', response: null as unknown as Response })
          })
        }),
      },
      token: 'token',
      modelId: 'spark-x2.5',
      effort: 'high',
      timeoutMs: 20,
    })
    expect(result.state).toBe('failed')
  })
})
