import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearLoginSession,
  describeLoginSession,
  parseLoginSession,
  readLoginSession,
  writeLoginSession,
} from '../src/login-session.ts'
import type { AStudioLoginSession } from '../src/login-session.ts'

/**
 * The plugin's own sign-in file: the one place this plugin ever writes a
 * credential. What matters is that a half-written or unexpected document is
 * never mistaken for a session, and that the identity it reports carries no
 * secrets.
 */

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
})

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'astudio-login-'))
  CLEANUP.push(async () => { await rm(root, { recursive: true, force: true }) })
  return root
}

const SESSION: AStudioLoginSession = {
  version: 1,
  accountId: 'acc-1',
  ssoSessionId: 'sso-secret',
  modelBearerToken: 'model-secret',
  nickname: 'someone',
  avatar: 'https://thirdwx.qlogo.cn/a',
  loginMethod: 'wechat-qr',
  loggedInAt: '2026-11-02T13:00:00.000Z',
}

describe('the login session file', () => {
  it('round-trips a session, creating its directory when missing', async () => {
    const path = join(await scratch(), 'nested', 'deeper', '.astudio-login.json')
    writeLoginSession(SESSION, path)
    expect(readLoginSession(path)).toEqual(SESSION)
  })

  it('is owner-only where the platform honours a mode', async () => {
    const path = join(await scratch(), '.astudio-login.json')
    writeLoginSession(SESSION, path)
    if (process.platform === 'win32') return
    // A credential readable by every account on the machine is a leak, so the
    // file is created 0600 rather than restricted afterwards.
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('leaves no temporary file behind', async () => {
    const root = await scratch()
    const path = join(root, '.astudio-login.json')
    writeLoginSession(SESSION, path)
    writeLoginSession({ ...SESSION, accountId: 'acc-2' }, path)
    expect(readLoginSession(path)?.accountId).toBe('acc-2')
    const { readdir } = await import('node:fs/promises')
    expect(await readdir(root)).toEqual(['.astudio-login.json'])
  })

  it('reads nothing out of a missing file', async () => {
    expect(readLoginSession(join(await scratch(), 'nope.json'))).toBeUndefined()
  })

  it('reads nothing out of a file it cannot parse', async () => {
    const root = await scratch()
    const path = join(root, '.astudio-login.json')
    await writeFile(path, '{ not json', 'utf8')
    expect(readLoginSession(path)).toBeUndefined()
  })

  it('refuses a document of the wrong format version', async () => {
    expect(parseLoginSession({ ...SESSION, version: 2 })).toBeUndefined()
    expect(parseLoginSession({ ...SESSION, version: undefined })).toBeUndefined()
  })

  it('refuses a document without an account or a cookie', async () => {
    // A sign-in is exactly the pair; either one alone cannot call anything.
    expect(parseLoginSession({ ...SESSION, accountId: '' })).toBeUndefined()
    expect(parseLoginSession({ ...SESSION, ssoSessionId: '   ' })).toBeUndefined()
    expect(parseLoginSession(null)).toBeUndefined()
    expect(parseLoginSession([])).toBeUndefined()
  })

  it('keeps a session that has no model key yet', async () => {
    const partial = { ...SESSION, modelBearerToken: undefined }
    const parsed = parseLoginSession(partial)
    // Signed in but unusable for inference is a real state; the caller decides
    // what to do with it rather than the parser inventing a key.
    expect(parsed?.accountId).toBe('acc-1')
    expect(parsed?.modelBearerToken).toBeUndefined()
  })

  it('describes the identity without either secret', () => {
    const described = describeLoginSession(SESSION)
    expect(described).toEqual({
      source: 'dsh',
      accountId: 'acc-1',
      nickname: 'someone',
      avatar: 'https://thirdwx.qlogo.cn/a',
      loggedInAt: '2026-11-02T13:00:00.000Z',
    })
    const serialized = JSON.stringify(described)
    expect(serialized).not.toContain('sso-secret')
    expect(serialized).not.toContain('model-secret')
  })

  it('clears without complaining about an absent file', async () => {
    const root = await scratch()
    const path = join(root, '.astudio-login.json')
    writeLoginSession(SESSION, path)
    clearLoginSession(path)
    expect(readLoginSession(path)).toBeUndefined()
    expect(() => { clearLoginSession(path) }).not.toThrow()
  })

  it('writes nothing but JSON, with a trailing newline', async () => {
    const path = join(await scratch(), '.astudio-login.json')
    writeLoginSession(SESSION, path)
    const text = await readFile(path, 'utf8')
    expect(text.endsWith('\n')).toBe(true)
    expect(JSON.parse(text)).toEqual(SESSION)
  })

  it('overwrites a directory it did not create', async () => {
    const root = await scratch()
    const path = join(root, 'home', '.astudio-login.json')
    await mkdir(join(root, 'home'), { recursive: true })
    writeLoginSession(SESSION, path)
    expect(readLoginSession(path)?.ssoSessionId).toBe('sso-secret')
  })
})
