/**
 * AStudio settings page. Renders the plugin card into the DSH settings slot with
 * three labeled sections — status, context, and detail — plus manual refresh,
 * probe, and visibility controls.
 *
 * @module dsh-astudio-connect/client
 */

import { useState, useEffect } from 'react'
import type { AStudioCatalog, AStudioModelInfo } from '../catalog.ts'
import type { AStudioCredentialStore } from '../auth.ts'
import type { AStudioVisibilityStore } from '../visibility-store.ts'
import type { AStudioProbeStore } from '../probe-store.ts'
import { ASTRO_LOCAL_IDENTITY } from '../identity.ts'

/** Props for the settings page. */
export interface AStudioSettingsPageProps {
  store: AStudioCredentialStore
  catalog: AStudioCatalog
  /** Visibility store used to render and toggle per-model visibility. */
  visibility?: AStudioVisibilityStore
  /** Probe store used to render the current identity's probe summary. */
  probe?: AStudioProbeStore
  /** Identity used for visibility and probe reads. */
  identity?: string
  /** Fired when the user asks to probe one model; the host owns the request. */
  onProbe?: (modelId: string) => void
}

/** Connection status. */
type Status = 'connected' | 'not-connected'

/**
 * Desensitize a token for display: show only the first 7 characters and
 * the length, never the full value.
 */
export function desensitizeToken(token: string | undefined): string {
  if (token === undefined) return '—'
  if (token.length <= 7) return `${token}… (len=${token.length})`
  return `${token.slice(0, 7)}… (len=${token.length})`
}

/** AStudio settings page component. */
export default function AStudioSettingsPage({
  store,
  catalog,
  visibility,
  probe,
  identity = ASTRO_LOCAL_IDENTITY,
  onProbe,
}: AStudioSettingsPageProps) {
  const [status, setStatus] = useState<Status>('not-connected')
  const [models, setModels] = useState<readonly AStudioModelInfo[]>([])
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    const token = store.resolve()
    setStatus(token !== undefined ? 'connected' : 'not-connected')
    setModels(catalog.current())
  }, [store, catalog])

  async function refreshCatalog(): Promise<void> {
    setRefreshing(true)
    try {
      await catalog.refresh()
      setModels(catalog.current())
    } finally {
      setRefreshing(false)
    }
  }

  const hidden = visibility === undefined ? [] : visibility.hidden(identity)
  const probeRecords = (probe === undefined ? [] : catalog.current())
    .map(model => probe === undefined ? undefined : probe.get(identity, model.id))
    .filter((record): record is NonNullable<typeof record> => record !== undefined)

  return (
    <div style={{ padding: '16px', fontFamily: 'system-ui, sans-serif' }}>
      <h3 style={{ marginBottom: '12px' }}>AStudio Connect</h3>

      <section style={{ marginBottom: '12px' }} data-testid="status">
        <h4 style={{ marginBottom: '8px' }}>Status</h4>
        <div style={{ marginBottom: '4px' }}>
          <span style={{ fontWeight: 'bold' }}>Sign-in: </span>
          <span style={{ color: status === 'connected' ? 'green' : 'red' }}>
            {status === 'connected' ? 'Connected' : 'Not connected'}
          </span>
        </div>
        <div style={{ marginBottom: '4px' }}>
          <span style={{ fontWeight: 'bold' }}>Catalog source: </span>
          <span>{catalog.source()}</span>
        </div>
        <div>
          <span style={{ fontWeight: 'bold' }}>Token expiry: </span>
          <span>Unknown</span>
        </div>
      </section>

      <section style={{ marginBottom: '12px' }} data-testid="context">
        <h4 style={{ marginBottom: '8px' }}>Context</h4>
        <ul>
          {models.map(model => (
            <li key={model.id} style={{ marginBottom: '4px' }}>
              <span>{model.name}: {model.contextWindow} tokens, image {model.supportsImages === true ? 'supported' : 'not supported'}</span>
            </li>
          ))}
        </ul>
      </section>

      <section style={{ marginBottom: '12px' }} data-testid="detail">
        <h4 style={{ marginBottom: '8px' }}>Detail</h4>
        <div style={{ marginBottom: '8px' }}>
          <span style={{ fontWeight: 'bold' }}>Rate: </span>
          <span>Unknown</span>
        </div>
        <ul>
          {models.map(model => {
            const record = probeRecords.find(r => r.modelId === model.id)
            return (
              <li key={model.id} style={{ marginBottom: '4px' }}>
                <span>{model.name} <code>({model.id})</code></span>
                {record !== undefined && (
                  <span style={{ marginLeft: '8px' }}>
                    probe: {record.validation} [{record.efforts.join(', ')}]
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      </section>

      <div style={{ marginBottom: '12px' }}>
        <button type="button" onClick={() => void refreshCatalog()} disabled={refreshing}>
          {refreshing ? 'Refreshing…' : 'Refresh catalog'}
        </button>
      </div>

      <div style={{ marginBottom: '12px' }}>
        <span style={{ fontWeight: 'bold' }}>Probe:</span>
        {models
          .filter(model => model.reasoning?.supports === true)
          .map(model => (
            <button
              type="button"
              key={model.id}
              style={{ marginLeft: '8px' }}
              onClick={() => onProbe?.(model.id)}
            >
              {model.name}
            </button>
          ))}
      </div>

      {visibility !== undefined && (
        <div>
          <span style={{ fontWeight: 'bold' }}>Visibility:</span>
          <ul>
            {models.map(model => {
              const isHidden = hidden.includes(model.id)
              return (
                <li key={model.id}>
                  <button
                    type="button"
                    onClick={async () => {
                      await visibility.setVisible(identity, model.id, !isHidden)
                    }}
                  >
                    {isHidden ? 'Show' : 'Hide'} {model.name}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
