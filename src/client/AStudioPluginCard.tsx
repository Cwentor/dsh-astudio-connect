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
 * They also commit differently. The roster is edited as a **draft** and written
 * only when the user presses Save, because flipping seven switches to decide
 * which models to offer is one intention, not seven; writing each flip
 * separately left DSH's picker changing under the user while they were still
 * thinking. Probing stays immediate: it spends an upstream request per press, so
 * a press has to mean "go now".
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

/** How long a finished probe's row stays tinted, and its verdict announced. */
const PROBE_FLASH_MS = 1_400
const ANNOUNCE_MS = 4_000

/** How long the "saved" confirmation stays up. */
const SAVED_NOTICE_MS = 3_000

/** Brand colour fallbacks: the card must render on a host with no token set. */
const BRAND = 'var(--dsw-alias-brand-primary, #2f6fed)'

/**
 * Motion shared by every pressable button.
 *
 * A pointer press has to be answered inside a frame or it reads as a dropped
 * click, so the press transition is deliberately shorter than the release one:
 * down in 40 ms, back up in 110 ms.
 */
const PRESS_DOWN_MS = 40
const PRESS_UP_MS = 110

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
const errorStyle: CSSProperties = { ...bodyStyle, color: 'var(--dsw-alias-state-error-primary)' }
const headingStyle: CSSProperties = { margin: '12px 0 6px', fontSize: 14, lineHeight: '20px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
const headingRowStyle: CSSProperties = { ...headingStyle, display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }
const headingCountStyle: CSSProperties = { fontSize: 12, lineHeight: '18px', fontWeight: 400, color: 'var(--dsw-alias-label-tertiary)' }

/**
 * Button faces. `boxShadow` and `transition` live on the base so hover and
 * press states can be plain inline overrides — the card ships no stylesheet and
 * therefore has no `:hover` / `:active` rules to lean on.
 */
const buttonStyle: CSSProperties = {
  boxSizing: 'border-box',
  minHeight: 34,
  padding: '6px 14px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 18,
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  fontSize: 14,
  cursor: 'pointer',
  // A press must not also start a text selection or, on touch, wait 300 ms for
  // a possible double-tap zoom — both read as lag on the click that follows.
  userSelect: 'none',
  touchAction: 'manipulation',
  boxShadow: '0 1px 2px rgba(15, 23, 42, 0.06)',
  transition: `transform ${PRESS_UP_MS}ms cubic-bezier(0.2, 0, 0.2, 1), box-shadow ${PRESS_UP_MS}ms ease, background-color ${PRESS_UP_MS}ms ease, border-color ${PRESS_UP_MS}ms ease, opacity ${PRESS_UP_MS}ms ease`,
}
const smallButtonStyle: CSSProperties = { ...buttonStyle, minHeight: 30, padding: '4px 12px', fontSize: 13 }
const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  minHeight: 30,
  padding: '4px 14px',
  fontSize: 13,
  fontWeight: 500,
  border: '1px solid transparent',
  background: BRAND,
  color: 'var(--dsw-alias-on-brand, #ffffff)',
}
const compactButtonStyle: CSSProperties = {
  ...smallButtonStyle,
  width: 104,
  justifySelf: 'end',
  padding: '4px 10px',
  whiteSpace: 'nowrap',
}

/**
 * Interaction states, applied by {@link PressableButton}.
 *
 * `translateY(1px)` plus an inset shadow is the whole trick: the button moves
 * away from the pointer and the light now falls *inside* it, which is what a
 * physical key does. The 0.965 scale keeps it from looking like the whole row
 * shifted.
 */
const hoverButtonStyle: CSSProperties = {
  transform: 'translateY(-1px)',
  boxShadow: '0 3px 8px rgba(15, 23, 42, 0.12)',
  borderColor: 'var(--dsw-alias-border-l3, rgba(15, 23, 42, 0.22))',
}
const pressedButtonStyle: CSSProperties = {
  transform: 'translateY(1px) scale(0.965)',
  boxShadow: 'inset 0 2px 4px rgba(15, 23, 42, 0.26)',
  filter: 'brightness(0.96)',
  transition: `transform ${PRESS_DOWN_MS}ms ease-out, box-shadow ${PRESS_DOWN_MS}ms ease-out, filter ${PRESS_DOWN_MS}ms ease-out`,
}
const inertButtonStyle: CSSProperties = {
  opacity: 0.5,
  cursor: 'default',
  boxShadow: 'none',
  transform: 'none',
  filter: 'none',
}

