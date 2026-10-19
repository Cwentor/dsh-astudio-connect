/**
 * AStudio models for DeepSeek Harness, reusing the AStudio app's sign-in.
 * Registers one provider route — `astudio` — while streaming, tool calls,
 * compaction, and permissions stay Harness-owned.
 *
 * @module dsh-astudio-connect
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { createAStudioAuth } from './auth.ts'
import { createAStudioUpstream } from './upstream.ts'
import { createAStudioCatalog } from './catalog.ts'
import type { AStudioCatalog } from './catalog.ts'
import { createAStudioShim } from './shim.ts'
import { createAStudioAdapter, ASTRO_PROVIDER } from './adapter.ts'
import { registerAStudioStatusRoute } from './web-status.ts'
import { createAStudioVisibilityStore } from './visibility-store.ts'
import { writeHostHeartbeat, clearHostHeartbeat } from './host-heartbeat.ts'
import { registerAStudioUpdateRoute } from './update-route.ts'
import { ASTRO_VERSION } from './version.ts'
import { createAStudioProbeStore } from './probe-store.ts'
import { createAStudioProbeService } from './probe-service.ts'
import { createAStudioProbeKey, registerAStudioProbeRoute } from './probe-route.ts'
import { piAiVersionWarning } from './pi-ai-guard.ts'

export { ASTRO_PROVIDER, ASTRO_STREAM_IDLE_TIMEOUT_MS, createAStudioAdapter } from './adapter.ts'
export { createAStudioShim, type AStudioShim } from './shim.ts'
export { createAStudioAuth, readTokenFromConfig } from './auth.ts'
export { createAStudioUpstream, DEFAULT_UPSTREAM_URL } from './upstream.ts'
export { createAStudioCatalog, DEFAULT_CATALOG } from './catalog.ts'

/**
 * Host services this plugin reads.
 *
 * `webServer` is required even though the status/update/probe routes are
 * secondary to model routing: the plugin's startup chain runs inside
 * `shim.ready.then()`, and every `ctx.<service>` read there is resolved against
 * the mounting fiber's inject list. A route registration that throws takes the
 * whole chain down with it — so a service this plugin merely *optionally* wants
 * is declared here as a hard requirement, and `apply()` guards its absence with
 * `ctx.get()` instead of letting an un-injected read throw.
 */
export const inject = ['llm', 'webServer']

/**
 * Settings namespace owning the AStudio card's section.
 *
 * A nominal string cast to the seam type. The namespace is what
 * `settings.yaml` and the TUI `/settings` read, and on DSH 0.1.5 the
 * settings Plugins tab dispatches a card by rendering `settings.plugin.item`
 * with `entryKey = ns` for each namespace the host serves.
 */
export const ASTRO_SETTINGS_NS = 'astudio' as SettingsNamespace

/** Plugin configuration schema. */
export interface Config {
  /** Display name shown in the provider picker. */
  displayName?: string
  /** Explicit config path, overriding the AStudio default location. */
  configPath?: string
}

export const Config: z<Config> = z.object({
  displayName: z.string().description('Display name for the AStudio provider in the model picker'),
  configPath: z.string().description('Explicit AStudio config.toml path (defaults to the app\'s own location)'),
})

/**
 * Render an unknown thrown value as a readable one-liner.
 *
 * cordis's logger formats a trailing object argument with `JSON.stringify`, and
 * `JSON.stringify(new Error('boom'))` is `{}` — which is exactly how this
 * plugin's startup failure once reached the user as `shim failed to start {}`.
 * Passing a pre-rendered string keeps the message and its cause in the log.
 */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = error.cause === undefined ? '' : ` (cause: ${describeError(error.cause)})`
  return `${error.name}: ${error.message}${cause}`
}

/**
 * Register the AStudio provider into the Harness LLM seam.
 *
 * Creates the credential store, upstream client, catalog, loopback shim, and
 * pi-ai adapter. The shim starts listening on 127.0.0.1 and the adapter
 * registers the `astudio` provider route. All resources are cleaned up when
 * the host calls `ctx.dispose()`.
 */
