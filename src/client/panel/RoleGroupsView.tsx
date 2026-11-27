/**
 * General tab, role view: one card per role the hub derives from each skill's
 * name, description and `whenToUse` (see `classifyRole`).
 *
 * Classification is presentation-only — nothing is written to disk and no model
 * is called — so a group can never drift out of sync with the catalog: install a
 * skill and it appears in a group on the next poll.
 *
 * Every card starts collapsed. With ~50 skills the expanded view is a wall of
 * rows, and the headings plus the per-card summary are the useful overview.
 */

import { useMemo, type JSX } from 'react'
import { tt } from '../helpers.ts'
import { groupByRole, sortGroupsByRank, type GroupSwitchState } from '../grouping.ts'
import { SkillRows } from './SkillRows.tsx'
import { GroupSummary } from './GroupSummary.tsx'
import { GroupSwitchButton } from './GroupSwitchButton.tsx'
import { GroupHeader } from './GroupHeader.tsx'
import { GroupSection } from './GroupSection.tsx'
import type { SkillHubState } from './useSkillHub.ts'
import css from './panel.module.css'

export function RoleGroupsView(props: { hub: SkillHubState }): JSX.Element {
  const { hub } = props
  const { catalog, expandedGroups, viewNames, actionNames, batchBusy, busyNames, toggleGroupExpanded } = hub
  const duplicateNames = useMemo(() => new Set(catalog?.duplicateNames ?? []), [catalog])
  // 角色视图与「按目录」共用同一份状态筛选（`hub.sorted` 已含状态过滤），
  // 因此状态下拉在角色视图里**显示且生效**。
  //
  // 历史：这里曾读 `searchedSorted`（不含状态过滤）以「保护完整名单」，结果
  // 用户在「按目录」把状态设为「已启用/已停用」再切回来时分组变空集，而状态
  // 下拉又被隐藏，用户无法自救 —— 连续两次被报成「按角色整块空白」。现在改为
  // 与其它视图同源，并把筛选控件一并显示出来。
  const groups = useMemo(() => sortGroupsByRank(groupByRole(hub.sorted), hub.sorted), [hub.sorted])
  const rowProps = { uses: hub.uses, hubConfig: hub.hubConfig, busyNames, editMode: hub.editMode, tagBusy: hub.tagBusy, duplicateNames, statusFilter: hub.statusFilter, hideSourceBadge: true, setInvocation: hub.setInvocation, toggle: hub.toggle, openDetail: hub.openDetail, requestDeleteSkill: hub.requestDeleteSkill, requestTrashSkill: hub.requestTrashSkill }

  /**
   * Whole-role toggle. The members come from the classifier, not a tag, so
   * `toggleGroup` (which resolves tags/collections and runs the cross-group
   * conflict check) does not apply. A fully-off role turns on; anything else
   * turns off, matching the switch's own tri-state.
   */
  const toggleRole = (members: readonly string[], state: GroupSwitchState): void => {
    const names = members.filter((name) => actionNames.has(name))
    if (names.length === 0) return
    void hub.batchToggleNames(names, state !== 'on')
  }

  if (groups.length === 0) {
    // 可操作的空态：说清是「筛选把结果筛没了」，并给一键清除。
    // 同时把真实计数打出来 —— 万一将来又出现「整块空白」，这一行能立刻区分
    // 「数据没到」和「渲染没出」。
    return (
      <div className={css.empty}>
        <div>{tt('role.emptyFiltered')}</div>
        <div className={css.hintLine}>
          {tt('role.counts', { skills: hub.sorted.length, groups: 0 })}
        </div>
        <button type='button' className={css.button} onClick={() => { hub.clearListFilters() }}>
          {tt('role.clearFilters')}
        </button>
      </div>
    )
  }
  return (
    <>
      {/* 计数行：无论分组是否折叠、是否被筛掉，这一行始终可见。
          它的作用是让「角色视图」永远不可能是纯空白 —— 空白页本身无法区分
          「数据没到」「分组算空」「渲染没出」，一行计数就能。 */}
      <div className={css.hintLine + ' ' + css.hintRowTight}>
        {tt('role.counts', { skills: hub.sorted.length, groups: groups.length })}
      </div>
      {groups.map((group) => {
        const key = 'role:' + group.id
        const expanded = expandedGroups.has(key)
        const memberNames = group.skills.map((skill) => skill.name)
        const label = tt(('roleGroup.' + group.id) as 'roleGroup.other')
        const hasWritable = memberNames.some((member) => actionNames.has(member))
        const enabled = memberNames.filter((name) => viewNames.has(name)).length
        const state: GroupSwitchState = enabled === 0 ? 'off' : enabled === memberNames.length ? 'on' : 'mixed'
        return (
          <GroupSection key={key}>
            <GroupHeader
              title={<>{label} · {group.skills.length}<GroupSummary members={memberNames} permanentUses={hub.permanentUses} hubConfig={hub.hubConfig} /></>}
              collapsed={!expanded}
              onToggle={() => { toggleGroupExpanded(key) }}
              actions={
                <GroupSwitchButton
                  state={state}
                  label={label}
                  memberCount={memberNames.length}
                  batchBusy={batchBusy}
                  hasWritable={hasWritable}
                  onToggle={() => { toggleRole(memberNames, state) }}
                />
              }
            />
            {expanded ? <SkillRows skills={group.skills} rowProps={rowProps} /> : null}
          </GroupSection>
        )
      })}
    </>
  )
}