/** Lets a screen reader hear a result that appeared without focus moving. */
const visuallyHiddenStyle: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
}

/** "n unsaved" chip in the card header, so collapsing cannot hide lost edits. */
const pendingBadgeStyle: CSSProperties = {
  flex: 'none',
  padding: '1px 8px',
  borderRadius: 999,
  fontSize: 11,
  lineHeight: '18px',
  whiteSpace: 'nowrap',
  background: 'var(--dsw-alias-state-warning-subtle, rgba(178, 94, 9, 0.12))',
  color: 'var(--dsw-alias-state-warning-primary, #b25e09)',
}

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
  accentColor: BRAND,
}

/** Save bar under the roster: one status line, two actions. */
const saveRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  flexWrap: 'wrap',
  gap: 8,
  marginTop: 10,
}
const saveHintStyle: CSSProperties = { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }
const saveDirtyStyle: CSSProperties = { ...saveHintStyle, color: 'var(--dsw-alias-state-warning-primary, #b25e09)' }
const saveOkStyle: CSSProperties = { ...saveHintStyle, color: 'var(--dsw-alias-state-success-primary, #22a06b)' }
const saveActionsStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }

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
  // Negative margin with matching padding: the row tint needs breathing room
  // around it, but the grid columns must stay aligned with the heading.
  margin: '0 -8px',
  padding: '6px 8px',
  borderRadius: 6,
  transition: 'background-color 160ms ease',
}
const probeRowDividerStyle: CSSProperties = { borderTop: '1px solid var(--dsw-alias-border-l2)' }
/** While this row's probe is in flight. */
const probeRowBusyStyle: CSSProperties = { background: 'var(--dsw-alias-bg-layer-1, rgba(15, 23, 42, 0.04))' }
/** Just after a probe landed: the verdict may have changed under the pointer. */
const probeRowFlashStyle: CSSProperties = { background: 'var(--dsw-alias-bg-brand-subtle, rgba(47, 111, 237, 0.10))' }
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

/**
 * The device's haptic tick, where the platform has one.
 *
 * Called on **press-down**, not on click: a tick that arrives after the network
 * round trip tells the finger nothing. Desktop Electron and most embedded
 * webviews expose no vibration motor, so this is a no-op there — which is why
 * the press also has a visual response, and why this may never throw: a blocked
 * vibration call is not a reason to lose the click.
 */
function hapticTick(): void {
  const navigatorLike = globalThis.navigator as { vibrate?: (pattern: number | number[]) => boolean } | undefined
  const vibrate = navigatorLike?.vibrate
  if (typeof vibrate !== 'function') return
  try {
    vibrate.call(navigatorLike, 8)
  } catch {
    // Ignored on purpose; see above.
  }
}

/** Button faces `PressableButton` can render. */
type PressableVariant = 'secondary' | 'primary' | 'compact'

interface PressableButtonProps {
  label: string
  variant: PressableVariant
  disabled?: boolean | undefined
  /** When set, the button renders this label instead and counts as in flight. */
  busyLabel?: string | undefined
  /** Layout only (width, justification); state styling stays with the variant. */
  style?: CSSProperties | undefined
  onActivate: () => void
}

/**
 * A button that answers the pointer.
 *
 * The card ships no stylesheet, so `:hover` / `:active` are unavailable and the
 * three states are tracked in component state instead. Keeping this in its own
 * component is what makes that affordable: hover and press are per-button
 * concerns, and hoisting them into the card would re-render every row on every
 * mouse move.
 */
