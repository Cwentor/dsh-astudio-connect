/**
 * AStudio status card, mounted by the bundle configuration page the Plugins
 * page renders. The component is surface-agnostic — its only prop is the
 * injected copy `t`; all data comes from the same-origin status document, and
 * all writes go through the probe route keyed by the in-process probe key the
 * document carries.
 *
 * @module dsh-astudio-connect/client/AStudioPluginCard
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { ASTRO_PROBE_PATH, ASTRO_STATUS_PATH } from '../status-paths.ts'
import type { AStudioCatalogFailure, AStudioWebStatus } from '../status-paths.ts'
import { isAStudioWebStatus } from './status-document.ts'
import type { AStudioSettingsKey } from './locales.ts'

/** Localized copy injected by the browser-plugin registration. */
export interface AStudioPluginCardProps {
  t: (key: AStudioSettingsKey, params?: Record<string, unknown>) => string
}

/** Card copy for each reason the catalog has no live roster. */
const FAILURE_KEYS: Record<AStudioCatalogFailure, AStudioSettingsKey> = {
  'no-model-token': 'catalogFailureNoToken',
  'http-error': 'catalogFailureHttp',
  'invalid-payload': 'catalogFailurePayload',
  'network-error': 'catalogFailureNetwork',
  'empty-roster': 'catalogFailureRoster',
}

/** How often the card re-reads the status document while it is open. */
const POLL_INTERVAL_MS = 60_000

