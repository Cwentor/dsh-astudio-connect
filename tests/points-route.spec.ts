import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { astudioPointsHandler } from '../src/points-route.ts'
import type { AStudioPointsClient, AStudioPointsResult } from '../src/points.ts'
import { ASTRO_POINTS_PATH } from '../src/status-paths.ts'

/**
 * The badge's same-origin read route: loopback Host and Origin only, GET only,
 * and nothing but numbers and a status in the answer — the account credential
 * stays on the host side.
 */

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
})

function stubClient(result: AStudioPointsResult, onRead?: (options: { fresh?: boolean }) => void): AStudioPointsClient {
  return {
    async read(options = {}) {
      onRead?.(options)
      return result
    },
  }
}

async function startServer(client: AStudioPointsClient): Promise<number> {
  const server = createServer(astudioPointsHandler({ client }))
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  CLEANUP.push(async () => { await new Promise<void>(resolve => { server.close(() => resolve()) }) })
  return (server.address() as AddressInfo).port
}

function requestOnce(port: number, options: { method?: string, path?: string, headers?: Record<string, string> }): Promise<{ status: number, body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      host: '127.0.0.1',
      port,
      method: options.method ?? 'GET',
      path: options.path ?? ASTRO_POINTS_PATH,
      headers: options.headers ?? {},
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    outgoing.on('error', reject)
    outgoing.end()
  })
}

const OK_BALANCE: AStudioPointsResult = {
  status: 'ok',
  general: { remaining: 1393, total: 2500 },
  spark: { remaining: 24621, total: 30000 },
}

describe('the points route', () => {
  it('answers a loopback GET with both pools', async () => {
    const port = await startServer(stubClient(OK_BALANCE))
    const { status, body } = await requestOnce(port, { headers: { host: `127.0.0.1:${String(port)}` } })
    expect(status).toBe(200)
    expect(JSON.parse(body)).toEqual(OK_BALANCE)
  })

  it('rejects a non-loopback Host (DNS-rebinding page)', async () => {
    const port = await startServer(stubClient(OK_BALANCE))
    const { status } = await requestOnce(port, { headers: { host: 'evil.example' } })
    expect(status).toBe(403)
  })

  it('rejects a non-loopback Origin beside a loopback Host', async () => {
    const port = await startServer(stubClient(OK_BALANCE))
    const { status } = await requestOnce(port, {
      headers: { host: `127.0.0.1:${String(port)}`, origin: 'https://evil.example' },
    })
    expect(status).toBe(403)
  })

  it('accepts the host page origin on the same port', async () => {
    const port = await startServer(stubClient(OK_BALANCE))
    const { status } = await requestOnce(port, {
      headers: { host: `127.0.0.1:${String(port)}`, origin: `http://127.0.0.1:${String(port)}` },
    })
    expect(status).toBe(200)
  })

  it('rejects non-GET methods', async () => {
    const port = await startServer(stubClient(OK_BALANCE))
    const { status } = await requestOnce(port, { method: 'POST', headers: { host: `127.0.0.1:${String(port)}` } })
    expect(status).toBe(405)
  })

  it('asks the client for a fresh read when the caller passes refresh=1', async () => {
    const seen: Array<{ fresh?: boolean }> = []
    const port = await startServer(stubClient(OK_BALANCE, options => { seen.push(options) }))
    await requestOnce(port, { path: `${ASTRO_POINTS_PATH}?refresh=1`, headers: { host: `127.0.0.1:${String(port)}` } })
    expect(seen).toEqual([{ fresh: true }])
  })

  it('uses the cached read when the caller does not ask to refresh', async () => {
    const seen: Array<{ fresh?: boolean }> = []
    const port = await startServer(stubClient(OK_BALANCE, options => { seen.push(options) }))
    await requestOnce(port, { headers: { host: `127.0.0.1:${String(port)}` } })
    expect(seen).toEqual([{ fresh: false }])
  })

  it('answers every unhealthy state as a well-formed document', async () => {
    for (const state of ['signed-out', 'expired', 'unavailable'] as const) {
      const port = await startServer(stubClient({ status: state }))
      const { status, body } = await requestOnce(port, { headers: { host: `127.0.0.1:${String(port)}` } })
      expect(status).toBe(200)
      expect(JSON.parse(body)).toEqual({ status: state })
    }
  })

  it('never carries the account credential in its answer', async () => {
    const port = await startServer(stubClient(OK_BALANCE))
    const { body } = await requestOnce(port, { headers: { host: `127.0.0.1:${String(port)}` } })
    expect(body).not.toContain('sso')
    expect(body).not.toContain('cookie')
    expect(body).not.toContain('token')
  })
})
