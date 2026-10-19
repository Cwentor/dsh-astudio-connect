/**
 * The bundle's configuration page on the sidebar's Plugins page.
 *
 * Renders the single AStudio status card. DSH 0.2.x's Plugins page dispatches
 * `plugins.bundle.config` by the bundle's package name; this entry mounts on
 * that slot and owns everything inside it.
 *
 * @module dsh-astudio-connect/client/AStudioConfigPage
 */

import type { CSSProperties, ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the `plugins.bundle.config` SlotMap entry, declared by the Plugins
// page. Cross-plugin collaboration goes through cordis services, so a value
// import would fail the client bundle-purity gate.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { AStudioPluginCard } from './AStudioPluginCard.tsx'

/** Props the Plugins page delivers to the bundle's configuration entry. */
export type AStudioConfigPageProps =
  PropsRuntime<'plugins.bundle.config'>
  & PropsLocale<'settings.astudio'>

/** The page's own chrome: a single card, no other chrome from the host. */
const pageStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  listStyle: 'none',
  margin: 0,
  padding: 0,
}

/**
 * Render the bundle's configuration: one status card.
 *
 * Only `view: 'page'` is asked for on this slot today; the one-liner answer
 * keeps the bundle legible if a summary seat ever renders it.
 */
export function AStudioConfigPage({ view, t }: AStudioConfigPageProps): ReactNode {
  if (view === 'summary') return t('intro')
  return (
    <ul style={pageStyle}>
      <AStudioPluginCard t={t} />
    </ul>
  )
}
