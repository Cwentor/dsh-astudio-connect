import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ASTRO_LOGIN_QR_PATH,
  ASTRO_LOGIN_QR_POLL_PATH,
  ASTRO_LOGOUT_PATH,
  astudioLogoutHandler,
  astudioQrPollHandler,
  astudioQrStartHandler,
  pollBodyFrom,
} from '../src/login-route.ts'
import type { AStudioLoginRouteOptions } from '../src/login-route.ts'
import type { AStudioQrLogin } from '../src/qr-login.ts'
import { ASTRO_CONTROL_KEY_HEADER } from '../src/status-paths.ts'
import type { AStudioWebLogin, AStudioWebQrPoll } from '../src/status-paths.ts'

/**
 * The sign-in routes. They are the plugin's heaviest write — a scan turns into a
 * stored credential that every other route then trusts — so the guards are the
 * point of this file: loopback Host, loopback Origin, and the in-process key, on
 * all three of them.
 */

const KEY = 'a'.repeat(48)

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
})

const LOGIN: AStudioWebLogin = { source: 'dsh', accountId: 'acc-1', loggedInAt: '2026-11-02T13:00:00.000Z' }

/** A QR client whose answers the test dictates, plus a record of what it saw. */
function stubClient(answer: AStudioWebQrPoll = { status: 'pending' }) {
  const polls: Array<{ fd: string, accountId?: string }> = []
  let starts = 0
  const client: AStudioQrLogin = {
    async start() {
      starts += 1
      return { status: 'ok', fd: 'ABCD2345', image: 'data:image/jpg;base64,AAA', expiresAtMs: 1_700_000_060_000 }
    },
    async poll(input) {
      polls.push(input)
      return answer
    },
  }
  return { client, polls, starts: () => starts }
}

/** Mount all three routes on one server, so path routing is exercised too. */
async function startServer(options: AStudioLoginRouteOptions): Promise<number> {
  const routes: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> = {
    [ASTRO_LOGIN_QR_PATH]: astudioQrStartHandler(options, KEY),
    [ASTRO_LOGIN_QR_POLL_PATH]: astudioQrPollHandler(options, KEY),
    [ASTRO_LOGOUT_PATH]: astudioLogoutHandler(options, KEY),
  }
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    const handler = routes[path]
    if (handler === undefined) {
      res.writeHead(404).end()
      return
    }
    void handler(req, res)
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  CLEANUP.push(async () => { await new Promise<void>(resolve => { server.close(() => resolve()) }) })
  return (server.address() as AddressInfo).port
}

function call(
  port: number,
  path: string,
  options: { method?: string, headers?: Record<string, string>, body?: string } = {},
): Promise<{ status: number, body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      host: '127.0.0.1',
      port,
      method: options.method ?? 'POST',
      path,
      headers: options.headers ?? {},
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    outgoing.on('error', reject)
    outgoing.end(options.body)
  })
}

/** Headers a same-origin press from the settings panel sends. */
function browserHeaders(port: number): Record<string, string> {
  return {
    host: `127.0.0.1:${String(port)}`,
    origin: `http://127.0.0.1:${String(port)}`,
    'content-type': 'application/json',
    [ASTRO_CONTROL_KEY_HEADER]: KEY,
  }
}

