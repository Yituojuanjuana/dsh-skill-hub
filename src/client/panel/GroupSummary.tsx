/**
 * 分类卡片头部合计：该分类下所有技能的调用量（日 / 周 / 总）+ 最近一次调用时间。
 *
 * 调用量只认永久账本（插件自己记的日/周/总）。会话日志统计已移除，所以这里
 * 逐项累加 `permanent.today / week / total`，卡片上的三个数字因此分别等于展开后
 * 各技能「日」「周」「总」之和。honours the showGroupSummary config switch.
 */

import type { JSX } from 'react'
import type { HubConfig, PermanentStat } from '../../protocol.ts'
import { tt } from '../helpers.ts'
import { relativeTimeText } from './format.ts'
import css from './panel.module.css'

/** The narrowed hub surface one group summary consumes. */
export interface GroupSummaryProps {
  /** The group's member skill names. */
  members: readonly string[]
  /** skillName → permanent ledger stats (day/week/total). */
  permanentUses: ReadonlyMap<string, PermanentStat>
  /** Effective hub config; null while it has not loaded. */
  hubConfig: HubConfig | null
}

export function GroupSummary(props: GroupSummaryProps): JSX.Element {
  const { members, permanentUses, hubConfig } = props
  let today = 0
  let week = 0
  let total = 0
  let latest = 0
  for (const name of members) {
    const stat = permanentUses.get(name)
    if (stat === undefined) continue
    today += stat.today
    week += stat.week
    total += stat.total
    if (stat.lastUsed > latest) latest = stat.lastUsed
  }
  const show = hubConfig?.showGroupSummary !== false
  return (
    <span className={css.groupTitleInner}>
      {show && total > 0
        ? <span className={css.groupStat} title={tt('group.totalHint')}>
            {tt('row.day')} {today} · {tt('row.week')} {week} · {tt('row.total')} {total}
          </span>
        : null}
      {show && latest > 0 ? <span className={css.useTime + ' ' + css.groupTime}>{relativeTimeText(latest)}</span> : null}
    </span>
  )
}