export function apply(ctx: Context, config: Config): void {
  // DSH may register this plugin without an explicit config (the cordis.patch
  // insert carries none), so `config` can be undefined at runtime even though
  // the schema type is non-optional. Default it up-front; the only reads
  // below are the configPath/displayName optionals.
  const cfg: Config = config ?? {}
  // Report a shadowed pi-ai copy once, at load. See pi-ai-guard.ts: the plugin
  // still runs, but a mismatched generation otherwise surfaces only as an
  // opaque PI_AI_ERROR on the first request (issue #92).
  const piAiWarning = piAiVersionWarning()
  if (piAiWarning !== undefined) ctx.logger.warn(`dsh-astudio-connect: ${piAiWarning}`)

  const store = createAStudioAuth(cfg.configPath !== undefined ? { configPath: cfg.configPath } : {})
  const upstream = createAStudioUpstream()
  const visibility = createAStudioVisibilityStore()
  const catalog = createAStudioCatalog({
    upstream,
    token: () => store.resolve(),
    visibility,
  })
  const probeStore = createAStudioProbeStore()

  const shim = createAStudioShim({
    store,
    upstream,
    catalog,
    logger: {
      warn: (...args: unknown[]) => ctx.logger.warn('dsh-astudio-connect', ...args),
      error: (...args: unknown[]) => ctx.logger.error('dsh-astudio-connect', ...args),
    },
  })

  // Register the settings page policy so the DSH settings Plugins tab renders
  // this plugin's card. The Config schema drives the form fields.
  ctx.inject(['settings'], settingsCtx => {
    ctx.effect(() => {
      const disposer = settingsCtx.settings.configure({ auto: true })
      return () => disposer()
    })
  })

  // Start the shim and register the adapter once it's listening.
  void shim.ready.then(() => {
    const { adapter } = createAStudioAdapter({
      shim,
      catalog,
      ...(cfg.displayName !== undefined ? { displayName: cfg.displayName } : {}),
    })

    const releaseAdapter = ctx.llm.registerAdapter([ASTRO_PROVIDER], adapter)

    try {
      ctx.effect(() => () => {
        releaseAdapter()
        void shim.close()
        void clearHostHeartbeat()
      })
    } catch {
      releaseAdapter()
      void shim.close()
      void clearHostHeartbeat()
    }

    // From here on the provider is registered and model routing works. The web
    // routes are a separate concern — the settings card reads them — so their
    // failure is contained and reported on its own. Letting a route problem
    // throw out of this callback would surface as a "shim failed to start"
    // error for a shim that is, in fact, listening.
    try {
      registerAStudioWebRoutes(ctx, { store, catalog, probe: probeStore, upstream })
    } catch (error: unknown) {
      ctx.logger.warn('dsh-astudio-connect: web routes unavailable:', describeError(error))
    }

    // The host bundle is live: write a heartbeat so the status CLI can report
    // host health without a browser. Cleared on disposal; a stale heartbeat after
    // a crash is detected by PID in the reader.
    void writeHostHeartbeat()

    ctx.logger.info('dsh-astudio-connect: shim listening at', shim.baseUrl())
    void catalog.refresh().catch(() => {})
  }).catch((error: unknown) => {
    // Render the error into the message: a bare trailing Error argument is
    // JSON-stringified by cordis and reads as `{}`.
    ctx.logger.error(`dsh-astudio-connect: startup failed: ${describeError(error)}`)
  })
}

/**
 * Mount the same-origin routes the settings card talks to.
 *
 * Split out so {@link apply}'s startup chain can contain a failure here without
 * losing the provider registration that precedes it. `webServer` is declared in
 * {@link inject}, so `ctx.webServer` resolves; `ctx.get` is still used for the
 * capability probe so an older host without the service degrades to "card shows
 * no data" rather than a thrown startup.
 */
function registerAStudioWebRoutes(
  ctx: Context,
  deps: {
    store: ReturnType<typeof createAStudioAuth>
    catalog: AStudioCatalog
    probe: ReturnType<typeof createAStudioProbeStore>
    upstream: ReturnType<typeof createAStudioUpstream>
  },
): void {
  if (ctx.get('webServer') === undefined) {
    throw new Error('the host exposes no webServer service')
  }
  const { store, catalog, probe, upstream } = deps

  // Mint the per-process probe key up front: the status card hands it to the
  // browser half, which echoes it back as `x-astudio-probe-key` on probe
  // control writes.
  const probeKey = createAStudioProbeKey()

  // Register the status route on the host web server.
  registerAStudioStatusRoute(ctx, { store, catalog, probe, probeKey })

  // Register the update route on the host web server.
  registerAStudioUpdateRoute(ctx, { currentVersion: ASTRO_VERSION })

  // Register the probe route on the host web server.
  const probeService = createAStudioProbeService({
    upstream,
    token: () => store.resolve(),
    store: probe,
  })
  registerAStudioProbeRoute(ctx, {
    service: probeService,
    invalidate: () => { void catalog.refresh().catch(() => {}) },
  }, probeKey)
}

/**
 * The plugin object the DSH loader mounts.
 *
 * This MUST be an object rather than the bare `apply` function. The loader
 * normalizes every plugin module with
 *
 *     exports = exports.default ?? exports
 *
 * so `export default apply` made the loader adopt that function directly — and
 * a function carries none of the module's other exports. `inject` was dropped,
 * the plugin mounted on an unscoped `Include` fiber, and each `ctx.llm` /
 * `ctx.webServer` read inside it threw `cannot get property "…" without
 * inject`. Because that throw is wrapped by the `.catch()` around
 * `shim.ready.then()`, and cordis JSON-stringifies a trailing Error argument
 * (`JSON.stringify(new Error(…))` is `{}`), the only trace was a log line
 * reading `shim failed to start {}` while the `astudio` provider silently
 * failed to register — which is why the model picker listed no AStudio models
 * even though the settings card rendered fine.
 *
 * Keeping `apply` (and `inject`) reachable as named exports is harmless: the
 * loader only ever reads the default when one exists.
 */
const plugin = {
  name: 'dsh-astudio-connect',
  inject,
  apply,
}

export default plugin