describe('the sign-in routes', () => {
  it('mints a ticket for a guarded same-origin press', async () => {
    const stub = stubClient()
    const port = await startServer({ client: stub.client, signOut: async () => {} })
    const { status, body } = await call(port, ASTRO_LOGIN_QR_PATH, { headers: browserHeaders(port) })
    expect(status).toBe(200)
    expect(JSON.parse(body)).toMatchObject({ status: 'ok', fd: 'ABCD2345' })
    expect(stub.starts()).toBe(1)
  })

  it('passes the ticket and the chosen account through to the client', async () => {
    const stub = stubClient()
    const port = await startServer({ client: stub.client, signOut: async () => {} })
    const { status, body } = await call(port, ASTRO_LOGIN_QR_POLL_PATH, {
      headers: browserHeaders(port),
      body: JSON.stringify({ fd: 'ABCD2345', accountId: 'acc-2' }),
    })
    expect(status).toBe(200)
    expect(JSON.parse(body)).toEqual({ status: 'pending' })
    expect(stub.polls).toEqual([{ fd: 'ABCD2345', accountId: 'acc-2' }])
  })

  it('reports a finished sign-in and tells the host to re-read what it cached', async () => {
    const stub = stubClient({ status: 'authenticated', login: LOGIN })
    const seen: AStudioWebLogin[] = []
    const port = await startServer({
      client: stub.client,
      signOut: async () => {},
      onAuthenticated: (login) => { seen.push(login) },
    })
    const { status, body } = await call(port, ASTRO_LOGIN_QR_POLL_PATH, {
      headers: browserHeaders(port),
      body: JSON.stringify({ fd: 'ABCD2345' }),
    })
    expect(status).toBe(200)
    expect(JSON.parse(body)).toEqual({ status: 'authenticated', login: LOGIN })
    expect(seen).toEqual([LOGIN])
  })

  it('still answers a good sign-in when the host callback throws', async () => {
    const stub = stubClient({ status: 'authenticated', login: LOGIN })
    const port = await startServer({
      client: stub.client,
      signOut: async () => {},
      onAuthenticated: () => { throw new Error('catalog refresh exploded') },
    })
    const { status, body } = await call(port, ASTRO_LOGIN_QR_POLL_PATH, {
      headers: browserHeaders(port),
      body: JSON.stringify({ fd: 'ABCD2345' }),
    })
    // The credential is already on disk; a post-commit failure must not read as
    // a failed scan, or the panel would ask for another code for nothing.
    expect(status).toBe(200)
    expect(JSON.parse(body).status).toBe('authenticated')
  })

  it('rejects a poll that names no ticket', async () => {
    const stub = stubClient()
    const port = await startServer({ client: stub.client, signOut: async () => {} })
    const { status } = await call(port, ASTRO_LOGIN_QR_POLL_PATH, {
      headers: browserHeaders(port),
      body: JSON.stringify({ accountId: 'acc-1' }),
    })
    expect(status).toBe(400)
    expect(stub.polls).toEqual([])
  })

  it('rejects a poll body that is not JSON, or is too large to be one', async () => {
    const stub = stubClient()
    const port = await startServer({ client: stub.client, signOut: async () => {} })
    const notJson = await call(port, ASTRO_LOGIN_QR_POLL_PATH, { headers: browserHeaders(port), body: 'fd=' })
    expect(notJson.status).toBe(400)
    const huge = await call(port, ASTRO_LOGIN_QR_POLL_PATH, {
      headers: browserHeaders(port),
      body: JSON.stringify({ fd: 'ABCD2345', padding: 'x'.repeat(4_000) }),
    })
    expect(huge.status).toBe(400)
    expect(stub.polls).toEqual([])
  })

  it('signs out and tells the host, answering a plain status', async () => {
    let signedOut = 0
    const notified: number[] = []
    const port = await startServer({
      client: stubClient().client,
      signOut: async () => { signedOut += 1 },
      onSignedOut: () => { notified.push(1) },
    })
    const { status, body } = await call(port, ASTRO_LOGOUT_PATH, { headers: browserHeaders(port) })
    expect(status).toBe(200)
    expect(JSON.parse(body)).toEqual({ status: 'ok' })
    expect(signedOut).toBe(1)
    expect(notified).toHaveLength(1)
  })

  it('guards all three routes against a non-loopback Host', async () => {
    const stub = stubClient()
    let signedOut = 0
    const port = await startServer({
      client: stub.client,
      signOut: async () => { signedOut += 1 },
    })
    for (const path of [ASTRO_LOGIN_QR_PATH, ASTRO_LOGIN_QR_POLL_PATH, ASTRO_LOGOUT_PATH]) {
      const { status } = await call(port, path, {
        headers: { ...browserHeaders(port), host: 'evil.example' },
        body: JSON.stringify({ fd: 'ABCD2345' }),
      })
      expect(status).toBe(403)
    }
    expect(stub.starts()).toBe(0)
    expect(signedOut).toBe(0)
  })

  it('guards all three routes against a cross-site Origin', async () => {
    const stub = stubClient()
    const port = await startServer({ client: stub.client, signOut: async () => {} })
    for (const path of [ASTRO_LOGIN_QR_PATH, ASTRO_LOGIN_QR_POLL_PATH, ASTRO_LOGOUT_PATH]) {
      const { status } = await call(port, path, {
        headers: { ...browserHeaders(port), origin: 'https://evil.example' },
        body: JSON.stringify({ fd: 'ABCD2345' }),
      })
      expect(status).toBe(403)
    }
    expect(stub.starts()).toBe(0)
  })

  it('refuses a caller that never received the control key', async () => {
    const stub = stubClient()
    const port = await startServer({ client: stub.client, signOut: async () => {} })
    const headers = browserHeaders(port)
    delete headers[ASTRO_CONTROL_KEY_HEADER]
    const { status } = await call(port, ASTRO_LOGIN_QR_PATH, { headers })
    // Loopback alone is not authentication: a local process can send it too.
    expect(status).toBe(403)
    expect(stub.starts()).toBe(0)
  })

  it('refuses the wrong control key on the poll, which is the writing one', async () => {
    const stub = stubClient()
    const port = await startServer({ client: stub.client, signOut: async () => {} })
    const { status } = await call(port, ASTRO_LOGIN_QR_POLL_PATH, {
      headers: { ...browserHeaders(port), [ASTRO_CONTROL_KEY_HEADER]: 'b'.repeat(48) },
      body: JSON.stringify({ fd: 'ABCD2345' }),
    })
    expect(status).toBe(403)
    expect(stub.polls).toEqual([])
  })

  it('accepts POST only', async () => {
    const stub = stubClient()
    const port = await startServer({ client: stub.client, signOut: async () => {} })
    const { status } = await call(port, ASTRO_LOGIN_QR_PATH, { method: 'GET', headers: browserHeaders(port) })
    expect(status).toBe(405)
  })

  it('never echoes the control key or the ticket image in an error', async () => {
    const stub = stubClient()
    const port = await startServer({ client: stub.client, signOut: async () => {} })
    const { body } = await call(port, ASTRO_LOGIN_QR_POLL_PATH, {
      headers: { ...browserHeaders(port), [ASTRO_CONTROL_KEY_HEADER]: 'b'.repeat(48) },
      body: JSON.stringify({ fd: 'ABCD2345' }),
    })
    expect(body).not.toContain(KEY)
    expect(body).not.toContain('b'.repeat(48))
  })
})

describe('pollBodyFrom', () => {
  it('reads the ticket and the optional account', () => {
    expect(pollBodyFrom('{"fd":"ABCD2345"}')).toEqual({ fd: 'ABCD2345' })
    expect(pollBodyFrom('{"fd":" ABCD2345 ","accountId":" acc-1 "}')).toEqual({
      fd: 'ABCD2345',
      accountId: 'acc-1',
    })
  })

  it('refuses anything else, including a blank ticket', () => {
    expect(pollBodyFrom(undefined)).toBeUndefined()
    expect(pollBodyFrom('')).toBeUndefined()
    expect(pollBodyFrom('null')).toBeUndefined()
    expect(pollBodyFrom('[]')).toBeUndefined()
    expect(pollBodyFrom('{"fd":""}')).toBeUndefined()
    expect(pollBodyFrom('{"fd":42}')).toBeUndefined()
  })
})