function PressableButton({
  label,
  variant,
  disabled = false,
  busyLabel,
  style,
  onActivate,
}: PressableButtonProps): React.ReactElement {
  const [pressed, setPressed] = useState(false)
  const [hovered, setHovered] = useState(false)
  const working = busyLabel !== undefined
  const inert = disabled || working
  const base = variant === 'primary' ? primaryButtonStyle : variant === 'compact' ? compactButtonStyle : smallButtonStyle

  const stateStyle: CSSProperties = inert
    ? inertButtonStyle
    : pressed
      ? pressedButtonStyle
      : hovered
        ? hoverButtonStyle
        : {}

  const beginPress = (): void => {
    if (inert) return
    setPressed(true)
    hapticTick()
  }

  return (
    <button
      type="button"
      style={{ ...base, ...stateStyle, ...style }}
      disabled={inert}
      aria-busy={working}
      onPointerDown={beginPress}
      onPointerUp={() => { setPressed(false) }}
      onPointerCancel={() => { setPressed(false) }}
      onPointerEnter={event => { if (!inert && event.pointerType === 'mouse') setHovered(true) }}
      onPointerLeave={() => { setHovered(false); setPressed(false) }}
      onKeyDown={event => {
        // Native buttons fire click on Enter down and Space up; the visual
        // press has to follow the same keys or the keyboard feels dead.
        if (event.key !== 'Enter' && event.key !== ' ') return
        if (event.repeat) return
        beginPress()
      }}
      onKeyUp={() => { setPressed(false) }}
      onBlur={() => { setHovered(false); setPressed(false) }}
      onClick={() => { if (!inert) onActivate() }}
    >
      {working ? busyLabel : label}
    </button>
  )
}

/**
 * Render the AStudio sign-in state, model roster, and probe observations as one
 * expandable card.
 *
 * The card reads the status document on mount and every `POLL_INTERVAL_MS`
 * while open; a failed read never discards the document already on screen.
 * Writes (probe, visibility) are POSTs carrying the control key from that
 * document, and each one re-reads the document afterwards rather than guessing
 * the new state locally.
 *
 * Roster switches edit a draft that is submitted by Save; a poll landing mid-
 * edit therefore cannot overwrite what the user is deciding, because the draft
 * is keyed by model id and wins over the document per row.
 */
