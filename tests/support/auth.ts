/**
 * A credential store for tests, hermetic by construction.
 *
 * `createAStudioAuth` reads the plugin's own sign-in from the DSH home by
 * default — the right behaviour in production, and a trap in tests: once a real
 * sign-in exists on the machine, a suite that forgot to redirect it would start
 * asserting against that person's account. Every test store therefore points at
 * a path that does not exist, and the tests that care about the sign-in file
 * pass their own.
 *
 * @module dsh-astudio-connect/tests/support/auth
 */

import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createAStudioAuth } from '../../src/auth.ts'

/** A login-session path no test writes to unless it means to. */
export const NO_LOGIN_SESSION = join(tmpdir(), 'astudio-test-no-login-session.json')

/** Build a store with the sign-in file redirected out of the real DSH home. */
export function testAuth(
  options: { configPath?: string, dataHome?: string, loginSessionPath?: string } = {},
) {
  return createAStudioAuth({
    ...options,
    loginSessionPath: options.loginSessionPath ?? NO_LOGIN_SESSION,
  })
}
