import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createServer, request } from 'node:http'
import type { IncomingMessage, ServerResponse, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { astudioVisibilityHandler } from '../src/visibility-route.ts'
import { createControlKey } from '../src/control-key.ts'
import { createAStudioVisibilityStore } from '../src/visibility-store.ts'
import type { AStudioCatalog, AStudioModelInfo } from '../src/catalog.ts'
import { ASTRO_LOCAL_IDENTITY } from '../src/identity.ts'

let server: Server | undefined
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'astudio-visibility-'))
})

afterEach(async () => {
  if (server !== undefined) {
    const srv = server
    server = undefined
    await new Promise<void>((resolve) => srv.close(() => resolve()))
  }
  await rm(dir, { recursive: true, force: true })
})

async function withHandler(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>): Promise<number> {
  const srv = createServer((req, res) => { void handler(req, res) })
  server = srv
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      resolve((srv.address() as AddressInfo).port)
    })
  })
}

function rawRequest(
  port: number,
  path: string,
  headers: Record<string, string>,
  body?: string,
  method = 'POST',
): Promise<{ status: number, body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

/** A catalog whose roster is fixed to the given ids. */
function catalogWith(ids: string[]): AStudioCatalog {
  const models: AStudioModelInfo[] = ids.map(id => ({ id, name: id, contextWindow: 1024, maxTokens: 128 }))
  return {
    current: () => models,
    refresh: async () => {},
    source: () => 'live',
    fetchedAtMs: () => undefined,
    hiddenModelIds: () => [],
    failure: () => undefined,
  }
}

/** Counts `notify` calls, the announcement that makes the picker re-read. */
interface Notifier {
  calls: number
}

/** Mount the handler with a temp-dir visibility store; returns the port + store path. */
async function mount(
  key: string,
  ids = ['spark-x2.5', 'glm-5.2'],
  notifier?: Notifier,
): Promise<{ port: number, path: string }> {
  const path = join(dir, 'model-visibility.json')
  const handler = astudioVisibilityHandler({
    catalog: catalogWith(ids),
    store: createAStudioVisibilityStore(path),
    ...notifier === undefined ? {} : { notify: () => { notifier.calls += 1 } },
  }, key)
  return { port: await withHandler(handler), path }
}

function hideBody(visible: boolean): string {
  return JSON.stringify({ visible })
}

describe('astudioVisibilityHandler', () => {
  it('rejects non-POST requests', async () => {
    const key = createControlKey()
    const { port } = await mount(key)
    const res = await rawRequest(port, '/astudio/visibility/spark-x2.5', { Host: '127.0.0.1' }, undefined, 'GET')
    expect(res.status).toBe(405)
  })

  it('rejects a non-loopback Host', async () => {
    const key = createControlKey()
    const { port } = await mount(key)
    const res = await rawRequest(
      port,
      '/astudio/visibility/spark-x2.5',
      { Host: 'evil.example.com', 'x-astudio-control-key': key },
      hideBody(false),
    )
    expect(res.status).toBe(403)
  })

  it('rejects a missing control key', async () => {
    const key = createControlKey()
    const { port, path } = await mount(key)
    const res = await rawRequest(port, '/astudio/visibility/spark-x2.5', { Host: '127.0.0.1' }, hideBody(false))
    expect(res.status).toBe(403)
    // Nothing was written on the rejected path.
    await expect(readFile(path, 'utf8')).rejects.toThrow()
  })

  it('rejects a wrong control key', async () => {
    const key = createControlKey()
    const { port } = await mount(key)
    const res = await rawRequest(
      port,
      '/astudio/visibility/spark-x2.5',
      { Host: '127.0.0.1', 'x-astudio-control-key': 'wrong-key' },
      hideBody(false),
    )
    expect(res.status).toBe(403)
  })

  it('returns 404 when the model id is missing from the path', async () => {
    const key = createControlKey()
    const { port } = await mount(key)
    const res = await rawRequest(port, '/astudio/visibility', { Host: '127.0.0.1', 'x-astudio-control-key': key }, hideBody(false))
    expect(res.status).toBe(404)
  })

  it('refuses a model outside the live roster', async () => {
    // Persisting an id the roster cannot show again would leave a hidden entry
    // with no way to un-hide it from the card.
    const key = createControlKey()
    const { port, path } = await mount(key)
    const res = await rawRequest(
      port,
      '/astudio/visibility/not-in-roster',
      { Host: '127.0.0.1', 'x-astudio-control-key': key },
      hideBody(false),
    )
    expect(res.status).toBe(404)
    expect(JSON.parse(res.body)).toEqual({ error: 'unknown-model' })
    await expect(readFile(path, 'utf8')).rejects.toThrow()
  })

  it('requires a boolean flag', async () => {
    const key = createControlKey()
    const { port } = await mount(key)
    for (const body of ['{}', '{"visible":"false"}', 'not json', '[]']) {
      const res = await rawRequest(
        port,
        '/astudio/visibility/spark-x2.5',
        { Host: '127.0.0.1', 'x-astudio-control-key': key, 'Content-Type': 'application/json' },
        body,
      )
      expect(res.status).toBe(400)
    }
  })

  it('persists a hide and an un-hide for the local identity', async () => {
    const key = createControlKey()
    const { port, path } = await mount(key)
    const headers = { Host: '127.0.0.1', 'x-astudio-control-key': key, 'Content-Type': 'application/json' }

    const hidden = await rawRequest(port, '/astudio/visibility/spark-x2.5', headers, hideBody(false))
    expect(hidden.status).toBe(200)
    expect(JSON.parse(hidden.body)).toEqual({ modelId: 'spark-x2.5', visible: false })
    const afterHide = JSON.parse(await readFile(path, 'utf8')) as { visibility: Record<string, { hidden: string[] }> }
    expect(afterHide.visibility[ASTRO_LOCAL_IDENTITY]?.hidden).toEqual(['spark-x2.5'])

    const shown = await rawRequest(port, '/astudio/visibility/spark-x2.5', headers, hideBody(true))
    expect(shown.status).toBe(200)
    const afterShow = JSON.parse(await readFile(path, 'utf8')) as { visibility: Record<string, { hidden: string[] }> }
    expect(afterShow.visibility[ASTRO_LOCAL_IDENTITY]?.hidden).toEqual([])
  })

  it('accepts a URL-encoded model id', async () => {
    const key = createControlKey()
    const { port, path } = await mount(key, ['spark-x2.5-4b'])
    const res = await rawRequest(
      port,
      '/astudio/visibility/spark-x2.5-4b?x=1',
      { Host: '127.0.0.1', 'x-astudio-control-key': key },
      hideBody(false),
    )
    expect(res.status).toBe(200)
    const written = JSON.parse(await readFile(path, 'utf8')) as { visibility: Record<string, { hidden: string[] }> }
    expect(written.visibility[ASTRO_LOCAL_IDENTITY]?.hidden).toEqual(['spark-x2.5-4b'])
  })

  it('announces the change once, after the write lands', async () => {
    // The adapter filters hidden models on every call, but the browser holds its
    // own catalog snapshot and only reloads it on this announcement. Without it
    // the picker kept listing a hidden model and failed on selection with
    // `session/model-unavailable`.
    const key = createControlKey()
    const notifier: Notifier = { calls: 0 }
    const { port } = await mount(key, ['spark-x2.5', 'glm-5.2'], notifier)
    const res = await rawRequest(
      port,
      '/astudio/visibility/spark-x2.5',
      { Host: '127.0.0.1', 'x-astudio-control-key': key },
      hideBody(false),
    )
    expect(res.status).toBe(200)
    expect(notifier.calls).toBe(1)
  })

  it('does not announce a rejected write', async () => {
    // A 4xx means nothing changed, and each announcement costs the browser a
    // catalog reload.
    const key = createControlKey()
    const notifier: Notifier = { calls: 0 }
    const { port } = await mount(key, ['spark-x2.5'], notifier)
    await rawRequest(port, '/astudio/visibility/spark-x2.5', { Host: '127.0.0.1' }, hideBody(false))
    await rawRequest(port, '/astudio/visibility/not-in-roster', {
      Host: '127.0.0.1',
      'x-astudio-control-key': key,
    }, hideBody(false))
    expect(notifier.calls).toBe(0)
  })

  it('still answers 200 when the announcement throws', async () => {
    // The preference is already durable at that point; a broken listener must
    // not turn a saved save into an error the card would report as a failure.
    const key = createControlKey()
    const handler = astudioVisibilityHandler({
      catalog: catalogWith(['spark-x2.5']),
      store: createAStudioVisibilityStore(join(dir, 'model-visibility.json')),
      notify: () => { throw new Error('listener exploded') },
    }, key)
    const port = await withHandler(handler)
    const res = await rawRequest(
      port,
      '/astudio/visibility/spark-x2.5',
      { Host: '127.0.0.1', 'x-astudio-control-key': key },
      hideBody(false),
    )
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ modelId: 'spark-x2.5', visible: false })
  })

  it('reports a failed write instead of a false success', async () => {
    const key = createControlKey()
    const handler = astudioVisibilityHandler({
      catalog: catalogWith(['spark-x2.5']),
      store: {
        hidden: () => [],
        setVisible: async () => { throw new Error('disk full') },
      },
    }, key)
    const port = await withHandler(handler)
    const res = await rawRequest(
      port,
      '/astudio/visibility/spark-x2.5',
      { Host: '127.0.0.1', 'x-astudio-control-key': key },
      hideBody(false),
    )
    expect(res.status).toBe(500)
    expect(JSON.parse(res.body)).toEqual({ error: 'write-failed' })
  })
})
