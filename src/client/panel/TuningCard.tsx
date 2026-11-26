/**
 * 「自适应参数」卡片：展示当前生效值 / 默认值 / 依据，并允许逐个锁定。
 *
 * 只读展示 + 两个写动作（锁定开关、恢复默认）。它**不**触发校准 —— 校准在
 * 后端按裁决历史跑，这里只是把结果摆出来，让人能看见「门槛为什么变成 68」。
 */

import { useState, type JSX } from 'react'
import { tt } from '../helpers.ts'
import type { EvolutionTuningState } from '../../protocol.ts'
import css from './panel.module.css'

/** 参数的展示元信息：文案 key 与是否为比例值。 */
const PARAM_META: Record<string, { label: string; ratio?: boolean }> = {
  minValueScore: { label: 'tuning.minValueScore' },
  maxScanProposals: { label: 'tuning.maxScanProposals' },
  recentOptimizeDays: { label: 'tuning.recentOptimizeDays' },
  minUserMessages: { label: 'tuning.minUserMessages' },
  maxSessions: { label: 'tuning.maxSessions' },
  staleDays: { label: 'tuning.staleDays' },
  reasonSimilarityThreshold: { label: 'tuning.reasonSimilarityThreshold', ratio: true },
}

export interface TuningCardProps {
  tuning: EvolutionTuningState
  defaults: Record<string, number>
  onToggleLock: (key: string, locked: boolean) => void
  onReset: () => void
  busy: boolean
}

export function TuningCard(props: TuningCardProps): JSX.Element {
  const { tuning, defaults, onToggleLock, onReset, busy } = props
  const [open, setOpen] = useState(false)
  const locked = new Set(tuning.locked)
  const changed = Object.keys(defaults).filter((key) => tuning.params[key] !== defaults[key])
  const fmt = (key: string, value: number | undefined): string => {
    if (value === undefined) return '-'
    return PARAM_META[key]?.ratio === true ? value.toFixed(2) : String(value)
  }
  return (
    <section className={css.tuningCard}>
      <div className={css.tuningHead}>
        <button type='button' className={css.tuningToggle} aria-expanded={open} onClick={() => { setOpen((value) => !value) }}>
          {tt('evolution.tuningTitle')}
          {changed.length > 0 ? <span className={css.tuningBadge}>{changed.length}</span> : null}
        </button>
        <span className={css.tuningHint}>{tt('evolution.tuningHint')}</span>
        <button type='button' className={css.button + ' ' + css.evolutionButton} disabled={busy} title={tt('evolution.tuningResetHint')} onClick={onReset}>
          {tt('evolution.tuningReset')}
        </button>
      </div>
      {open ? (
        <div className={css.tuningBody}>
          <div className={css.tuningBasis}>
            {tt('evolution.tuningSamples', {
              total: tuning.basis.total,
              accepted: tuning.basis.accepted,
              rejected: tuning.basis.rejected,
              deferred: tuning.basis.deferred,
            })}
            {' · '}
            {tuning.updatedAt > 0 ? tt('evolution.tuningUpdatedAt') + ' ' + new Date(tuning.updatedAt).toLocaleString() : tt('evolution.tuningNever')}
          </div>
          <table className={css.tuningTable}>
            <thead>
              <tr>
                <th>{tt('evolution.tuningParam')}</th>
                <th>{tt('evolution.tuningCurrent')}</th>
                <th>{tt('evolution.tuningDefault')}</th>
                <th>{tt('evolution.tuningLock')}</th>
              </tr>
            </thead>
            <tbody>
              {Object.keys(defaults).map((key) => {
                const current = tuning.params[key]
                const base = defaults[key]
                const isChanged = current !== base
                const isLocked = locked.has(key)
                return (
                  <tr key={key} className={isLocked ? css.tuningRowLocked : undefined}>
                    <td title={key}>{tt(PARAM_META[key]?.label as never ?? 'evolution.tuningParam')}</td>
                    <td>
                      {/* 改过的值显示 `原值 → 新值`，不要只给一个孤零零的裸数字。 */}
                      {isChanged
                        ? <span className={css.tuningChanged}>{fmt(key, base)} → <strong>{fmt(key, current)}</strong></span>
                        : <span>{fmt(key, current)}</span>}
                    </td>
                    <td className={css.tuningDefault}>{fmt(key, base)}</td>
                    <td>
                      <label className={css.tuningLock}>
                        <input
                          type='checkbox'
                          checked={isLocked}
                          disabled={busy}
                          onChange={(event) => { onToggleLock(key, event.target.checked) }}
                        />
                        {isLocked ? tt('evolution.tuningLocked') : ''}
                      </label>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  )
}