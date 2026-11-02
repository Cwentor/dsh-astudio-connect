import { describe, expect, it } from 'vitest'
import {
  ASTRO_WECHAT_QR_TTL_MS,
  createAStudioQrLogin,
  createWechatFd,
  parseWechatScan,
  pickModelKey,
} from '../src/qr-login.ts'
import type { AStudioLoginSession } from '../src/login-session.ts'

/**
 * The QR sign-in: the three calls the AStudio app makes, made here instead.
 *
 * What is pinned is everything that would break silently — the ticket shape,
 * the four ways a scan can end (no scan / nothing bound / several accounts /
 * signed in), the model-key choice, and the rule that a credential is stored
 * once and never echoed to the browser.
 */

const IMAGE_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])

/** One canned upstream, routed by which endpoint is being called. */
function upstream(answers: {
  qrcode?: unknown
  uids?: unknown
  configs?: unknown
  configsStatus?: number
  image?: Response
  imageUrl?: string
  qrcodeStatus?: number
}) {
  const calls: Array<{ url: string, init?: RequestInit | undefined }> = []
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    if (url.includes('/SSOService/wx/scanlogin/qrcode')) {
      return new Response(JSON.stringify(answers.qrcode ?? {
        flag: true,
        code: 0,
        desc: '获取成功',
        data: answers.imageUrl ?? 'https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=t',
      }), { status: answers.qrcodeStatus ?? 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/SSOService/wx/scanlogin/uids')) {
      return new Response(JSON.stringify(answers.uids ?? { flag: false, code: -1, desc: '暂无数据', data: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.includes('mp.weixin.qq.com')) {
      return answers.image ?? new Response(IMAGE_BYTES, { status: 200, headers: { 'content-type': 'image/jpg' } })
    }
    if (url.includes('bot/models/configs')) {
      return new Response(JSON.stringify(answers.configs ?? {
        code: 0,
        data: [{ model_id: 'spark-x2.5', is_current: true, api_key: 'key-current' }],
      }), { status: answers.configsStatus ?? 200, headers: { 'content-type': 'application/json' } })
    }
    throw new Error(`unexpected url ${url}`)
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

/** A client whose clock is a number the test owns. */
function client(answers: Parameters<typeof upstream>[0], options: { startAt?: number } = {}) {
  const saved: AStudioLoginSession[] = []
  let now = options.startAt ?? 1_700_000_000_000
  const io = upstream(answers)
  const qr = createAStudioQrLogin({
    save: (session) => { saved.push(session) },
    fetchImpl: io.fetchImpl,
    now: () => now,
    timeoutMs: 5_000,
  })
  return {
    qr,
    saved,
    calls: io.calls,
    advance: (ms: number) => { now += ms },
    currentNow: () => now,
  }
}

/** One entry of `uids`' `infoList`. */
function account(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { uid: 'acc-1', ssoSessionId: 'sso-1', username: 'someone', ...overrides }
}

describe('createWechatFd', () => {
  it('draws eight characters from the app alphabet', () => {
    const fd = createWechatFd()
    expect(fd).toHaveLength(8)
    // Not base64: the alphabet drops glyphs that are hard to read aloud.
    expect(fd).toMatch(/^[ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678]{8}$/u)
  })

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 200 }, () => createWechatFd()))
    expect(seen.size).toBeGreaterThan(190)
  })
})

describe('starting a sign-in', () => {
  it('answers the ticket, the QR as a data URL, and its expiry', async () => {
    const { qr, calls, currentNow } = client({})
    const start = await qr.start()
    expect(start.status).toBe('ok')
    if (start.status !== 'ok') return
    expect(start.fd).toHaveLength(8)
    expect(start.image.startsWith('data:image/jpg;base64,')).toBe(true)
    expect(Buffer.from(start.image.split(',')[1] ?? '', 'base64')).toEqual(IMAGE_BYTES)
    expect(start.expiresAtMs).toBe(currentNow() + ASTRO_WECHAT_QR_TTL_MS)
    // Two calls: mint the ticket, then fetch the image it points at.
    expect(calls).toHaveLength(2)
    expect(calls[0]?.url).toContain('SSOService/wx/scanlogin/qrcode?fd=')
  })

  it('refuses a QR that is not on WeChat\'s own host', async () => {
    const { qr } = client({ imageUrl: 'https://evil.example/qr.png' })
    expect(await qr.start()).toEqual({ status: 'unavailable' })
  })

  it('refuses a plain-HTTP QR image', async () => {
    const { qr } = client({ imageUrl: 'http://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=t' })
    expect(await qr.start()).toEqual({ status: 'unavailable' })
  })

  it('reports an upstream mint failure instead of a blank code', async () => {
    const { qr } = client({ qrcode: { flag: false, code: 40001, desc: '系统繁忙', data: null } })
    expect(await qr.start()).toEqual({ status: 'unavailable' })
  })

  it('refuses an image response that is not an image', async () => {
    const { qr } = client({
      image: new Response('<html>not an image</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    })
    expect(await qr.start()).toEqual({ status: 'unavailable' })
  })
})

describe('polling a sign-in', () => {
  it('waits while nobody has scanned', async () => {
    const { qr } = client({})
    const start = await qr.start()
    if (start.status !== 'ok') throw new Error('start failed')
    expect(await qr.poll({ fd: start.fd })).toEqual({ status: 'pending' })
  })

  it('calls a malformed ticket expired rather than forwarding it', async () => {
    const { qr, calls } = client({})
    // Shapes the app never mints: wrong length, a path separator, empty.
    expect(await qr.poll({ fd: 'short' })).toEqual({ status: 'expired' })
    expect(await qr.poll({ fd: '../../x' })).toEqual({ status: 'expired' })
    expect(await qr.poll({ fd: '' })).toEqual({ status: 'expired' })
    expect(calls).toHaveLength(0)
  })

  it('calls a ticket it never minted expired', async () => {
    const { qr } = client({})
    expect(await qr.poll({ fd: 'ABCD2345' })).toEqual({ status: 'expired' })
  })

  it('expires a ticket a minute after it was minted', async () => {
    const { qr, advance } = client({})
    const start = await qr.start()
    if (start.status !== 'ok') throw new Error('start failed')
    advance(ASTRO_WECHAT_QR_TTL_MS - 1)
    expect(await qr.poll({ fd: start.fd })).toEqual({ status: 'pending' })
    advance(1)
    expect(await qr.poll({ fd: start.fd })).toEqual({ status: 'expired' })
  })

  it('reports a scan by an unbound WeChat account without touching the account API', async () => {
    const { qr, calls } = client({
      uids: { flag: true, code: 0, data: { headimgurl: 'https://thirdwx.qlogo.cn/x', infoList: [] } },
    })
    const start = await qr.start()
    if (start.status !== 'ok') throw new Error('start failed')
    expect(await qr.poll({ fd: start.fd })).toEqual({ status: 'unbound' })
    expect(calls.some(call => call.url.includes('bot/models/configs'))).toBe(false)
  })

  it('asks which account to use when the WeChat identity has several', async () => {
    const { qr } = client({
      uids: {
        flag: true,
        code: 0,
        data: { infoList: [account(), account({ uid: 'acc-2', username: 'other' })] },
      },
    })
    const start = await qr.start()
    if (start.status !== 'ok') throw new Error('start failed')
    expect(await qr.poll({ fd: start.fd })).toEqual({
      status: 'select-account',
      accounts: [
        { accountId: 'acc-1', username: 'someone' },
        { accountId: 'acc-2', username: 'other' },
      ],
    })
  })

  it('finishes with the account the user picked, from the cached scan', async () => {
    const { qr, saved, calls } = client({
      uids: {
        flag: true,
        code: 0,
        data: { infoList: [account(), account({ uid: 'acc-2', username: 'other' })] },
      },
    })
    const start = await qr.start()
    if (start.status !== 'ok') throw new Error('start failed')
    await qr.poll({ fd: start.fd })
    const before = calls.length

    const result = await qr.poll({ fd: start.fd, accountId: 'acc-2' })
    expect(result.status).toBe('authenticated')
    expect(saved).toHaveLength(1)
    expect(saved[0]?.accountId).toBe('acc-2')
    // The selection press reuses the cached scan: only the exchange is called.
    expect(calls.length - before).toBe(1)
    expect(calls.at(-1)?.url).toContain('bot/models/configs')
  })

  it('stores the session and answers the identity only', async () => {
    const { qr, saved } = client({ uids: { flag: true, code: 0, data: { infoList: [account()] } } })
    const start = await qr.start()
    if (start.status !== 'ok') throw new Error('start failed')
    const result = await qr.poll({ fd: start.fd })
    expect(result).toEqual({
      status: 'authenticated',
      login: { source: 'dsh', accountId: 'acc-1', nickname: 'someone', loggedInAt: expect.any(String) },
    })
    expect(saved[0]).toMatchObject({
      version: 1,
      accountId: 'acc-1',
      ssoSessionId: 'sso-1',
      modelBearerToken: 'key-current',
      loginMethod: 'wechat-qr',
    })
    // Neither secret may appear in the answer the browser receives.
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('sso-1')
    expect(serialized).not.toContain('key-current')
  })

  it('sends the account cookie, and only that, to the model-config call', async () => {
    const { qr, calls } = client({ uids: { flag: true, code: 0, data: { infoList: [account()] } } })
    const start = await qr.start()
    if (start.status !== 'ok') throw new Error('start failed')
    await qr.poll({ fd: start.fd })
    const configs = calls.find(call => call.url.includes('bot/models/configs'))
    const headers = new Headers(configs?.init?.headers)
    expect(headers.get('cookie')).toBe('ssoSessionId=sso-1; sso_sessionid=sso-1; account_id=acc-1; token=sso-1')
    expect(headers.get('authorization')).toBeNull()
  })

  it('reports a session upstream no longer accepts as expired', async () => {
    const { qr, saved } = client({
      uids: { flag: true, code: 0, data: { infoList: [account()] } },
      configs: { code: 80000, desc: '会话已失效', data: null },
    })
    const start = await qr.start()
    if (start.status !== 'ok') throw new Error('start failed')
    expect(await qr.poll({ fd: start.fd })).toEqual({ status: 'expired' })
    expect(saved).toHaveLength(0)
  })

  it('refuses to store a sign-in with no model key to go with it', async () => {
    const { qr, saved } = client({
      uids: { flag: true, code: 0, data: { infoList: [account()] } },
      configs: { code: 0, data: [{ model_id: 'spark-x2.5', is_current: true, api_key: '  ' }] },
    })
    const start = await qr.start()
    if (start.status !== 'ok') throw new Error('start failed')
    // Signed in, but unusable: the shim would 401 on the first message.
    expect(await qr.poll({ fd: start.fd })).toEqual({ status: 'no-credential' })
    expect(saved).toHaveLength(0)
  })

  it('cannot be replayed: a finished ticket is spent', async () => {
    const { qr, saved } = client({ uids: { flag: true, code: 0, data: { infoList: [account()] } } })
    const start = await qr.start()
    if (start.status !== 'ok') throw new Error('start failed')
    await qr.poll({ fd: start.fd })
    expect(await qr.poll({ fd: start.fd })).toEqual({ status: 'expired' })
    expect(saved).toHaveLength(1)
  })

  it('maps an unreachable upstream to unavailable', async () => {
    const qr = createAStudioQrLogin({
      save: () => {},
      fetchImpl: (async () => { throw new Error('offline') }) as unknown as typeof fetch,
    })
    expect(await qr.start()).toEqual({ status: 'unavailable' })
  })
})

describe('pickModelKey', () => {
  it('prefers the current row, then the default, then the first usable one', () => {
    const rows = [
      { api_key: 'first' },
      { api_key: 'default', is_default: true },
      { api_key: 'current', is_current: true },
    ]
    expect(pickModelKey(rows)).toBe('current')
    expect(pickModelKey(rows.slice(0, 2))).toBe('default')
    expect(pickModelKey(rows.slice(0, 1))).toBe('first')
  })

  it('has no answer for rows without a key', () => {
    expect(pickModelKey([])).toBeUndefined()
    expect(pickModelKey([{ api_key: '' }, 'nonsense', null])).toBeUndefined()
  })
})

describe('parseWechatScan', () => {
  it('reads the accounts and the avatar out of the documented shape', () => {
    const scan = parseWechatScan({
      headimgurl: 'https://thirdwx.qlogo.cn/avatar',
      infoList: [account()],
    })
    expect(scan.avatar).toBe('https://thirdwx.qlogo.cn/avatar')
    expect(scan.accounts).toEqual([{ accountId: 'acc-1', ssoSessionId: 'sso-1', username: 'someone' }])
  })

  it('accepts the ssoUrl form the app also accepts', () => {
    const scan = parseWechatScan({
      infoList: [{
        username: 'via-url',
        ssoUrl: 'https://sso.xfyun.cn/login/setcookies?account_id=acc-9&ssoSessionId=sso-9',
      }],
    })
    expect(scan.accounts).toEqual([{ accountId: 'acc-9', ssoSessionId: 'sso-9', username: 'via-url' }])
  })

  it('ignores an ssoUrl on another origin', () => {
    const scan = parseWechatScan({
      infoList: [{ ssoUrl: 'https://evil.example/login/setcookies?account_id=a&ssoSessionId=b' }],
    })
    expect(scan.accounts).toEqual([])
  })

  it('drops entries it cannot identify instead of guessing', () => {
    const scan = parseWechatScan({ infoList: [{ uid: 'acc-1' }, { ssoSessionId: 'sso-1' }, null, 'nonsense'] })
    expect(scan.accounts).toEqual([])
    expect(parseWechatScan(undefined).accounts).toEqual([])
  })
})
