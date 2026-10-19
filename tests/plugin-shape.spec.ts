import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as moduleNamespace from '../src/index.ts'
import applyDefault, { apply, inject, ASTRO_PROVIDER } from '../src/index.ts'
import type { Context as CordisContext } from '@deepseek-ai/cordis'

/**
 * The DSH loader normalizes a plugin module before applying it:
 *
 *   exports = exports.default ?? exports
 *   if (!exports.__esModule) return exports
 *
 * That first line means **the `default` export wins outright**. Anything the
 * module exports *beside* `default` — including `inject` — is dropped on the
 * floor unless `default` itself carries it.
 *
 * This plugin used to `export default apply`, a bare function. The loader
 * unwrapped to that function, found no `inject`, and mounted the plugin on an
 * unscoped `Include` fiber. Every `ctx.llm`/`ctx.webServer` read inside the
 * plugin then failed with `cannot get property "…" without inject`; the thrown
 * error surfaced only as `shim failed to start {}` (cordis JSON-stringifies a
 * trailing Error argument, and `JSON.stringify(new Error(...))` is `{}`), and
 * the `astudio` provider was never registered — so the model picker showed
 * nothing from this plugin while the settings card still rendered.
 *
 * These tests pin the export shape the loader actually reads.
 */

/** Mirror of the loader's `unwrapExports`, which decides what gets mounted. */
function loaderUnwrap(exports: unknown): unknown {
  if (exports === null || exports === undefined) return exports
  let current = exports as Record<string, unknown>
  current = (current.default ?? current) as Record<string, unknown>
  if (!current.__esModule) return current
  return (current.default ?? current) as Record<string, unknown>
}

describe('plugin module shape read by the DSH loader', () => {
  it('unwraps to a value that carries inject — not a bare function', () => {
    const mounted = loaderUnwrap(moduleNamespace) as Record<string, unknown>
    expect(typeof mounted).toBe('object')
    expect(Array.isArray(mounted.inject)).toBe(true)
    expect(mounted.inject).toEqual(['llm', 'webServer'])
  })

  it('carries an apply function on the same object the loader mounts', () => {
    const mounted = loaderUnwrap(moduleNamespace) as Record<string, unknown>
    expect(typeof mounted.apply).toBe('function')
  })

  it('declares the preserve shape the loader needs: name, inject, apply', () => {
    const mounted = loaderUnwrap(moduleNamespace) as Record<string, unknown>
    expect(mounted.name).toBe('dsh-astudio-connect')
    expect(mounted.inject).toEqual(inject)
    expect(mounted.apply).toBe(apply)
  })

  it('keeps the named apply reachable from the mounted plugin object', () => {
    // The default export is a plugin object, not the raw function, precisely so
    // the loader keeps `inject`. The function itself stays exported by name.
    expect(applyDefault.apply).toBe(apply)
  })
})

/**
 * End-to-end with a real cordis runtime: mount the module exactly as the loader
 * does, then assert the plugin reached `llm` and `webServer`.
 *
 * A regression here is the user-visible bug: without both services the provider
 * never registers and the model picker stays empty.
 */
describe('mounting the plugin module on a live cordis runtime', () => {
  it('reaches llm and webServer from a fiber carrying the module inject', async () => {
    const root = new Context()
    const registered: string[] = []
    const routes: string[] = []

    root.provide('llm')
    root.llm = {
      registerAdapter: (providers: string[]) => {
        registered.push(...providers)
        const handle = (() => {}) as (() => void) & { replace: (next: string[]) => void }
        handle.replace = () => {}
        return handle
      },
    } as unknown as typeof root.llm
    root.provide('webServer')
    root.webServer = {
      register: (route: { path: string }) => {
        routes.push(route.path)
        return () => {}
      },
    } as unknown as typeof root.webServer

    // Mount exactly what the loader would mount.
    const mounted = loaderUnwrap(moduleNamespace) as {
      name: string
      inject: string[]
      apply: (ctx: CordisContext, config?: unknown) => void
    }
    expect(mounted.inject).toEqual(expect.arrayContaining(['llm', 'webServer']))

    root.plugin({ name: mounted.name, inject: mounted.inject, apply: mounted.apply })

    // The shim binds a real loopback port asynchronously; poll instead of
    // assuming a fixed delay.
    const deadline = Date.now() + 10_000
    while (registered.length === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }

    expect(registered).toEqual([ASTRO_PROVIDER])
    expect(routes).toEqual(expect.arrayContaining(['/astudio/status', '/astudio/update']))
  }, 20_000)
})
