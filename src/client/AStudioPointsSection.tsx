/**
 * The AStudio section of DSH's Settings page: the sign-in card, the account's
 * two credit pools, the daily-reward press, and the balance refresh.
 *
 * Migrated wholesale from the composer badge. A balance is account state, not
 * session state, and the badge had to disappear in every session that was not
 * using an AStudio model — exactly the sessions where a user wondering "how many
 * points do I have left" is looking. Settings is where the account question
 * belongs, and it is also where the one write (claiming the daily reward) can
 * sit under its own name instead of behind a two-character button.
 *
 * The nav row arrives through `settings.section`; the shell mounts one section
 * at a time, so this component's lifetime is "the panel is open, showing us".
 * A sign-in or sign-out there re-reads the balance, because the account behind
 * the numbers may have just changed.
 * That is why its mount read is a *fresh* one: opening this page is a person
 * asking for the current number, not a composer appearing by itself.
 *
 * @module dsh-astudio-connect/client/AStudioPointsSection
 */

import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { AStudioWebPoints } from '../status-paths.ts'
import { AStudioLoginCard } from './AStudioLoginCard.tsx'
import { claimDailyReward, readControlKey, readPoints } from './points-client.ts'

/** Props the Settings shell delivers: this entry's copy, from its own namespace. */
export type AStudioPointsSectionProps = PropsLocale<'settings.astudio'>

/** How long a claim verdict stays on screen before the row returns to its hint. */
const CLAIM_NOTICE_MS = 6_000

/**
 * The panel's own chrome, in the Settings shell's register: 13/22 text, an
 * 8px top-and-bottom inset, and a 16px gap between blocks. The shell draws the
 * page title and the nav; this section draws only its card.
 */
const sectionStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: '8px 0',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 13,
  lineHeight: '22px',
}
/** The same card the account section renders: a hairline stroke, 12px/16px padding. */
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
/** Tabular figures keep the two amounts aligned while one of them re-renders. */
const amountStyle: CSSProperties = { fontVariantNumeric: 'tabular-nums', fontSize: 14, fontWeight: 500 }
const hintStyle: CSSProperties = { color: 'var(--dsw-alias-label-tertiary)' }
/** A booked reward reads as an increase, not as another annotation. */
const claimOkStyle: CSSProperties = { color: 'var(--dsw-alias-state-success-primary, #22a06b)' }
const actionsStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }
/** The shell's secondary button, sized to its label. */
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
/** The one action that changes something gets the filled treatment. */
const primaryStyle: CSSProperties = {
  ...buttonStyle,
  borderColor: 'transparent',
  background: 'var(--dsw-alias-button-primary-fill)',
  color: 'var(--dsw-alias-label-primary-foreground)',
  fontWeight: 500,
}
const busyStyle: CSSProperties = { opacity: 0.6, cursor: 'default' }

/**
 * The row's left-hand copy: what the panel knows, when nothing more recent has
 * been said.
 *
 * An exhaustive switch rather than a chain of ternaries, so adding a state to
 * {@link AStudioWebPoints} fails the build instead of silently rendering the
 * daily-reward hint over a broken session.
 */
function hintFor(
  status: AStudioWebPoints['status'] | undefined,
  t: AStudioPointsSectionProps['t'],
): string {
  switch (status) {
    case undefined: return t('loading')
    case 'ok': return t('pointsDailyHint')
    case 'signed-out': return t('pointsSignedOut')
    case 'expired': return t('pointsExpiredHint')
    case 'unavailable': return t('pointsRetryHint')
  }
}