/** Header + body styles. Kept inline so the card renders without host CSS. */
const cardStyle: CSSProperties = {
  overflow: 'hidden',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 10,
  background: 'var(--dsw-alias-bg-module-platform)',
  listStyle: 'none',
  margin: 0,
}
const headerStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 16,
  border: 0,
  padding: '13px 14px',
  background: 'transparent',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
}
const headTextStyle: CSSProperties = { display: 'flex', minWidth: 0, flexDirection: 'column', gap: 3 }
const nameStyle: CSSProperties = { fontSize: 14, lineHeight: '20px', fontWeight: 600 }
const descriptionStyle: CSSProperties = { fontSize: 13, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }
const cardBodyStyle: CSSProperties = { borderTop: '1px solid var(--dsw-alias-border-l2)', padding: '16px 14px 18px' }
const bodyStyle: CSSProperties = { margin: 0, fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-secondary)' }
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }
const statusStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 9, fontSize: 15, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }
const buttonStyle: CSSProperties = { boxSizing: 'border-box', minHeight: 34, padding: '6px 14px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 18, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 14, cursor: 'pointer' }
const errorStyle: CSSProperties = { ...bodyStyle, color: 'var(--dsw-alias-state-error-primary)' }
const listStyle: CSSProperties = { margin: 0, padding: '0 0 0 18px' }
const probeRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }
const probeNameStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)' }
const probeChipStyle: CSSProperties = {
  padding: '1px 8px', borderRadius: 999, fontSize: 11, lineHeight: '18px',
  background: 'var(--dsw-alias-state-success-subtle, rgba(34, 160, 107, 0.12))',
  color: 'var(--dsw-alias-state-success-primary, #22a06b)',
}
const headingStyle: CSSProperties = { margin: '12px 0 6px', fontSize: 14, lineHeight: '20px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }

/**
 * Render the AStudio sign-in state and catalog as one expandable card.
 *
 * The card reads the status document on mount and every `POLL_INTERVAL_MS`
 * while open; a failed read never discards the document already on screen, and
 * a probe is a write that carries the probe key from the document.
 */
export function AStudioPluginCard({ t }: AStudioPluginCardProps): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<AStudioWebStatus>()
  const [readFailure, setReadFailure] = useState<string>()
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)
  const readSeq = useRef(0)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  /**
   * Read the status document and apply it.
   *
   * A non-document body is a failed read, not something to store and then
   * dereference in the render; a failed read never discards a document already
   * on screen. Returns whether this read produced the current document.
   */
  const refresh = useCallback(async (signal?: AbortSignal): Promise<boolean> => {
    const seq = ++readSeq.current
    const current = (): boolean => mounted.current && signal?.aborted !== true && seq === readSeq.current
    try {
      const response = await fetch(ASTRO_STATUS_PATH, {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        ...signal === undefined ? {} : { signal },
      })
      const value: unknown = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      if (!isAStudioWebStatus(value)) throw new Error(t('statusResponseInvalid'))
      if (!current()) return false
      setStatus(value)
      setReadFailure(undefined)
      return true
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : t('requestFailed')
      if (current()) setReadFailure(message)
      return false
    }
  }, [t])

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    void refresh(controller.signal)
    const timer = setInterval(() => { void refresh(controller.signal) }, POLL_INTERVAL_MS)
    return () => {
      clearInterval(timer)
      controller.abort()
    }
  }, [open, refresh])

  /**
   * Run one probe and refresh the card afterwards.
   *
   * The probe key travels in a header, not the body: it authorizes the write,
   * and the host never accepts a probe for a model outside its own catalog.
   */
  const runProbe = useCallback(async (modelId: string): Promise<void> => {
    const key = status?.probeKey
    if (key === undefined) return
    setBusy(true)
    try {
      const response = await fetch(`${ASTRO_PROBE_PATH}/${modelId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-astudio-probe-key': key },
        credentials: 'same-origin',
        body: JSON.stringify({ effort: 'low' }),
      })
      if (!response.ok) {
        const value: unknown = await response.json().catch(() => undefined)
        const message = typeof value === 'object' && value !== null && 'error' in value
          ? String((value as Record<string, unknown>).error)
          : `HTTP ${response.status}`
        throw new Error(message)
      }
    } catch (error: unknown) {
      if (mounted.current) setReadFailure(error instanceof Error ? error.message : t('requestFailed'))
      return
    } finally {
      if (mounted.current) setBusy(false)
    }
    await refresh()
  }, [status, refresh, t])

  const label = status === undefined
    ? t('loading')
    : status.auth.state === 'signed-in'
      ? t('signedIn')
      : t('signedOut')
  const catalogSource = status === undefined
    ? ''
    : status.catalog.source === 'live'
      ? t('catalogLive')
      : status.catalog.source === 'saved'
        ? t('catalogSaved')
        // An empty catalog is explained by its own notice below; naming its
        // "source" here would only restate that there is none.
        : ''
  const models = status === undefined ? [] : status.catalog.models
  const catalogFailure = status?.catalog.failure
  const probeResults = status === undefined ? [] : status.probe.results
  const signedIn = status?.auth.state === 'signed-in'

  return (
    <li style={cardStyle}>
      <button
        type="button"
        style={headerStyle}
        aria-expanded={open}
        aria-label={`${t('refresh')}: ${t('title')}`}
        onClick={() => { setOpen(!open) }}
      >
        <span style={headTextStyle}>
          <span style={nameStyle}>{t('title')}</span>
          <span style={descriptionStyle}>{t('intro')}</span>
        </span>
        <span aria-hidden="true" style={{ transform: open ? 'rotate(180deg)' : 'none' }}>⌄</span>
      </button>
      {open ? (
        <div style={cardBodyStyle}>
          <h3 style={headingStyle}>{t('accountHeading')}</h3>
          <div style={rowStyle}>
            <div style={statusStyle} role="status" aria-busy={status === undefined}>
              <span aria-hidden="true">●</span>
              <span>{label}</span>
            </div>
            <button type="button" style={buttonStyle} disabled={busy} onClick={() => { void refresh() }}>
              {busy ? t('refreshing') : t('refresh')}
            </button>
          </div>
          {catalogSource !== '' ? <p style={bodyStyle}>{catalogSource}</p> : null}
          {readFailure !== undefined && status !== undefined ? <p style={errorStyle}>{readFailure}</p> : null}

          {signedIn ? (
            <>
              <h3 style={headingStyle}>{t('contextHeading')}</h3>
              {models.length === 0 ? (
                <div role="status">
                  <p style={bodyStyle}>{t('catalogEmpty')}</p>
                  {catalogFailure === undefined ? null : <p style={bodyStyle}>{t(FAILURE_KEYS[catalogFailure])}</p>}
                </div>
              ) : (
                <ul style={listStyle}>
                  {models.map(model => (
                    <li key={model.id} style={bodyStyle}>
                      <span>{model.name}</span>
                    </li>
                  ))}
                </ul>
              )}

              {models.length === 0 ? null : (
                <>
                  <h3 style={headingStyle}>{t('probeHeading')}</h3>
                  <div style={probeRowStyle}>
                    <span style={bodyStyle}>
                      {probeResults.length === 0 ? t('probeNoResult') : probeResults.map(r => r.modelId).join(', ')}
                    </span>
                    <span style={probeNameStyle}>
                      {models.map(model => {
                        const result = probeResults.find(r => r.modelId === model.id)
                        return (
                          <span key={model.id} style={probeRowStyle}>
                            <span>{model.name}</span>
                            {result === undefined ? null
                              : <span style={probeChipStyle}>{result.validation}: {result.efforts.join('/')}</span>}
                            <button
                              type="button"
                              style={buttonStyle}
                              disabled={busy || status?.probeKey === undefined}
                              onClick={() => { void runProbe(model.id) }}
                            >
                              {result === undefined ? t('probeStart') : t('probeRedetect')}
                            </button>
                          </span>
                        )
                      })}
                    </span>
                  </div>
                </>
              )}
            </>
          ) : (status !== undefined && readFailure !== undefined) ? (
            <p style={errorStyle}>{readFailure}</p>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}
