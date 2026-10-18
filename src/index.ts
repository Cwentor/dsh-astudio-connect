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

export { ASTRO_PROVIDER, ASTRO_STREAM_IDLE_TIMEOUT_MS, createAStudioAdapter } from './adapter.ts'
export { createAStudioShim, type AStudioShim } from './shim.ts'
export { createAStudioAuth, readTokenFromConfig } from './auth.ts'
export { createAStudioUpstream, DEFAULT_UPSTREAM_URL } from './upstream.ts'
export { createAStudioCatalog, DEFAULT_CATALOG } from './catalog.ts'

/** The model registry required before the provider can register. */
export const inject = ['llm']

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
 * Register the AStudio provider into the Harness LLM seam.
 *
 * Creates the credential store, upstream client, catalog, loopback shim, and
 * pi-ai adapter. The shim starts listening on 127.0.0.1 and the adapter
 * registers the `astudio` provider route. All resources are cleaned up when
 * the host calls `ctx.dispose()`.
 */
export function apply(ctx: Context, config: Config): void {
  const store = createAStudioAuth(config.configPath !== undefined ? { configPath: config.configPath } : {})
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
      ...(config.displayName !== undefined ? { displayName: config.displayName } : {}),
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

    // Register the status route on the host web server.
    registerAStudioStatusRoute(ctx, { store, catalog })

    // Register the update route on the host web server.
    registerAStudioUpdateRoute(ctx, { currentVersion: ASTRO_VERSION })

    // Register the probe route on the host web server.
    const probeService = createAStudioProbeService({
      upstream,
      token: () => store.resolve(),
      store: probeStore,
    })
    const probeKey = createAStudioProbeKey()
    registerAStudioProbeRoute(ctx, {
      service: probeService,
      invalidate: () => { void catalog.refresh().catch(() => {}) },
    }, probeKey)

    // The host bundle is live: write a heartbeat so the status CLI can report
    // host health without a browser. Cleared on disposal; a stale heartbeat after
    // a crash is detected by PID in the reader.
    void writeHostHeartbeat()

    ctx.logger.info('dsh-astudio-connect: shim listening at', shim.baseUrl())
    void catalog.refresh().catch(() => {})
  }).catch((error: unknown) => {
    ctx.logger.error('dsh-astudio-connect: shim failed to start', error)
  })
}

export default apply
