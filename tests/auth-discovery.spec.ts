/**
 * AStudio credential discovery: the chat token from `config.toml` and the
 * separate model-manager token from `astron-session.json`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, win32 } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createAStudioAuth,
  readTokenFromConfig,
  readModelBearerToken,
  resolveDefaultConfigPath,
} from '../src/auth.ts'

let dir: string

function writeConfig(home: string, token: string): string {
  const path = join(home, 'runtime', 'acode-home', 'config.toml')
  mkdirSync(join(home, 'runtime', 'acode-home'), { recursive: true })
  writeFileSync(path, [
    '[model_providers.astron-spark]',
    'name = "Astron Spark"',
    `experimental_bearer_token = "${token}"`,
    'uid = "12345"',
    '',
  ].join('\n'), 'utf8')
  return path
}

function writeSession(home: string, modelBearerToken: string): string {
  const path = join(home, 'userdata', 'astron-session.json')
  mkdirSync(join(home, 'userdata'), { recursive: true })
  writeFileSync(path, JSON.stringify({ accountId: '1', uid: '1', token: 'chat-tok', modelBearerToken }), 'utf8')
  return path
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'astudio-auth-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('readTokenFromConfig', () => {
  it('reads the bearer token from config.toml', () => {
    const path = writeConfig(dir, 'secret-token')
    expect(readTokenFromConfig(path)).toBe('secret-token')
  })

  it('returns undefined for an absent file', () => {
    expect(readTokenFromConfig(join(dir, 'nope.toml'))).toBeUndefined()
  })

  it('returns undefined when the file has no token field', () => {
    const path = join(dir, 'empty.toml')
    writeFileSync(path, '[features]\nhooks = true\n', 'utf8')
    expect(readTokenFromConfig(path)).toBeUndefined()
  })
})

describe('readModelBearerToken', () => {
  it('reads modelBearerToken from astron-session.json', () => {
    const path = writeSession(dir, 'model-token-abc')
    expect(readModelBearerToken(path)).toBe('model-token-abc')
  })

  it('returns undefined when the field is absent', () => {
    const path = join(dir, 'session.json')
    writeFileSync(path, JSON.stringify({ token: 'only-chat' }), 'utf8')
    expect(readModelBearerToken(path)).toBeUndefined()
  })

  it('returns undefined for an absent file', () => {
    expect(readModelBearerToken(join(dir, 'missing.json'))).toBeUndefined()
  })

  it('returns undefined rather than throwing on malformed JSON', () => {
    const path = join(dir, 'bad.json')
    writeFileSync(path, '{not json', 'utf8')
    expect(readModelBearerToken(path)).toBeUndefined()
  })

  it('ignores an empty or whitespace-only token', () => {
    const path = join(dir, 'blank.json')
    writeFileSync(path, JSON.stringify({ modelBearerToken: '   ' }), 'utf8')
    expect(readModelBearerToken(path)).toBeUndefined()
  })
})

describe('resolveDefaultConfigPath', () => {
  it('accepts an explicit override verbatim', () => {
    expect(resolveDefaultConfigPath({ explicit: 'E:\\Custom\\config.toml' })).toBe('E:\\Custom\\config.toml')
  })

  it('derives config.toml from an env-provided home', () => {
    const env = { ASTUDIO_DATA_HOME: 'E:\\Env Home' } as unknown as NodeJS.ProcessEnv
    // `win32.join`, not the ambient `join`: the home is a Windows path, so the
    // expectation must be the same string on a Windows host and a POSIX one.
    expect(resolveDefaultConfigPath({ env, platform: 'win32' })).toBe(win32.join('E:\\Env Home', 'runtime', 'acode-home', 'config.toml'))
  })
})

describe('createAStudioAuth', () => {
  it('resolves both tokens from one data root', async () => {
    writeConfig(dir, 'chat-secret')
    const session = writeSession(dir, 'model-secret')

    const auth = createAStudioAuth({ dataHome: dir })

    expect(auth.resolve()).toBe('chat-secret')
    expect(auth.modelBearerToken()).toBe('model-secret')
    await expect(auth.status()).resolves.toMatchObject({ state: 'signed-in', hasModelToken: true })
    expect(session).toContain('astron-session.json')
  })

  it('reports signed-out when no session file exists', async () => {
    writeConfig(dir, 'chat-secret')
    const auth = createAStudioAuth({ dataHome: dir })
    const status = await auth.status()
    expect(status.state).toBe('signed-in')
    expect(auth.modelBearerToken()).toBeUndefined()
  })
})
