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
  // 组间同样按各组最高排名成员排，别让固定 role 规则盖掉用户选的排序键。
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

  if (groups.length === 0) return <div className={css.empty}>{tt('panel.empty')}</div>
  return (
    <>
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