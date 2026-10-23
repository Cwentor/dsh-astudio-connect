/**
 * AStudio status card, mounted by the bundle configuration page the Plugins
 * page renders. The component is surface-agnostic — its only prop is the
 * injected copy `t`; all data comes from the same-origin status document, and
 * all writes go through the control routes, authorized by the in-process key
 * the document carries.
 *
 * Two things are edited here, and they are deliberately separate sections: the
 * model roster (which models DSH is offered) and the probe state (which
 * reasoning efforts each model actually accepts). One is a preference, the
 * other an observation; mixing them in one row is what made the old layout
 * collapse into a single wrapped line.
 *
 * @module dsh-astudio-connect/client/AStudioPluginCard
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import {
  ASTRO_CONTROL_KEY_HEADER,
  ASTRO_PROBE_PATH,
  ASTRO_STATUS_PATH,
  ASTRO_VISIBILITY_PATH,
} from '../status-paths.ts'
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
const headingStyle: CSSProperties = { margin: '12px 0 6px', fontSize: 14, lineHeight: '20px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
const headingRowStyle: CSSProperties = { ...headingStyle, display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }
const headingCountStyle: CSSProperties = { fontSize: 12, lineHeight: '18px', fontWeight: 400, color: 'var(--dsw-alias-label-tertiary)' }

/**
 * Model roster: one `<label>` per model so the whole row toggles, with the id
 * on a second, quieter line — the id is what appears in DSH's own logs, and a
 * name that differs from it is not enough to find the row again.
 */
const modelListStyle: CSSProperties = {
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  overflow: 'hidden',
}
const modelRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: '6px 10px',
  cursor: 'pointer',
}
const modelRowDividerStyle: CSSProperties = { borderTop: '1px solid var(--dsw-alias-border-l2)' }
const modelTextStyle: CSSProperties = { display: 'flex', minWidth: 0, flexDirection: 'column', gap: 1 }
const modelNameStyle: CSSProperties = {
  fontSize: 13,
  lineHeight: '20px',
  color: 'var(--dsw-alias-label-primary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
const modelIdStyle: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 11,
  lineHeight: '16px',
  color: 'var(--dsw-alias-label-tertiary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
const modelSwitchStyle: CSSProperties = {
  flex: 'none',
  width: 16,
  height: 16,
  margin: 0,
  cursor: 'pointer',
  accentColor: 'var(--dsw-alias-brand-primary, #2f6fed)',
}

/**
 * Probe table: a three-column grid per row — name, verdict, action.
 *
 * The action column is a fixed width so the buttons line up whatever the label
 * is (`Probe` / `Re-probe`, `探测` / `重新探测`); the name column takes the
 * remaining space and ellipsises instead of wrapping. That is the whole fix for
 * the old row, which let all seven models share one flex line.
 */
const probeTableStyle: CSSProperties = { margin: 0 }
const probeRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto 104px',
  columnGap: 12,
  alignItems: 'center',
  padding: '6px 0',
}
const probeRowDividerStyle: CSSProperties = { borderTop: '1px solid var(--dsw-alias-border-l2)' }
const probeModelStyle: CSSProperties = {
  fontSize: 13,
  lineHeight: '20px',
  color: 'var(--dsw-alias-label-primary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
const probeIdleStyle: CSSProperties = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }
const probeChipBaseStyle: CSSProperties = {
  justifySelf: 'start',
  padding: '1px 8px',
  borderRadius: 999,
  fontSize: 11,
  lineHeight: '18px',
  whiteSpace: 'nowrap',
}
const probeChipOkStyle: CSSProperties = {
  ...probeChipBaseStyle,
  background: 'var(--dsw-alias-state-success-subtle, rgba(34, 160, 107, 0.12))',
  color: 'var(--dsw-alias-state-success-primary, #22a06b)',
}
const probeChipWarnStyle: CSSProperties = {
  ...probeChipBaseStyle,
  background: 'var(--dsw-alias-state-warning-subtle, rgba(178, 94, 9, 0.12))',
  color: 'var(--dsw-alias-state-warning-primary, #b25e09)',
}
const probeButtonStyle: CSSProperties = {
  ...buttonStyle,
  boxSizing: 'border-box',
  width: 104,
  minHeight: 30,
  padding: '4px 10px',
  fontSize: 13,
  justifySelf: 'end',
  whiteSpace: 'nowrap',
}

/**
 * Render the AStudio sign-in state, model roster, and probe observations as one
 * expandable card.
 *
 * The card reads the status document on mount and every `POLL_INTERVAL_MS`
 * while open; a failed read never discards the document already on screen.
 * Writes (probe, visibility) are POSTs carrying the control key from that
 * document, and each one re-reads the document afterwards rather than guessing
 * the new state locally — except for the switch's own knob, which follows the
 * in-flight intent until the read lands.
 */
