/**
 * 按调用量分组视图：把技能按「被调用得多不多」分档，而不是只排个序。
 *
 * 为什么分档而不是排序：排序只能回答「谁第一」，而管理技能时要回答的是
 * 「哪些该留、哪些该删」。分档（高频 / 常用 / 偶尔 / 从未）让这个判断一眼可见，
 * 也避免长尾技能把常用技能挤出视野。
 */

import { useMemo, type JSX } from 'react'
import type { CatalogSkill, PermanentStat } from '../../protocol.ts'
import { groupSwitchView } from '../grouping.ts'
import { tt } from '../helpers.ts'
import type { SkillHubState } from './useSkillHub.ts'
import { SkillRows } from './SkillRows.tsx'
import { GroupSummary } from './GroupSummary.tsx'
import { GroupSwitchButton } from './GroupSwitchButton.tsx'
import { GroupHeader } from './GroupHeader.tsx'
import { GroupSection } from './GroupSection.tsx'
import css from './panel.module.css'

/** 一档调用量。 */
export interface UsageTier {
  id: 'frequent' | 'regular' | 'occasional' | 'never'
  /** 该档的下界（含），用于展示区间。 */
  min: number
  skills: CatalogSkill[]
}

/** 分档阈值：按总调用次数。 */
export const USAGE_TIERS: ReadonlyArray<{ id: UsageTier['id']; min: number }> = [
  { id: 'frequent', min: 10 },
  { id: 'regular', min: 3 },
  { id: 'occasional', min: 1 },
  { id: 'never', min: 0 },
]

/**
 * 把技能按总调用次数分档。
 * @param skills - 已过滤/排序的技能。
 * @param stats - skillName → 台账统计。
 * @returns 非空档位，按从高到低排列。
 */
export function groupByUsage(skills: readonly CatalogSkill[], stats: ReadonlyMap<string, PermanentStat>): UsageTier[] {
  const tiers: UsageTier[] = USAGE_TIERS.map((tier) => ({ id: tier.id, min: tier.min, skills: [] }))
  for (const skill of skills) {
    const total = stats.get(skill.name)?.total ?? 0
    // 取第一个满足下界的档（数组按 min 降序，命中即停）。
    const tier = tiers.find((candidate) => total >= candidate.min) ?? tiers[tiers.length - 1]
    tier.skills.push(skill)
  }
  return tiers.filter((tier) => tier.skills.length > 0)
}

/** 档位文案键。 */
function tierLabelKey(id: UsageTier['id']): 'usage.frequent' | 'usage.regular' | 'usage.occasional' | 'usage.never' {
  if (id === 'frequent') return 'usage.frequent'
  if (id === 'regular') return 'usage.regular'
  if (id === 'occasional') return 'usage.occasional'
  return 'usage.never'
}

/** 按调用量分组的视图主体。 */
export function UsageView(props: { hub: SkillHubState }): JSX.Element {
  const { hub } = props
  const { catalog, viewNames, actionNames, busyNames, batchBusy, toggleGroupExpanded, expandedGroups } = hub
  const stats = hub.permanentUses
  const tiers = useMemo(
    () => groupByUsage(hub.sorted, stats ?? new Map()),
    [hub.sorted, stats],
  )

  return (
    <div className={css.tierList}>
      {tiers.map((tier) => {
        const key = 'usage:' + tier.id
        const expanded = expandedGroups.has(key)
        const memberNames = tier.skills.map((skill) => skill.name)
        const view = groupSwitchView(memberNames, viewNames)
        const hasWritable = memberNames.some((name) => actionNames.has(name))
        return (
          <GroupSection key={key}>
            <GroupHeader
              title={<>{tt(tierLabelKey(tier.id))} · {tier.skills.length}<GroupSummary members={memberNames} permanentUses={stats} hubConfig={hub.hubConfig} /></>}
              collapsed={!expanded}
              onToggle={() => { toggleGroupExpanded(key) }}
              actions={
                <GroupSwitchButton
                  state={view.state}
                  label={tt(tierLabelKey(tier.id))}
                  memberCount={memberNames.length}
                  batchBusy={batchBusy}
                  hasWritable={hasWritable}
                  onToggle={() => { void hub.batchToggleNames(memberNames, view.state !== 'on') }}
                />
              }
            />
            {expanded ? (
              <SkillRows
                skills={tier.skills}
                rowProps={{
                  uses: hub.uses,
                  permanentUses: stats,
                  hubConfig: hub.hubConfig,
                  busyNames,
                  editMode: hub.editMode,
                  tagBusy: hub.tagBusy,
                  duplicateNames: new Set(catalog?.duplicateNames ?? []),
                  setInvocation: hub.setInvocation,
                  toggle: hub.toggle,
                  openDetail: hub.openDetail,
                  requestDeleteSkill: hub.requestDeleteSkill,
    requestTrashSkill: hub.requestTrashSkill,
                }}
              />
            ) : null}
          </GroupSection>
        )
      })}
    </div>
  )
}
