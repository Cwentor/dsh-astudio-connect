/**
 * Browser half: the AStudio settings card, on whichever settings surface the
 * host provides.
 *
 * One bundle serves two DSH generations. DSH 0.1.5 renders plugin cards in the
 * settings Plugins tab, which dispatches the keyed `settings.plugin.item` slot
 * once per served settings namespace. DSH 0.2.x moved plugin configuration to
 * the Plugins page, whose `plugins.bundle.config` slot carries one bundle-keyed
 * entry. `ctx.slots.inject` follows the slot's declaration lifetime — the
 * callback runs where the slot is declared and simply never runs where it is
 * not — so registering BOTH seams needs no host-version check: each host
 * materializes exactly the seam it ships.
 *
 * @module dsh-astudio-connect/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the two slot declarations this bundle registers into. The 0.1.5
// settings tab declares `settings.plugin.item`; the 0.2.x Plugins page declares
// `plugins.bundle.config`. Cross-plugin collaboration goes through cordis
// services, so value imports would fail the client bundle-purity gate; at
// runtime each host declares only the slot it ships.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { AStudioConfigPage } from './AStudioConfigPage.tsx'
import { AStudioPluginCard } from './AStudioPluginCard.tsx'
import type { AStudioPluginCardProps } from './AStudioPluginCard.tsx'
import { en, zh } from './locales.ts'
import type { AStudioSettingsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** AStudio plugin card copy. */
    'settings.astudio': AStudioSettingsKey
  }
  interface SlotMap {
    /**
     * Compile-time mirror of DSH 0.1.5's settings Plugins-tab seat.
     *
     * DSH 0.2.x dropped this slot entirely — its Plugins page declares
     * `plugins.bundle.config` instead — so no shipped dependency declares the
     * key any more and the name is not in `SlotMap`. The mirror keeps the 0.1.5
     * seam compiling: that slot's declaration lifetime still decides whether the
     * registration runs, so a 0.2.x host simply never fires the inject below.
     * Drop this mirror once 0.1.5 support ends.
     */
    'settings.plugin.item': {
      kind: 'keyed'
      scope: 'root'
      owner: AStudioLegacySettingsCardOwnerProps
    }
  }
}

/** Owner share of the 0.1.5 settings-tab seat: the tab supplies nothing to entries. */
interface AStudioLegacySettingsCardOwnerProps {
  children?: never
}

/** Stable browser-plugin name. */
export const name = 'dsh-astudio-connect-client'

/**
 * The bundle's package name, which is also this half's configuration key.
 *
 * The Plugins page dispatches `plugins.bundle.config` by the bundle's package
 * name, so the key has to spell exactly what the profile installs.
 */
export const BUNDLE_NAME = 'dsh-astudio-connect'

/**
 * Client services required by this browser half.
 *
 * The `slots` registry lives in `@deepseek-ai/dsh-client-ui-renderer` and
 * `locale` in `@deepseek-ai/dsh-client-locale`. Neither slot owner is named
 * here on purpose: the seam choice is made by slot-declaration lifetime, not by
 * activation order — `ctx.slots.inject` fires whenever the declaring package
 * commits the slot, before or after this fiber starts.
 */
export const inject = ['slots', 'locale']

/** Prefix every guarded client contribution's degradation logs with this. */
const CLIENT_CONTRIBUTION_FAILED = '[dsh-astudio-connect] client contribution failed to load (host provider unaffected):'

/** Disposer handed back when a deferred registration degraded: nothing to undo. */
const NOOP_DISPOSER = (): void => {}

/**
 * Run ONE browser-side contribution, degrading its failure to a `console.error`
 * instead of throwing into the DSH loader. Returns the contribution's own value
 * on success, or `undefined` when it degraded — the deferred slot callbacks
 * below substitute `NOOP_DISPOSER` for that, because the slot runtime always
 * expects a disposer back.
 *
 * Every contribution is guarded at BOTH boundaries where it can throw:
 *
 * 1. the eager `ctx.slots.inject(...)` call, which runs synchronously inside
 *    `apply()`;
 * 2. the deferred callback, which the slot runtime invokes later — when the
 *    owner commits the slot's declaration — long after `apply()` has returned,
 *    where no enclosing try/catch could still catch it.
 *
 * The pair makes the contributions independent: a failure in one settings seam
 * leaves the other registration intact. Guards are for THIS browser half only;
 * the host half reports its own errors through `ctx.logger`.
 */
function guardClientContribution<T>(label: string, fn: () => T): T | undefined {
  try {
    return fn()
  } catch (error: unknown) {
    console.error(`${CLIENT_CONTRIBUTION_FAILED} ${label}`, error)
    return undefined
  }
}

/**
 * Register the card copy and both settings-surface seams, one guarded
 * contribution at a time.
 *
 * A DSH slot-API breaking change degrades to a `console.error` per contribution
 * instead of throwing into the DSH loader and raising the red "Failed to load
 * plugins" banner; because each contribution carries its own guard, one failing
 * registration never takes the others with it. The host provider keeps working
 * throughout.
 */
export function apply(ctx: ClientContext): void {
  // The locale copy feeds every contribution below through `t`. Its guard exists
  // only so a broken locale service cannot reach the loader; if it degrades, `t`
  // still binds and renders the key names as fallback copy.
  const namespace = 'settings.astudio'
  guardClientContribution('settings copy', () => {
    ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-astudio-connect: settings copy')
  })
  const t = ctx.locale.bind(namespace) as AStudioPluginCardProps['t']

  // SEAM ONE — DSH 0.2.x's Plugins page. One configuration entry for the whole
  // bundle, keyed by its package name as the page dispatches it. On 0.1.5 hosts
  // nothing declares this slot, so it never runs there.
  guardClientContribution('plugins.bundle.config page', () => {
    ctx.slots.inject('plugins.bundle.config', () => (
      guardClientContribution('plugins.bundle.config page', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: BUNDLE_NAME,
        locale: namespace,
      }, AStudioConfigPage)) ?? NOOP_DISPOSER
    ))
  })

  // SEAM TWO — DSH 0.1.5's settings Plugins tab. One card per served namespace,
  // keyed by the namespace the tab dispatches. On 0.2.x hosts nothing declares
  // this slot, so this registration simply never runs there.
  guardClientContribution('settings.plugin.item card', () => {
    ctx.slots.inject('settings.plugin.item', () => (
      guardClientContribution('settings.plugin.item card', () => ctx.slots.register({
        name: 'settings.plugin.item',
        key: 'astudio',
        priority: 30,
        inject: (): AStudioPluginCardProps => ({ t }),
      }, AStudioPluginCard)) ?? NOOP_DISPOSER
    ))
  })
}

/**
 * Desensitize a token for display: show only the first 7 characters and the
 * length, never the full value. Kept exported for host diagnostics and tests.
 */
export function desensitizeToken(token: string | undefined): string {
  if (token === undefined) return '—'
  if (token.length <= 7) return `${token}… (len=${token.length})`
  return `${token.slice(0, 7)}… (len=${token.length})`
}
