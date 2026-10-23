import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { request } from 'node:http'
import { astudioProbeHandler } from '../src/probe-route.ts'
import { createControlKey } from '../src/control-key.ts'
import type { AStudioProbeService } from '../src/probe-service.ts'
import type { ProbeOutcome } from '../src/probe.ts'

let server: Server | undefined

async function withHandler(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>): Promise<number> {
  const srv = createServer((req, res) => {
    void handler(req, res)
  })
  server = srv
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as AddressInfo
      resolve(addr.port)
    })
  })
}

afterEach(async () => {
  if (server !== undefined) {
    const srv = server
    server = undefined
    await new Promise<void>((resolve) => srv.close(() => resolve()))
  }
})

function rawRequest(port: number, path: string, headers: Record<string, string>, body?: string, method = 'POST'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method, headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

function mockService(outcome: ProbeOutcome) {
  const calls: Array<{ modelId: string; effort: string; consent: boolean }> = []
  const service: AStudioProbeService = {
    probe: async (modelId, effort, consent) => {
      calls.push({ modelId, effort, consent })
      return outcome
    },
  }
  return { service, calls }
}

describe('astudioProbeHandler', () => {
  it('rejects non-POST requests', async () => {
    const key = createControlKey()
    const { service } = mockService({ state: 'ok', efforts: ['low'] })
    const port = await withHandler(astudioProbeHandler({ service }, key))
    const res = await rawRequest(port, '/astudio/probe/spark-x2.5', { Host: '127.0.0.1' }, undefined, 'GET')
    expect(res.status).toBe(405)
  })

  it('rejects non-loopback Host', async () => {
    const key = createControlKey()
    const { service } = mockService({ state: 'ok', efforts: ['low'] })
    const port = await withHandler(astudioProbeHandler({ service }, key))
    const res = await rawRequest(port, '/astudio/probe/spark-x2.5', { Host: 'evil.example.com' })
    expect(res.status).toBe(403)
  })

  it('rejects a missing control key', async () => {
    const key = createControlKey()
    const { service } = mockService({ state: 'ok', efforts: ['low'] })
    const port = await withHandler(astudioProbeHandler({ service }, key))
    const res = await rawRequest(port, '/astudio/probe/spark-x2.5', { Host: '127.0.0.1' })
    expect(res.status).toBe(403)
  })

  it('rejects a wrong control key', async () => {
    const key = createControlKey()
    const { service } = mockService({ state: 'ok', efforts: ['low'] })
    const port = await withHandler(astudioProbeHandler({ service }, key))
    const res = await rawRequest(port, '/astudio/probe/spark-x2.5', { Host: '127.0.0.1', 'x-astudio-control-key': 'wrong-key' })
    expect(res.status).toBe(403)
  })

  it('returns 404 when the model id is missing', async () => {
    const key = createControlKey()
    const { service } = mockService({ state: 'ok', efforts: ['low'] })
    const port = await withHandler(astudioProbeHandler({ service }, key))
    const res = await rawRequest(port, '/astudio/probe', { Host: '127.0.0.1', 'x-astudio-control-key': key })
    expect(res.status).toBe(404)
  })

  it('probes a model and returns the observation', async () => {
    const key = createControlKey()
    const { service, calls } = mockService({ state: 'ok', validation: 'validating', efforts: ['high'] })
    let invalidated = false
    const port = await withHandler(astudioProbeHandler({ service, invalidate: () => { invalidated = true } }, key))
    const res = await rawRequest(port, '/astudio/probe/spark-x2.5', { Host: '127.0.0.1', 'x-astudio-control-key': key })
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body) as { state: string; validation?: string; efforts: string[] }
    expect(body.state).toBe('ok')
    expect(body.validation).toBe('validating')
    expect(body.efforts).toEqual(['high'])
    expect(calls[0]).toEqual({ modelId: 'spark-x2.5', effort: 'low', consent: true })
    expect(invalidated).toBe(true)
  })

  it('honors an effort supplied in the body', async () => {
    const key = createControlKey()
    const { service, calls } = mockService({ state: 'ok', efforts: ['max'] })
    const port = await withHandler(astudioProbeHandler({ service }, key))
    const res = await rawRequest(
      port,
      '/astudio/probe/spark-x2.5',
      { Host: '127.0.0.1', 'x-astudio-control-key': key, 'Content-Type': 'application/json' },
      JSON.stringify({ effort: 'max' }),
    )
    expect(res.status).toBe(200)
    expect(calls[0]?.effort).toBe('max')
  })

  it('still accepts the pre-visibility probe key header', async () => {
    // A browser bundle loaded before the header was renamed outlives a host
    // restart inside the same tab; rejecting it would break probing until the
    // page reloads. Same secret, two names.
    const key = createControlKey()
    const { service, calls } = mockService({ state: 'ok', efforts: ['low'] })
    const port = await withHandler(astudioProbeHandler({ service }, key))
    const res = await rawRequest(port, '/astudio/probe/spark-x2.5', { Host: '127.0.0.1', 'x-astudio-probe-key': key })
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
  })

  it('does not leak token material', async () => {
    const key = createControlKey()
    const { service } = mockService({ state: 'ok', efforts: ['low'] })
    const port = await withHandler(astudioProbeHandler({ service }, key))
    const res = await rawRequest(port, '/astudio/probe/spark-x2.5', { Host: '127.0.0.1', 'x-astudio-control-key': key })
    expect(res.body).not.toContain('token')
    expect(res.body).not.toContain('Authorization')
  })
})
