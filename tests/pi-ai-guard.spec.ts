/**
 * The pi-ai resolution guard (issue #92).
 *
 * These cover the message contract rather than the resolution mechanics: the
 * resolver is a one-line `import.meta.resolve` whose behaviour belongs to Node.
 * What matters here is that a mismatched copy says something actionable, and
 * that a correct install stays quiet.
 */
import { describe, expect, it } from 'vitest'
import {
  piAiVersionAccepted,
  piAiVersionWarning,
  REQUIRED_PI_AI_MAJOR,
  REQUIRED_PI_AI_VERSION,
  resolvedPiAiVersion,
} from '../src/pi-ai-guard.ts'

describe('pi-ai resolution guard', () => {
  it('stays silent for the floor version this plugin is built for', () => {
    expect(piAiVersionWarning(REQUIRED_PI_AI_VERSION)).toBeUndefined()
  })

  it('stays silent for a newer release in the same generation', () => {
    // The dependency is `^1.1.0`, so npm resolves whatever 1.x is current. A
    // guard pinned to one string would warn on every healthy install.
    expect(piAiVersionWarning('1.4.0')).toBeUndefined()
    expect(piAiVersionWarning('1.1.1')).toBeUndefined()
  })

  it('stays silent when the version cannot be read', () => {
    // An unreadable copy is not evidence of a mismatch, and guessing here would
    // produce warnings on healthy installs. Passing undefined explicitly must
    // NOT fall back to the live resolver — otherwise this asserts nothing.
    expect(piAiVersionWarning(undefined)).toBeUndefined()
  })

  it('reads the live module graph when called with no argument', () => {
    // The omitted-argument path is the one production uses; it must consult the
    // resolver rather than treat "no argument" as "unreadable".
    expect(piAiVersionWarning()).toBeUndefined()
    const resolved = resolvedPiAiVersion()
    expect(resolved).toBeDefined()
    expect(piAiVersionAccepted(resolved ?? '')).toBe(true)
  })

  it('names both versions and a neutral remedy for an older copy', () => {
    const warning = piAiVersionWarning('0.82.1')
    expect(warning).toBeDefined()
    // #92's exact scenario: the co-installed plugin's copy wins resolution.
    expect(warning).toContain('0.82.1')
    expect(warning).toContain(REQUIRED_PI_AI_VERSION)
    expect(warning).toContain('hoisted')
    expect(warning).toContain('autoInstallPeers')
  })

  it('reports an older 1.x copy too', () => {
    // Same major, below the floor DSH 0.2.1's adapter was written against
    // (pi-ai 0.99 → 1.1.0 changed the model vocabulary underneath it).
    const warning = piAiVersionWarning('1.0.4')
    expect(warning).toBeDefined()
    expect(warning).toContain('1.0.4')
    expect(warning).toContain(REQUIRED_PI_AI_VERSION)
  })

  it('reports a copy outside the accepted generation', () => {
    expect(piAiVersionWarning('2.0.0')).toBeDefined()
    expect(piAiVersionWarning('0.87.1')).toBeDefined()
  })

  it('does not trust an unparsable version string', () => {
    expect(piAiVersionAccepted('not-a-version')).toBe(false)
    expect(piAiVersionWarning('not-a-version')).toBeDefined()
  })

  it('compares the major generation, not the string', () => {
    expect(REQUIRED_PI_AI_MAJOR).toBe(1)
    expect(piAiVersionAccepted(`${REQUIRED_PI_AI_MAJOR}.0.0`)).toBe(false)
    expect(piAiVersionAccepted(`${REQUIRED_PI_AI_MAJOR}.1.0`)).toBe(true)
  })

  it('never names a filesystem path', () => {
    // The warning reaches logs and bug reports, so it carries versions and the
    // remedy only — no install location, no user directory. The package name
    // itself contains a slash, so assert on path shapes rather than slashes.
    const warning = piAiVersionWarning('0.82.1') ?? ''
    expect(warning).not.toMatch(/(?:^|\s)\//u) // no absolute path
    expect(warning).not.toMatch(/node_modules/u)
    expect(warning).not.toMatch(/Users|home/u)
  })

  it('carries no plugin prefix, so the logger does not double it', () => {
    // The message is logged as `dsh-astudio-connect: ${warning}`. The warning
    // itself must therefore stay unprefixed, or every log line reads
    // "dsh-astudio-connect: dsh-astudio-connect: ...".
    const warning = piAiVersionWarning('0.82.1') ?? ''
    expect(warning).not.toMatch(/dsh-astudio-connect/u)
  })

  it('does not assert a single cause for the mismatch', () => {
    // A hoisted root is what #92 measured, but an installer or updater can leave
    // the wrong copy too. The message offers the hoisted profile as the thing to
    // check, not as a diagnosis — it must not claim to know which happened.
    const warning = piAiVersionWarning('0.82.1') ?? ''
    expect(warning).not.toMatch(/is shadowing it|because|definitely|certainly/u)
    expect(warning).toMatch(/check/u)
  })

  it('resolves a real version in this repository', () => {
    // Guards the resolver itself: if the walk-up or the specifier breaks, this
    // is where it shows, rather than in a silent no-op on every install.
    const resolved = resolvedPiAiVersion()
    expect(resolved).toBeDefined()
    expect(piAiVersionAccepted(resolved ?? '')).toBe(true)
  })
})
