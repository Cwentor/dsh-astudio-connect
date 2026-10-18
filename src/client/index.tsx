/**
 * AStudio settings page. Shows connection status, desensitized token info,
 * and the model list. Rendered into the DSH plugin settings slot.
 *
 * @module dsh-astudio-connect/client
 */

import { useState, useEffect } from 'react'
import type { AStudioCatalog } from '../catalog.ts'
import type { AStudioCredentialStore } from '../auth.ts'

/** Props for the settings page. */
export interface AStudioSettingsPageProps {
  store: AStudioCredentialStore
  catalog: AStudioCatalog
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

/**
 * AStudio settings page component.
 *
 * Shows:
 * - Connection status (connected / not connected)
 * - Desensitized token info
 * - Model list from the catalog
 */
export default function AStudioSettingsPage({ store, catalog }: AStudioSettingsPageProps) {
  const [status, setStatus] = useState<Status>('not-connected')
  const [tokenInfo, setTokenInfo] = useState<string>('—')
  const [models, setModels] = useState<readonly { id: string; name: string }[]>([])

  useEffect(() => {
    const token = store.resolve()
    if (token !== undefined) {
      setStatus('connected')
      setTokenInfo(desensitizeToken(token))
    } else {
      setStatus('not-connected')
      setTokenInfo('—')
    }
    setModels(catalog.current())
  }, [store, catalog])

  return (
    <div style={{ padding: '16px', fontFamily: 'system-ui, sans-serif' }}>
      <h3 style={{ marginBottom: '12px' }}>AStudio Connect</h3>

      <div style={{ marginBottom: '12px' }}>
        <span style={{ fontWeight: 'bold' }}>Status: </span>
        <span style={{ color: status === 'connected' ? 'green' : 'red' }}>
          {status === 'connected' ? 'Connected' : 'Not connected'}
        </span>
      </div>

      <div style={{ marginBottom: '12px' }}>
        <span style={{ fontWeight: 'bold' }}>Token: </span>
        <code>{tokenInfo}</code>
      </div>

      <div>
        <span style={{ fontWeight: 'bold' }}>Models ({models.length}):</span>
        <ul style={{ marginTop: '8px' }}>
          {models.map(model => (
            <li key={model.id} style={{ marginBottom: '4px' }}>
              {model.name} <code>({model.id})</code>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
