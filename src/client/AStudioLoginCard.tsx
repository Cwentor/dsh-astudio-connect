/**
 * The sign-in card of the AStudio points section.
 *
 * This is the part that makes the plugin independent of the AStudio app: a
 * WeChat QR sign-in performed here, against the same SSO the app uses, yields
 * the same model key and stores it under the DSH home. The app's own files stay
 * a fallback, so both ways of being signed in keep working — the card just says
 * which one is in use.
 *
 * Three things are deliberate about the interaction:
 *
 * - **The QR is a data URL**, served by the host route, so the panel loads
 *   nothing from a third-party origin.
 * - **Polling stops on any terminal answer.** Waiting forever on a code that
 *   was already exchanged would leave a spinner over a session that exists.
 * - **A finished sign-in is reported as a change, not a success** — the parent
 *   re-reads the balance, because a different account has different numbers.
 *
 * @module dsh-astudio-connect/client/AStudioLoginCard
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import type { AStudioWebLogin, AStudioWebQrPoll } from '../status-paths.ts'
import type { AStudioPointsSectionProps } from './AStudioPointsSection.tsx'
import { pollQrLogin, readControlKey, readStatus, signOut, startQrLogin } from './points-client.ts'

/** How often a live ticket is polled. */
const POLL_INTERVAL_MS = 2_000

/** Props: the section's copy seat, plus a callback for any credential change. */
export interface AStudioLoginCardProps {
  t: AStudioPointsSectionProps['t']
  /**
   * Run after a sign-in or sign-out lands.
   *
   * The section uses it to re-read the balance: a sign-in usually means a
   * different account, and a sign-out means the app's account — either way the
   * number on screen is stale.
   */
  onCredentialsChanged: () => void
}

const cardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '12px 16px',
  border: '0.5px solid var(--dsw-alias-settings-card-stroke)',
  borderRadius: 'var(--dsw-radius-xl)',
  background: 'var(--dsw-alias-settings-card-fill)',
}
const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 16,
  boxSizing: 'border-box',
  minHeight: 40,
  padding: '6px 0',
}
const dividerStyle: CSSProperties = { borderTop: '0.5px solid var(--dsw-alias-border-l2)' }
const hintStyle: CSSProperties = { color: 'var(--dsw-alias-label-tertiary)' }
const actionsStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }
const buttonStyle: CSSProperties = {
  boxSizing: 'border-box',
  height: 36,
  padding: '0 14px',
  border: '0.5px solid var(--dsw-alias-border-l3)',
  borderRadius: 'var(--dsw-radius-md)',
  background: 'transparent',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  fontSize: 14,
  lineHeight: '22px',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
}
const primaryStyle: CSSProperties = {
  ...buttonStyle,
  borderColor: 'transparent',
  background: 'var(--dsw-alias-button-primary-fill)',
  color: 'var(--dsw-alias-label-primary-foreground)',
  fontWeight: 500,
}
const busyStyle: CSSProperties = { opacity: 0.6, cursor: 'default' }
/** The QR block: centred, with a quiet frame so it reads as an object, not text. */
const qrPanelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 8,
  padding: '8px 0 4px',
}
const qrImageStyle: CSSProperties = {
  width: 180,
  height: 180,
  borderRadius: 'var(--dsw-radius-md)',
  background: '#fff',
  imageRendering: 'pixelated',
}
const accountListStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }

/** The poll's outcome as one line of copy. */
function scanHint(
  scan: AStudioWebQrPoll | undefined,
  t: AStudioLoginCardProps['t'],
): string {
  switch (scan?.status) {
    case undefined:
    case 'pending': return t('loginQrPending')
    case 'unbound': return t('loginQrUnbound')
    case 'select-account': return t('loginQrSelect')
    case 'expired': return t('loginQrExpired')
    case 'no-credential': return t('loginQrNoCredential')
    case 'unavailable': return t('loginQrFailed')
    // `authenticated` closes the panel before it can be rendered; naming it
    // here keeps the switch exhaustive for the next state added upstream.
    case 'authenticated': return t('loginQrHint')
  }
}

/** Whether the ticket is still worth polling. */
function keepsPolling(scan: AStudioWebQrPoll | undefined): boolean {
  return scan === undefined || scan.status === 'pending'
}

