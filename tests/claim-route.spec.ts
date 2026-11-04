import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { astudioClaimHandler } from '../src/claim-route.ts'
import type { AStudioDailyRewardClient } from '../src/daily-reward.ts'
import { ASTRO_CLAIM_PATH, ASTRO_CONTROL_KEY_HEADER } from '../src/status-paths.ts'
import type { AStudioWebClaim } from '../src/status-paths.ts'

/**
 * The claim route: the plugin's only account-side write. Loopback Host AND
 * loopback Origin AND the in-process control key — a booking made by another
 * page, or by a local process that never received the key, must not happen.
 */

const KEY = 'a'.repeat(48)

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
})

function stubClient(result: AStudioWebClaim, onClaim?: () => void): AStudioDailyRewardClient {
  return {
    async claim() {
      onClaim?.()
      return result
    },
  }
}

async function startServer(client: AStudioDailyRewardClient): Promise<number> {
  const server = createServer(astudioClaimHandler({ client }, KEY))
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  CLEANUP.push(async () => { await new Promise<void>(resolve => { server.close(() => resolve()) }) })
  return (server.address() as AddressInfo).port
}

function requestOnce(
  port: number,
  options: { method?: string, headers?: Record<string, string> } = {},
): Promise<{ status: number, body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      host: '127.0.0.1',
      port,
      method: options.method ?? 'POST',
      path: ASTRO_CLAIM_PATH,
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

/** Headers a same-origin press from the composer sends. */
function browserHeaders(port: number): Record<string, string> {
  return {
    host: `127.0.0.1:${String(port)}`,
    origin: `http://127.0.0.1:${String(port)}`,
    [ASTRO_CONTROL_KEY_HEADER]: KEY,
  }
}

const CLAIMED: AStudioWebClaim = {
  status: 'claimed',
  points: 100,
  balance: { status: 'ok', general: { remaining: 1493, total: 2500 } },
}

describe('the claim route', () => {
  it('answers a guarded same-origin press with the claim document', async () => {
    let claims = 0
    const port = await startServer(stubClient(CLAIMED, () => { claims += 1 }))
    const { status, body } = await requestOnce(port, { headers: browserHeaders(port) })
    expect(status).toBe(200)
    expect(JSON.parse(body)).toEqual(CLAIMED)
    expect(claims).toBe(1)
  })

  it('rejects a non-loopback Host (DNS-rebinding page) without claiming', async () => {
    let claims = 0
    const port = await startServer(stubClient(CLAIMED, () => { claims += 1 }))
    const { status } = await requestOnce(port, {
      headers: { ...browserHeaders(port), host: 'evil.example' },
    })
    expect(status).toBe(403)
    expect(claims).toBe(0)
  })

  it('rejects a cross-site Origin beside a loopback Host', async () => {
    let claims = 0
    const port = await startServer(stubClient(CLAIMED, () => { claims += 1 }))
    const { status } = await requestOnce(port, {
      headers: { ...browserHeaders(port), origin: 'https://evil.example' },
    })
    expect(status).toBe(403)
    expect(claims).toBe(0)
  })

  it('rejects a caller that never received the control key', async () => {
    let claims = 0
    const port = await startServer(stubClient(CLAIMED, () => { claims += 1 }))
    const headers = browserHeaders(port)
    delete headers[ASTRO_CONTROL_KEY_HEADER]
    const { status } = await requestOnce(port, { headers })
    // Loopback alone is not authentication: any local process can send it.
    expect(status).toBe(403)
    expect(claims).toBe(0)
  })

  it('rejects a wrong control key', async () => {
    const port = await startServer(stubClient(CLAIMED))
    const { status } = await requestOnce(port, {
      headers: { ...browserHeaders(port), [ASTRO_CONTROL_KEY_HEADER]: 'b'.repeat(48) },
    })
    expect(status).toBe(403)
  })

  it('rejects non-POST methods', async () => {
    const port = await startServer(stubClient(CLAIMED))
    const { status } = await requestOnce(port, { method: 'GET', headers: browserHeaders(port) })
    expect(status).toBe(405)
  })

  it('answers every unbooked state as a well-formed document', async () => {
    for (const state of ['already', 'none', 'signed-out', 'expired', 'unavailable'] as const) {
      const port = await startServer(stubClient({ status: state }))
      const { status, body } = await requestOnce(port, { headers: browserHeaders(port) })
      // A named state, not an error status: the badge renders what happened.
      expect(status).toBe(200)
      expect(JSON.parse(body)).toEqual({ status: state })
    }
  })

  it('never carries the account credential in its answer', async () => {
    const port = await startServer(stubClient(CLAIMED))
    const { body } = await requestOnce(port, { headers: browserHeaders(port) })
    expect(body).not.toContain('sso')
    expect(body).not.toContain('cookie')
    expect(body).not.toContain(KEY)
  })
})
