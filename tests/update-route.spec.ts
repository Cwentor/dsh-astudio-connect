import { describe, it, expect } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { registerAStudioUpdateRoute, astudioUpdateHandler } from '../src/update-route.ts'

function createMockContext(): { ctx: Context; getRoute: () => { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> } | undefined } {
  let route: { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> } | undefined
  const ctx = {
    webServer: {
      register: (r: { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }) => {
        route = r
        return () => {}
      },
    },
  }
  return { ctx: ctx as unknown as Context, getRoute: () => route }
}

function mockResponse() {
  let statusCode = 0
  let body = ''
  const res = {
    writeHead: (code: number, _headers: Record<string, string>) => { statusCode = code },
    end: (payload?: string) => { body = payload ?? '' },
  }
  return {
    res: res as unknown as ServerResponse,
    status: () => statusCode,
    body: () => body,
  }
}

function mockRequest(host: string, method = 'GET'): IncomingMessage {
  return { method, headers: { host } } as unknown as IncomingMessage
}

describe('astudioUpdateHandler', () => {
  it('serves package, version, and repository on GET', async () => {
    const handler = astudioUpdateHandler()
    const response = mockResponse()
    await handler(mockRequest('127.0.0.1'), response.res)
    expect(response.status()).toBe(200)
    const body = JSON.parse(response.body()) as { package: string; version: string; repository: string }
    expect(body.package).toBe('dsh-astudio-connect')
    expect(body.version).toBe('0.1.0')
    expect(body.repository).toContain('github.com/astudio-connect/dsh-astudio-connect')
  })

  it('rejects non-GET methods', async () => {
    const handler = astudioUpdateHandler()
    const response = mockResponse()
    await handler(mockRequest('127.0.0.1', 'POST'), response.res)
    expect(response.status()).toBe(405)
  })

  it('rejects non-loopback Host', async () => {
    const handler = astudioUpdateHandler()
    const response = mockResponse()
    await handler(mockRequest('evil.example.com'), response.res)
    expect(response.status()).toBe(403)
  })

  it('does not leak tokens or internal paths', async () => {
    const handler = astudioUpdateHandler()
    const response = mockResponse()
    await handler(mockRequest('127.0.0.1'), response.res)
    expect(response.body()).not.toContain('token')
    expect(response.body()).not.toContain('D:\\')
  })
})

describe('registerAStudioUpdateRoute', () => {
  it('mounts the exact update path', () => {
    const { ctx, getRoute } = createMockContext()
    registerAStudioUpdateRoute(ctx)
    const route = getRoute()
    expect(route?.kind).toBe('exact')
    expect(route?.path).toBe('/astudio/update')
  })
})