/** Render the card. */
export function AStudioLoginCard({ t, onCredentialsChanged }: AStudioLoginCardProps): ReactElement {
  const [login, setLogin] = useState<AStudioWebLogin>()
  const [busy, setBusy] = useState(false)
  const [ticket, setTicket] = useState<{ fd: string, image: string }>()
  const [scan, setScan] = useState<AStudioWebQrPoll>()
  const [chosen, setChosen] = useState<string>()
  const [notice, setNotice] = useState<string>()
  /**
   * The parent's callback, held in a ref.
   *
   * It is called from inside the poll loop, and a callback that changes
   * identity on every parent render would restart that loop — turning one poll
   * per interval into one per answered poll. The ref keeps the current function
   * without making it a dependency.
   */
  const changed = useRef(onCredentialsChanged)
  changed.current = onCredentialsChanged

  /** Re-read which sign-in is in use. */
  const refreshLogin = useCallback(async (): Promise<void> => {
    const status = await readStatus()
    setLogin(status?.login ?? { source: 'none' })
  }, [])

  useEffect(() => {
    void refreshLogin()
  }, [refreshLogin])

  /** Mint a ticket and show its code. */
  const start = useCallback(async (): Promise<void> => {
    setBusy(true)
    setNotice(undefined)
    setChosen(undefined)
    setScan(undefined)
    try {
      const key = await readControlKey()
      if (key === undefined) {
        setNotice(t('controlsUnavailable'))
        return
      }
      const answer = await startQrLogin(key)
      if (answer === undefined || answer.status !== 'ok') {
        setNotice(t('loginQrFailed'))
        return
      }
      setTicket({ fd: answer.fd, image: answer.image })
      setScan({ status: 'pending' })
    } finally {
      setBusy(false)
    }
  }, [t])

  // One poll loop per live ticket. The first read happens immediately (a code
  // scanned while the panel was painting would otherwise wait a full interval),
  // and the loop ends as soon as the answer is no longer "waiting".
  useEffect(() => {
    if (ticket === undefined) return
    let cancelled = false
    let timer: ReturnType<typeof setInterval> | undefined

    const stop = (): void => {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
    }

    const tick = async (): Promise<void> => {
      const key = await readControlKey()
      if (cancelled) return
      if (key === undefined) {
        setScan({ status: 'unavailable' })
        stop()
        return
      }
      const answer = await pollQrLogin(key, {
        fd: ticket.fd,
        ...(chosen === undefined ? {} : { accountId: chosen }),
      })
      if (cancelled) return
      if (answer === undefined) {
        setScan({ status: 'unavailable' })
        stop()
        return
      }
      setScan(answer)
      if (answer.status === 'authenticated') {
        setLogin(answer.login)
        setTicket(undefined)
        stop()
        changed.current()
        return
      }
      if (!keepsPolling(answer)) stop()
    }

    void tick()
    timer = setInterval(() => { void tick() }, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      stop()
    }
  }, [ticket, chosen])

  /** Forget the plugin's own sign-in and fall back to the app's. */
  const signOutNow = useCallback(async (): Promise<void> => {
    setBusy(true)
    setNotice(undefined)
    try {
      const key = await readControlKey()
      if (key === undefined) {
        setNotice(t('controlsUnavailable'))
        return
      }
      if (!await signOut(key)) {
        setNotice(t('loginQrFailed'))
        return
      }
      // Not "none" by assumption: clearing our file hands the question back to
      // the AStudio app, which may well be signed in.
      await refreshLogin()
      setTicket(undefined)
      setScan(undefined)
      changed.current()
    } finally {
      setBusy(false)
    }
  }, [t, refreshLogin])

  const source = login?.source
  const description = source === 'dsh'
    ? t('loginSourceDsh')
    : source === 'client'
      ? t('loginSourceClient')
      : source === 'none'
        ? t('loginNone')
        : t('loading')
  const account = login?.accountId === undefined ? undefined : t('loginAccount', { account: login.accountId })
  const detail = notice ?? (account === undefined ? description : `${description} · ${account}`)
  const accounts = scan?.status === 'select-account' ? scan.accounts : []

  return (
    <div style={cardStyle}>
      <div style={rowStyle}>
        <span>{t('loginHeading')}</span>
        <div style={actionsStyle}>
          {source === 'dsh' ? (
            <button
              type="button"
              style={busy ? { ...buttonStyle, ...busyStyle } : buttonStyle}
              aria-label={t('loginSignOut')}
              aria-busy={busy}
              disabled={busy}
              onClick={() => { void signOutNow() }}
            >
              {busy ? t('loginSigningOut') : t('loginSignOut')}
            </button>
          ) : (
            <button
              type="button"
              style={busy ? { ...primaryStyle, ...busyStyle } : primaryStyle}
              aria-label={t('loginQrStart')}
              aria-busy={busy}
              disabled={busy}
              onClick={() => { void start() }}
            >
              {busy ? t('loginQrStarting') : ticket === undefined ? t('loginQrStart') : t('loginQrAgain')}
            </button>
          )}
        </div>
      </div>
      {/* One live region: every sign-in verdict arrives without focus moving. */}
      <div role="status" style={hintStyle}>{detail}</div>
      {ticket === undefined ? null : (
        <>
          <div style={dividerStyle} />
          <div style={qrPanelStyle}>
            <img src={ticket.image} alt={t('loginQrHint')} style={qrImageStyle} />
            <span style={hintStyle}>{scanHint(scan, t)}</span>
            {accounts.length === 0 ? null : (
              <div style={accountListStyle}>
                {accounts.map(entry => (
                  <button
                    key={entry.accountId}
                    type="button"
                    style={buttonStyle}
                    aria-label={entry.username ?? entry.accountId}
                    onClick={() => { setChosen(entry.accountId) }}
                  >
                    {entry.username ?? entry.accountId}
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
