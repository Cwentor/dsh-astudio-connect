/**
 * AStudio models for DeepSeek Harness, reusing the AStudio app's sign-in.
 * Registers one provider route — `astudio` — while streaming, tool calls,
 * compaction, and permissions stay Harness-owned.
 *
 * @module dsh-astudio-connect
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createAStudioAuth } from './auth.ts'
import { createAStudioUpstream } from './upstream.ts'
import { createAStudioCatalog } from './catalog.ts'
import { createAStudioShim } from './shim.ts'
import { createAStudioAdapter, ASTRO_PROVIDER } from './adapter.ts'

export { ASTRO_PROVIDER, ASTRO_STREAM_IDLE_TIMEOUT_MS, createAStudioAdapter } from './adapter.ts'
export { createAStudioShim, type AStudioShim } from './shim.ts'
export { createAStudioAuth, readTokenFromConfig } from './auth.ts'
export { createAStudioUpstream, DEFAULT_UPSTREAM_URL } from './upstream.ts'
export { createAStudioCatalog, DEFAULT_CATALOG } from './catalog.ts'

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
  const catalog = createAStudioCatalog({
    upstream,
    token: () => store.resolve(),
  })

  const shim = createAStudioShim({
    store,
    upstream,
    catalog,
    logger: {
      warn: (...args: unknown[]) => ctx.logger.warn('dsh-astudio-connect', ...args),
      error: (...args: unknown[]) => ctx.logger.error('dsh-astudio-connect', ...args),
    },
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
      })
    } catch {
      releaseAdapter()
      void shim.close()
    }

    ctx.logger.info('dsh-astudio-connect: shim listening at', shim.baseUrl())
    void catalog.refresh().catch(() => {})
  }).catch((error: unknown) => {
    ctx.logger.error('dsh-astudio-connect: shim failed to start', error)
  })
}

export default apply
