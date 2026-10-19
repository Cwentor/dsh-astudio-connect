/**
 * The composer's points badge: the AStudio account's two credit pools, shown
 * beside the model selector while — and only while — this session has an
 * AStudio model selected.
 *
 * The pools are reported separately and never summed, because they pay for
 * different things: the general pool covers every model plus plugins and Skill
 * calls, the Spark pool covers Spark-branded models only.
 *
 * Visibility follows the session's live model selection, read from the
 * directory store the composer already holds. Two habits keep it correct:
 *
 * - a not-ready selection renders nothing but **stays mounted and subscribed**,
 *   so the seat appears once the host's projection lands — unmounting there
 *   would drop the store notification and the badge would never come back;
 * - a failed read hides the numbers rather than passing the previous ones off
 *   as current. A read that could not happen is never rendered as zero.
 *
 * The only reads are the mount read and the explicit ↻: every read queries the
 * account service, so nothing refreshes behind the user's back.
 *
 * @module dsh-astudio-connect/client/AStudioPointsBadge
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import { ASTRO_POINTS_PATH } from '../status-paths.ts'
import type { AStudioWebPoints } from '../status-paths.ts'
import type { AStudioSettingsKey } from './locales.ts'

/**
 * The slice of the host's model directory store this badge reads.
 *
 * Declared structurally rather than imported: the store's own types live in a
 * package this bundle only depends on for the seat it contributes to, and the
 * badge needs nothing beyond "subscribe, snapshot, read `current`".
 */
export interface AStudioPointsDirectoryStore {
  subscribe(listener: () => void): () => void
  getSnapshot(): { current: { provider: string, model: string } | null | undefined }
}

/** Props injected by the browser-plugin registration. */
export interface AStudioPointsBadgeProps {
  directory: AStudioPointsDirectoryStore
  t: (key: AStudioSettingsKey, params?: Record<string, unknown>) => string
}

/** Pools spoken for by a model this bundle owns. */
const ASTRO_PROVIDER = 'astudio'

/** The same dim annotation register the neighbouring model selector uses. */
const wrapperStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 2,
  whiteSpace: 'nowrap',
}
const badgeStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  height: 30,
  padding: '0 6px',
  fontSize: 11,
  lineHeight: '16px',
  color: 'var(--dsw-alias-label-tertiary)',
  font: 'inherit',
}
const poolStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 3 }
const separatorStyle: CSSProperties = { opacity: 0.5 }
const refreshStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 20,
  height: 20,
  padding: 0,
  border: 0,
  borderRadius: 6,
  background: 'transparent',
  color: 'var(--dsw-alias-label-tertiary)',
  font: 'inherit',
  fontSize: 12,
  lineHeight: '16px',
  cursor: 'pointer',
}

/** Narrow an unknown JSON value to the route's document. */
function isPointsDocument(value: unknown): value is AStudioWebPoints {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const status = (value as Record<string, unknown>)['status']
  return status === 'ok' || status === 'signed-out' || status === 'expired' || status === 'unavailable'
}

/**
 * Render the badge for one session's composer.
 *
 * A `null`/`undefined` selection means the host's projection is still loading;
 * the component renders nothing and keeps its subscription either way.
 */
export function AStudioPointsBadge({ directory, t }: AStudioPointsBadgeProps): React.ReactElement | null {
  const subscribe = useCallback((listener: () => void) => directory.subscribe(listener), [directory])
  const snapshot = useCallback(() => directory.getSnapshot(), [directory])
  // Treating `null` and `undefined` alike matters: the store uses both for
  // "not resolved yet", and dereferencing either would crash this entry.
  const selection = useSyncExternalStore(subscribe, snapshot, snapshot).current

  const [points, setPoints] = useState<AStudioWebPoints>()
  const [busy, setBusy] = useState(false)

  const show = selection != null && selection.provider === ASTRO_PROVIDER

  const read = useCallback(async (fresh: boolean): Promise<void> => {
    setBusy(true)
    try {
      const response = await fetch(fresh ? `${ASTRO_POINTS_PATH}?refresh=1` : ASTRO_POINTS_PATH, {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      })
      const value: unknown = await response.json().catch(() => undefined)
      if (!response.ok || !isPointsDocument(value)) {
        setPoints({ status: 'unavailable' })
        return
      }
      setPoints(value)
    } catch {
      setPoints({ status: 'unavailable' })
    } finally {
      setBusy(false)
    }
  }, [])

  // One read when the seat becomes visible. Deliberately not keyed on the
  // balance itself: a re-render must not re-bill the account service.
  useEffect(() => {
    if (!show) return
    void read(false)
  }, [show, read])

  if (!show) return null
  // Signed out means there is no account whose balance this seat could report.
  if (points?.status === 'signed-out') return null

  const numbers = points?.status === 'ok' ? points : undefined
  const failure = points !== undefined && points.status !== 'ok'
    ? points.status === 'expired' ? t('pointsExpired') : t('pointsUnavailable')
    : undefined

  return (
    <span style={wrapperStyle}>
      <span style={badgeStyle}>
        {numbers === undefined ? null : (
          <>
            <span style={poolStyle}>
              <span>{t('generalPoints')}</span>
              <span>{numbers.general.remaining}</span>
            </span>
            {numbers.spark === undefined ? null : (
              <>
                <span aria-hidden="true" style={separatorStyle}>·</span>
                <span style={poolStyle}>
                  <span>{t('sparkPoints')}</span>
                  <span>{numbers.spark.remaining}</span>
                </span>
              </>
            )}
          </>
        )}
        {failure === undefined ? null : <span>{failure}</span>}
      </span>
      <button
        type="button"
        style={refreshStyle}
        aria-label={t('refreshPoints')}
        title={t('refreshPoints')}
        disabled={busy}
        onClick={() => { void read(true) }}
      >
        ↻
      </button>
    </span>
  )
}
