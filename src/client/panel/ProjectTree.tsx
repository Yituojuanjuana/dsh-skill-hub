/**
 * ProjectTree — 项目级顶层卡片：把项目技能按 workspace 聚合（可折叠），
 * 并支持按 .dsh/.agents 细分两层。顶层拖拽 props 可选：独立工作区页
 * 没有同层排序时不需要拖拽。
 */

import type { JSX } from 'react'
import type { CatalogSkill } from '../../protocol.ts'
import { tt } from '../helpers.ts'
import type { SkillRowProps } from './SkillRow.tsx'
import { SkillRows } from './SkillRows.tsx'
import { GroupHeader } from './GroupHeader.tsx'
import { GroupSection } from './GroupSection.tsx'
import { GroupSummary } from './GroupSummary.tsx'

/** 稳定的空 Map：避免 `?? new Map()` 在每次渲染时破坏 memo。 */
const EMPTY_PERMANENT_USES = new Map<string, import('../../protocol.ts').PermanentStat>()
import { ReorderButtons } from './ReorderButtons.tsx'
import type { DragReorderProps } from './useDragReorder.ts'
import css from './panel.module.css'

export interface ProjectTreeProps {
  /** 项目级技能（已按来源筛选）。 */
  skills: CatalogSkill[]
  /** 已展开的树键（'project' / 'project:<workspace>' / 'project:<workspace>:<source>'）；默认全部收起。 */
  expandedGroups: ReadonlySet<string>
  toggleGroupExpanded: (key: string) => void
  /** 已细分（按 .dsh/.agents）的项目键。 */
  subdividedProjects: ReadonlySet<string>
  toggleSubdivide: (key: string) => void
  /** SkillRow 收窄后的 props（skill 由行内传入）；uses / hubConfig 也取自它。 */
  rowProps: Omit<SkillRowProps, 'skill'>
  /** 顶层拖拽 props；工作区独立页不传。 */
  dragProps?: DragReorderProps
  /** 编辑模式（显示上移/下移按钮）。 */
  editMode: boolean
  /** 顶层排序位置边界。 */
  canMoveUp: boolean
  canMoveDown: boolean
  /** 键盘排序：-1 上移，1 下移。 */
  onMove: (direction: -1 | 1) => void
}

export function ProjectTree(props: ProjectTreeProps): JSX.Element {
  const { skills, expandedGroups, toggleGroupExpanded, subdividedProjects, toggleSubdivide, rowProps, dragProps, editMode, canMoveUp, canMoveDown, onMove } = props
  const topExpanded = expandedGroups.has('project')
  /**
   * 卡片标题只显示**项目名称**，不显示完整路径。
   *
   * 路径形如 `E:\67549\Desktop\熊阳阳\sports-coach`，在卡片头里既占位又难读。
   * 名称优先用登记的 workspaceTitle；拿不到时退回路径的最后一段目录名
   * （而不是整条路径）。完整路径仍通过 `title` 属性（hover tooltip）可见，
   * 数据结构里的 `workspace` 字段保持不变。
   */
  const nameOf = (workspace: string | undefined, workspaceTitle: string | undefined): string => {
    if (workspaceTitle !== undefined && workspaceTitle !== '' && workspaceTitle !== workspace) return workspaceTitle
    if (workspace === undefined || workspace === '') return tt('groups.project')
    const parts = workspace.split(/[\\/]/).filter((part) => part !== '')
    return parts[parts.length - 1] ?? workspace
  }
  // 按 workspace 聚合，与拆分前逻辑一致
  const byProject = new Map<string, { title: string; path?: string; skills: CatalogSkill[] }>()
  for (const skill of skills) {
    const key = skill.workspace ?? skill.source
    const entry = byProject.get(key)
    if (entry === undefined) {
      byProject.set(key, {
        title: nameOf(skill.workspace, skill.workspaceTitle),
        ...skill.workspace === undefined ? {} : { path: skill.workspace },
        skills: [skill],
      })
    } else entry.skills.push(skill)
  }
  return (
    <GroupSection dragProps={dragProps}>
      <GroupHeader
        title={<>{tt('groups.project')} · {byProject.size}</>}
        collapsed={!topExpanded}
        onToggle={() => { toggleGroupExpanded('project') }}
        leading={dragProps !== undefined ? <span className={css.dragHandle} aria-hidden title={tt('drag.reorder')}>⋮⋮</span> : undefined}
        actions={editMode ? <ReorderButtons canMoveUp={canMoveUp} canMoveDown={canMoveDown} onMove={onMove} /> : undefined}
      />
      {topExpanded ? [...byProject.entries()].map(([key, proj]) => {
        const projKey = 'project:' + key
        const projExpanded = expandedGroups.has(projKey)
        const subdivided = subdividedProjects.has(key)
        return (
          <div key={projKey} className={css.projectNest}>
            <GroupHeader
              // 标题只有项目名；完整路径放进 tooltip（hover 可见），不占版面。
              title={<><span className={css.groupTitleText} title={proj.path}>{proj.title}</span> · {proj.skills.length}<GroupSummary members={proj.skills.map((s) => s.name)} permanentUses={rowProps.permanentUses ?? EMPTY_PERMANENT_USES} hubConfig={rowProps.hubConfig} /></>}
              collapsed={!projExpanded}
              onToggle={() => { toggleGroupExpanded(projKey) }}
              actions={<button type='button' className={css.opBtn} onClick={(event) => { event.stopPropagation(); toggleSubdivide(key) }}>{subdivided ? tt('groups.merge') : tt('groups.subdivide')}</button>}
            />
            {projExpanded ? (
              subdivided ? (
                <div className={css.projectNest}>
                  {(['project-dsh', 'project-agents'] as const).map((source) => {
                    const list = proj.skills.filter((skill) => skill.source === source)
                    if (list.length === 0) return null
                    const srcKey = projKey + ':' + source
                    const srcExpanded = expandedGroups.has(srcKey)
                    return (
                      <div key={srcKey} className={css.projectNest}>
                        <GroupHeader
                          title={<>{tt(('badge.source.' + source) as 'badge.source.project-dsh' | 'badge.source.project-agents')} · {list.length}</>}
                          collapsed={!srcExpanded}
                          onToggle={() => { toggleGroupExpanded(srcKey) }}
                        />
                        {srcExpanded ? <SkillRows skills={list} rowProps={rowProps} /> : null}
                      </div>
                    )
                  })}
                </div>
              ) : <SkillRows skills={proj.skills} rowProps={rowProps} />
            ) : null}
          </div>
        )
      }) : null}
    </GroupSection>
  )
}