/** Render the section. */
export function AStudioPointsSection({ t }: AStudioPointsSectionProps): ReactElement {
  const [points, setPoints] = useState<AStudioWebPoints>()
  const [busy, setBusy] = useState(false)
  const [claiming, setClaiming] = useState(false)
  /** Verdict of the last press: `claimed` is tinted, the rest stay dim. */
  const [notice, setNotice] = useState<{ ok: boolean, text: string }>()

  const read = useCallback(async (fresh: boolean): Promise<void> => {
    setBusy(true)
    try {
      // `readPoints` maps every failure to a named state, so there is no catch
      // branch here: a balance the host cannot answer is still an answer.
      setPoints(await readPoints(fresh))
    } finally {
      setBusy(false)
    }
  }, [])

  // The panel's one unprompted read. Fresh, not cached: see the module comment.
  useEffect(() => {
    void read(true)
  }, [read])

  // A claim verdict is transient: it clears itself so the row returns to its
  // hint without the user having to dismiss anything.
  useEffect(() => {
    if (notice === undefined) return
    const timer = setTimeout(() => { setNotice(undefined) }, CLAIM_NOTICE_MS)
    return () => { clearTimeout(timer) }
  }, [notice])

  /**
   * Book today's daily login reward.
   *
   * The balance the route returns is applied as-is — including a read that
   * failed — because after a booking the numbers on screen are otherwise the
   * pre-claim ones, and passing a stale number off as current is the one thing
   * this panel never does.
   */
  const claim = useCallback(async (): Promise<void> => {
    setClaiming(true)
    setNotice(undefined)
    try {
      const key = await readControlKey()
      if (key === undefined) {
        setNotice({ ok: false, text: t('controlsUnavailable') })
        return
      }
      const result = await claimDailyReward(key)
      if (result === undefined) {
        setNotice({ ok: false, text: t('pointsUnavailable') })
        return
      }
      if (result.status === 'claimed') {
        setPoints(result.balance)
        setNotice({
          ok: true,
          text: result.points === undefined ? t('claimedUnknown') : t('claimed', { points: result.points }),
        })
        return
      }
      if (result.status === 'signed-out' || result.status === 'expired') {
        setPoints({ status: result.status })
        if (result.status === 'expired') setNotice({ ok: false, text: t('pointsExpired') })
        return
      }
      if (result.status === 'already') {
        setNotice({ ok: false, text: t('claimAlready') })
        return
      }
      if (result.status === 'none') {
        // Not "already claimed": all this state proves is that the account
        // service is holding no reward for today. Saying more would be a guess,
        // and the client showing a claim button is exactly how that guess goes
        // wrong.
        setNotice({ ok: false, text: t('claimNone') })
        return
      }
      setNotice({ ok: false, text: t('pointsUnavailable') })
    } finally {
      setClaiming(false)
    }
  }, [t])

  const numbers = points?.status === 'ok' ? points : undefined
  const status = points?.status
  /**
   * No session, nothing to claim against. `unavailable` is deliberately NOT
   * blocked: a failed balance read says nothing about the session behind it, and
   * the press answers its own verdict.
   */
  const claimBlocked = claiming || status === undefined || status === 'signed-out' || status === 'expired'
  const hint = notice?.text ?? hintFor(status, t)

  return (
    <div style={sectionStyle}>
      {/* Sign-in first: the balances below are that account's, so the card that
          says which account it is belongs above them, not after. */}
      <AStudioLoginCard t={t} onCredentialsChanged={() => { void read(true) }} />
      <div style={cardStyle}>
        <div style={rowStyle}>
          <span>{t('generalPoints')}</span>
          <span style={amountStyle}>{numbers?.general.remaining ?? '—'}</span>
        </div>
        {numbers?.spark === undefined ? null : (
          <>
            <div style={dividerStyle} />
            <div style={rowStyle}>
              <span>{t('sparkPoints')}</span>
              <span style={amountStyle}>{numbers.spark.remaining}</span>
            </div>
          </>
        )}
        <div style={dividerStyle} />
        <div style={rowStyle}>
          {/* One live region for the press verdict: it appears without focus moving. */}
          <span role="status" style={notice?.ok === true ? { ...hintStyle, ...claimOkStyle } : hintStyle}>
            {hint}
          </span>
          <div style={actionsStyle}>
            <button
              type="button"
              style={claimBlocked ? { ...primaryStyle, ...busyStyle } : primaryStyle}
              aria-label={t('claimPointsHint')}
              aria-busy={claiming}
              disabled={claimBlocked}
              onClick={() => { void claim() }}
            >
              {claiming ? t('claiming') : t('claimPoints')}
            </button>
            <button
              type="button"
              style={busy ? { ...buttonStyle, ...busyStyle } : buttonStyle}
              aria-label={t('refreshPoints')}
              aria-busy={busy}
              disabled={busy}
              onClick={() => { void read(true) }}
            >
              {busy ? t('refreshing') : t('refresh')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