export function AStudioPluginCard({ t }: AStudioPluginCardProps): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<AStudioWebStatus>()
  const [readFailure, setReadFailure] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [toggling, setToggling] = useState<{ id: string, shown: boolean }>()
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
   * Send one control write and report its failure message.
   *
   * The key travels in a header, not the body: it authorizes the write, and a
   * body is what ends up in logs. Callers re-read the status document
   * afterwards — the host is the only authority on what actually changed.
   */
  const postControl = useCallback(async (path: string, body: unknown): Promise<string | undefined> => {
    const key = status?.controlKey
    if (key === undefined) return t('controlsUnavailable')
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [ASTRO_CONTROL_KEY_HEADER]: key },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      })
      if (response.ok) return undefined
      const value: unknown = await response.json().catch(() => undefined)
      return typeof value === 'object' && value !== null && 'error' in value
        ? String((value as Record<string, unknown>).error)
        : `HTTP ${response.status}`
    } catch (error: unknown) {
      return error instanceof Error ? error.message : t('requestFailed')
    }
  }, [status, t])

  /** Run one probe and re-read the card afterwards. */
  const runProbe = useCallback(async (modelId: string): Promise<void> => {
    setBusy(true)
    const failure = await postControl(`${ASTRO_PROBE_PATH}/${encodeURIComponent(modelId)}`, { effort: 'low' })
    await refresh()
    if (!mounted.current) return
    setBusy(false)
    if (failure !== undefined) setReadFailure(failure)
  }, [postControl, refresh])

  /**
   * Show or hide one model for DSH, then re-read the roster's hidden list.
   *
   * The card allows one visibility write at a time (every switch is disabled
   * while `toggling` is set). That is both what keeps the knob honest and what
   * protects the store: its write is a read-modify-write of one JSON file, so
   * two overlapped toggles could lose the first one.
   */
  const setModelVisible = useCallback(async (modelId: string, visible: boolean): Promise<void> => {
    setToggling({ id: modelId, shown: visible })
    const failure = await postControl(`${ASTRO_VISIBILITY_PATH}/${encodeURIComponent(modelId)}`, { visible })
    await refresh()
    if (!mounted.current) return
    setToggling(undefined)
    if (failure !== undefined) setReadFailure(failure)
  }, [postControl, refresh])

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
  const hiddenIds = new Set(status === undefined ? [] : status.visibility.hidden)
  const signedIn = status?.auth.state === 'signed-in'
  const controlsReady = status?.controlKey !== undefined
  // The switch knob follows the in-flight intent, not the last read: a local
  // file write is fast, but a switch that does not move on click reads broken.
  const shownFor = (modelId: string): boolean => toggling?.id === modelId ? toggling.shown : !hiddenIds.has(modelId)
  const exposedCount = models.filter(model => shownFor(model.id)).length
  const allHidden = models.length > 0 && exposedCount === 0

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
              <h3 style={headingStyle}>{t('modelHeading')}</h3>
              {models.length === 0 ? (
                <div role="status">
                  <p style={bodyStyle}>{t('catalogEmpty')}</p>
                  {catalogFailure === undefined ? null : <p style={bodyStyle}>{t(FAILURE_KEYS[catalogFailure])}</p>}
                </div>
              ) : (
                <>
                  <div style={modelListStyle}>
                    {models.map((model, index) => (
                      <label
                        key={model.id}
                        style={index === 0 ? modelRowStyle : { ...modelRowStyle, ...modelRowDividerStyle }}
                      >
                        <span style={modelTextStyle}>
                          <span style={modelNameStyle}>{model.name}</span>
                          <span style={modelIdStyle}>{model.id}</span>
                        </span>
                        <input
                          type="checkbox"
                          style={modelSwitchStyle}
                          checked={shownFor(model.id)}
                          disabled={busy || !controlsReady || toggling !== undefined}
                          aria-label={t('modelToggle', { name: model.name })}
                          /* The write is the negation of what the document
                             says, not of `event.target` — the render already
                             knows the current value, and reading it from the
                             DOM would break under a controlled input. */
                          onChange={() => { void setModelVisible(model.id, !shownFor(model.id)) }}
                        />
                      </label>
                    ))}
                  </div>
                  <p style={allHidden ? errorStyle : bodyStyle}>
                    {t('modelExposure', { shown: exposedCount, total: models.length })}
                  </p>
                  {allHidden ? <p style={errorStyle}>{t('modelNoneExposed')}</p> : null}

                  <h3 style={headingRowStyle}>
                    <span>{t('probeHeading')}</span>
                    <span style={headingCountStyle}>
                      {t('probeSummary', { probed: probeResults.length, total: models.length })}
                    </span>
                  </h3>
                  <div style={probeTableStyle}>
                    {models.map((model, index) => {
                      const result = probeResults.find(r => r.modelId === model.id)
                      return (
                        <div
                          key={model.id}
                          style={index === 0 ? probeRowStyle : { ...probeRowStyle, ...probeRowDividerStyle }}
                        >
                          <span style={probeModelStyle} title={model.name}>{model.name}</span>
                          {result === undefined
                            ? <span style={probeIdleStyle}>{t('probeNotRun')}</span>
                            : (
                              <span style={result.validation === 'validating' ? probeChipOkStyle : probeChipWarnStyle}>
                                {t(result.validation === 'validating' ? 'probeValidating' : 'probeNonValidating')}
                                {result.efforts.length === 0 ? '' : ` · ${result.efforts.join('/')}`}
                              </span>
                            )}
                          <button
                            type="button"
                            style={probeButtonStyle}
                            disabled={busy || !controlsReady}
                            onClick={() => { void runProbe(model.id) }}
                          >
                            {result === undefined ? t('probeStart') : t('probeRedetect')}
                          </button>
                        </div>
                      )
                    })}
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