export function AStudioPluginCard({ t }: AStudioPluginCardProps): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<AStudioWebStatus>()
  const [readFailure, setReadFailure] = useState<string>()
  const [refreshing, setRefreshing] = useState(false)
  /** Unsaved roster edits: model id → the visibility the user wants. */
  const [draft, setDraft] = useState<Record<string, boolean>>({})
  const [saving, setSaving] = useState(false)
  const [saveFailure, setSaveFailure] = useState<string>()
  const [savedTick, setSavedTick] = useState(0)
  /** Model whose probe is in flight; every other probe waits for it. */
  const [probingId, setProbingId] = useState<string>()
  const [probeFailure, setProbeFailure] = useState<string>()
  /** Model whose probe just landed, for the row tint and the announcement. */
  const [flashId, setFlashId] = useState<string>()
  const [announceId, setAnnounceId] = useState<string>()
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

  // Transient feedback: the tint and the announcement both clear themselves, so
  // the card returns to rest without the user having to acknowledge anything.
  useEffect(() => {
    if (flashId === undefined) return
    const timer = setTimeout(() => { setFlashId(undefined) }, PROBE_FLASH_MS)
    return () => { clearTimeout(timer) }
  }, [flashId])

  useEffect(() => {
    if (announceId === undefined) return
    const timer = setTimeout(() => { setAnnounceId(undefined) }, ANNOUNCE_MS)
    return () => { clearTimeout(timer) }
  }, [announceId])

  useEffect(() => {
    if (savedTick === 0) return
    const timer = setTimeout(() => { setSavedTick(0) }, SAVED_NOTICE_MS)
    return () => { clearTimeout(timer) }
  }, [savedTick])

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

  const models = status === undefined ? [] : status.catalog.models
  const catalogFailure = status?.catalog.failure
  const probeResults = status === undefined ? [] : status.probe.results
  const hiddenIds = new Set(status === undefined ? [] : status.visibility.hidden)
  const signedIn = status?.auth.state === 'signed-in'
  const controlsReady = status?.controlKey !== undefined
  const pendingCount = Object.keys(draft).length
  const dirty = pendingCount > 0

  // The draft wins per row: a poll that lands mid-edit updates everything else
  // on the card but cannot move a switch the user has already decided about.
  const shownFor = (modelId: string): boolean =>
    modelId in draft ? draft[modelId] === true : !hiddenIds.has(modelId)
  // The count is phrased as a consequence of saving while the draft is dirty,
  // because DSH does not see these switches yet. After a failed save it goes
  // back to describing what DSH actually has: a draft that the host refused is
  // no longer a prediction of the outcome.
  const exposedCount = models.filter(model => shownFor(model.id)).length
  const savedExposedCount = models.filter(model => !hiddenIds.has(model.id)).length
  const previewExposure = dirty && saveFailure === undefined
  const allHidden = models.length > 0 && exposedCount === 0

  /** Run one probe and re-read the card afterwards. */
  const runProbe = async (modelId: string): Promise<void> => {
    if (probingId !== undefined) return
    setProbingId(modelId)
    setProbeFailure(undefined)
    const failure = await postControl(`${ASTRO_PROBE_PATH}/${encodeURIComponent(modelId)}`, { effort: 'low' })
    await refresh()
    if (!mounted.current) return
    setProbingId(undefined)
    if (failure !== undefined) {
      setProbeFailure(failure)
      return
    }
    // Both are read back off the refreshed document rather than assumed: a
    // probe that returns `non-validating` is not persisted upstream, so the
    // verdict on screen is whatever the status route says it is.
    setFlashId(modelId)
    setAnnounceId(modelId)
  }

  /** Record one switch as a draft edit; nothing is written until Save. */
  const toggleModel = (modelId: string, visible: boolean): void => {
    const savedVisible = !hiddenIds.has(modelId)
    setSaveFailure(undefined)
    setSavedTick(0)
    setDraft(prev => {
      const next = { ...prev }
      // Toggling back to the committed value is not an edit: dropping the entry
      // is what makes Save disable itself again.
      if (visible === savedVisible) delete next[modelId]
      else next[modelId] = visible
      return next
    })
  }

  /**
   * Commit the draft, one model at a time.
   *
   * The visibility route is per model and its store is a read-modify-write of
   * one JSON file, so the writes are sequential on purpose: overlapping them
   * could lose an earlier entry. A poll may have landed a value that matches the
   * draft in the meantime — those rows are skipped rather than rewritten.
   */
  const saveDraft = async (): Promise<void> => {
    // Only roster ids can be written; an id the roster dropped would 404, and
    // its draft entry is no longer something the user can see.
    const targets = models
      .filter(model => model.id in draft)
      .map(model => ({ id: model.id, visible: draft[model.id] === true }))
      .filter(target => target.visible !== !hiddenIds.has(target.id))
    if (targets.length === 0) {
      setDraft({})
      return
    }

    setSaving(true)
    setSaveFailure(undefined)
    setSavedTick(0)
    const failed: string[] = []
    for (const target of targets) {
      const failure = await postControl(`${ASTRO_VISIBILITY_PATH}/${encodeURIComponent(target.id)}`, { visible: target.visible })
      if (failure !== undefined) failed.push(target.id)
    }
    await refresh()
    if (!mounted.current) return
    setSaving(false)
    // A row the host refused stays in the draft: dropping it would make the
    // switch silently agree with a host that never accepted the write.
    setDraft(prev => {
      const next: Record<string, boolean> = {}
      for (const id of failed) {
        const value = prev[id]
        if (value !== undefined) next[id] = value
      }
      return next
    })
    if (failed.length > 0) setSaveFailure(t('modelSaveFailed', { count: failed.length }))
    else setSavedTick(tick => tick + 1)
  }

  /** Drop the draft without writing anything. */
  const discardDraft = (): void => {
    setDraft({})
    setSaveFailure(undefined)
    setSavedTick(0)
  }

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

  /** The sentence a screen reader hears once a probe has landed. */
  const announcementFor = (modelId: string): string => {
    const model = models.find(entry => entry.id === modelId)
    if (model === undefined) return ''
    const result = probeResults.find(entry => entry.modelId === modelId)
    const verdict = result === undefined
      ? t('probeNotRun')
      : t(result.validation === 'validating' ? 'probeValidating' : 'probeNonValidating')
    return `${model.name} · ${verdict}`
  }

  // One line carries all four states of the save bar: failed, dirty, clean and
  // just-saved. Failure and dirty share the warning colour — both mean "the
  // switches on screen are not what DSH is being offered".
  const hintStyle = saveFailure !== undefined || dirty
    ? saveDirtyStyle
    : savedTick === 0
      ? saveHintStyle
      : saveOkStyle
  const saveHintText = saveFailure !== undefined
    ? saveFailure
    : dirty
      ? t('modelPending', { count: pendingCount })
      : savedTick === 0
        ? t('modelCleanHint')
        : t('modelSaved')

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
        {/* Visible whether or not the body is open: a collapsed card that holds
            unsaved switches has to say so, or closing it looks like a commit. */}
        {dirty ? <span style={pendingBadgeStyle}>{t('modelPendingBadge', { count: pendingCount })}</span> : null}
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
            <PressableButton
              variant="secondary"
              label={t('refresh')}
              busyLabel={refreshing ? t('refreshing') : undefined}
              onActivate={() => {
                setRefreshing(true)
                void refresh().finally(() => { if (mounted.current) setRefreshing(false) })
              }}
            />
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
                          /* No network here: the switch is a draft edit, and the
                             Save button is the only thing that writes. */
                          disabled={saving || !controlsReady}
                          aria-label={t('modelToggle', { name: model.name })}
                          onChange={() => { toggleModel(model.id, !shownFor(model.id)) }}
                        />
                      </label>
                    ))}
                  </div>
                  <p style={allHidden ? errorStyle : bodyStyle}>
                    {t(previewExposure ? 'modelExposurePending' : 'modelExposure', {
                      shown: previewExposure ? exposedCount : savedExposedCount,
                      total: models.length,
                    })}
                  </p>
                  {allHidden ? <p style={errorStyle}>{t('modelNoneExposed')}</p> : null}

                  <div style={saveRowStyle}>
                    <p style={hintStyle} role="status">{saveHintText}</p>
                    <div style={saveActionsStyle}>
                      <PressableButton
                        variant="secondary"
                        label={t('modelDiscard')}
                        disabled={!dirty || saving || !controlsReady}
                        onActivate={discardDraft}
                      />
                      <PressableButton
                        variant="primary"
                        label={t('modelSave')}
                        busyLabel={saving ? t('modelSaving') : undefined}
                        disabled={!dirty || !controlsReady}
                        onActivate={() => { void saveDraft() }}
                      />
                    </div>
                  </div>

                  <h3 style={headingRowStyle}>
                    <span>{t('probeHeading')}</span>
                    <span style={headingCountStyle}>
                      {t('probeSummary', { probed: probeResults.length, total: models.length })}
                    </span>
                  </h3>
                  <div style={probeTableStyle}>
                    {models.map((model, index) => {
                      const result = probeResults.find(r => r.modelId === model.id)
                      const probing = probingId === model.id
                      const rowStyleFor = index === 0 ? probeRowStyle : { ...probeRowStyle, ...probeRowDividerStyle }
                      const tint = probing
                        ? probeRowBusyStyle
                        : flashId === model.id
                          ? probeRowFlashStyle
                          : {}
                      return (
                        <div key={model.id} style={{ ...rowStyleFor, ...tint }}>
                          <span style={probeModelStyle} title={model.name}>{model.name}</span>
                          {result === undefined
                            ? <span style={probeIdleStyle}>{t('probeNotRun')}</span>
                            : (
                              <span style={result.validation === 'validating' ? probeChipOkStyle : probeChipWarnStyle}>
                                {t(result.validation === 'validating' ? 'probeValidating' : 'probeNonValidating')}
                                {result.efforts.length === 0 ? '' : ` · ${result.efforts.join('/')}`}
                              </span>
                            )}
                          <PressableButton
                            variant="compact"
                            label={result === undefined ? t('probeStart') : t('probeRedetect')}
                            busyLabel={probing ? t('probeRunning') : undefined}
                            /* One probe at a time: the others wait rather than
                               spend a second upstream request in parallel. */
                            disabled={probingId !== undefined || !controlsReady}
                            onActivate={() => { void runProbe(model.id) }}
                          />
                        </div>
                      )
                    })}
                  </div>
                  {probeFailure === undefined ? null : <p style={errorStyle}>{probeFailure}</p>}
                  {/* Mounted once and kept empty: a live region only announces
                      changes to a node that already existed. */}
                  <p aria-live="polite" style={visuallyHiddenStyle}>
                    {announceId === undefined ? '' : announcementFor(announceId)}
                  </p>
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
