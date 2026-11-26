/**
 * 工作区页：只看**项目级**技能（`<项目>/.dsh/skills` 与 `.agents/skills`）。
 *
 * 顶部一行三件套，顺序与参考设计一致：
 *   全部状态 → 工作区选择（当前项加粗突出）→ 搜索
 *
 * 为什么控件都放这一页而不是共享的筛选面板：
 * 这一页的语义就是「按工作区看项目技能」，工作区选择是主控件，藏进折叠面板
 * 会让用户连「能选什么」都看不到。状态筛选与搜索同理，是这一页的常驻过滤。
 */

import { useMemo, type JSX } from 'react'
import type { SkillStatusFilter } from '../../client/grouping.ts'
import { isProjectSource, sortSkills, usageTotal, type SortKey } from '../grouping.ts'
import { tt } from '../helpers.ts'
import { ProjectTree } from './ProjectTree.tsx'
import { SkillRows } from './SkillRows.tsx'
import { FilterSearch } from './FilterSearch.tsx'
import type { SkillHubState } from './useSkillHub.ts'
import css from './panel.module.css'

export function WorkspaceView(props: { hub: SkillHubState }): JSX.Element {
  const { hub } = props
  const projectSkills = useMemo(() => hub.sorted.filter((skill) => isProjectSource(skill.source)), [hub.sorted])
  // 必须 memo：`new Set()` 每次渲染都是新引用，行级 memo 会全部失效。
  const duplicateNames = useMemo(() => new Set(hub.catalog?.duplicateNames ?? []), [hub.catalog])

  /**
   * 可切换的工作区。
   *
   * 用 catalog.workspaces（全部已登记工作区）而不是「有技能的项目」：这一页的
   * 主控件就是选工作区，一个空工作区也必须能被选中并明确告知「这里还没有技能」，
   * 否则用户会以为那个工作区不存在。
   */
  const workspaces = useMemo(() => hub.catalog?.workspaces ?? [], [hub.catalog])
  const currentWorkspace = hub.catalog?.currentWorkspace ?? ''
  /**
   * 路径归一化比较。
   *
   * Windows 上同一个目录可能以 `E:\a\b`、`e:/a/b`、`E:\a\b\` 三种形式出现
   * （workspace.json 与 session header 来源不同）。用原始字符串比对会让
   * 「当前工作区」与列表项匹配不上，下拉的 value 找不到对应 option ——
   * 浏览器就显示成空白。这里统一成小写正斜杠、去掉尾部分隔符再比。
   */
  const samePath = (a: string, b: string): boolean => {
    const norm = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    return norm(a) === norm(b)
  }
  /**
   * 下拉里只显示**工作区名称**，不显示路径。
   *
   * 完整路径既长又重复（同一个父目录下全是 `E:\...\xxx`），下拉会被撑开、
   * 还得横向滚动才能分辨。名称取登记标题；没登记过的路径取最后一段目录名，
   * 这样每一项都是干净的单词。
   */
  const titleOf = (path: string): string => {
    const hit = workspaces.find((entry) => samePath(entry.path, path))
    if (hit !== undefined && hit.title !== '' && hit.title !== hit.path) return hit.title
    const parts = path.split(/[\\/]/).filter((part) => part !== '')
    return parts[parts.length - 1] ?? path
  }

  /**
   * 下拉的选项列表（已按归一化路径去重）。
   *
   * 顺序：当前对话工作区置顶 → 其余已登记工作区 → 当前选中但未登记的那一项。
   * 每一项都保证有 value，绝不会出现「value 匹配不到 option」导致显示空白。
   */
  const options = useMemo(() => {
    const list: Array<{ path: string; label: string }> = []
    const seen = new Set<string>()
    const norm = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    const push = (path: string, label: string): void => {
      if (path === '') return
      const key = norm(path)
      if (seen.has(key)) return
      seen.add(key)
      list.push({ path, label })
    }
    if (currentWorkspace !== '') push(currentWorkspace, titleOf(currentWorkspace))
    for (const entry of workspaces) push(entry.path, entry.title !== '' ? entry.title : titleOf(entry.path))
    // 当前选中值不在上面任何一项里（对话在未登记目录）时补一项，避免选中态丢失。
    if (hub.workspace !== '' && !seen.has(norm(hub.workspace))) {
      push(hub.workspace, titleOf(hub.workspace))
    }
    return list
  }, [currentWorkspace, workspaces, hub.workspace])

  /**
   * 是否平铺：下拉选中了**某个具体工作区**。
   *
   * 唯一的判定条件就是 `hub.workspace !== ''`。
   * - 选中具体工作区 → 平铺（用户要的「选文件夹 = 看里面有什么」）
   * - 「全部工作区」（`''`）→ 保留原来的分组树（项目级/按项目分组、折叠、徽标）
   */
  const isFlatView = hub.workspace !== ''

  /**
   * 平铺时的技能列表。
   *
   * 去重键是 `source + '\\u0000' + name` —— 同一个技能可能以不同 root
   * （`project-dsh` / `project-agents`）同时出现，那是两个不同的技能实体，
   * 该各显示一行；而**同一个** name+root 组合重复出现才是脏数据，必须合并。
   *
   * 排序复用通用页的 `sortKey` + `sortSkills`，不在这里另造一套 ——
   * 两页的排序口径必须一致，否则同一个「按调用量」在两处给出不同顺序。
   */
  const flatSkills = useMemo(() => {
    if (!isFlatView) return projectSkills
    const seen = new Set<string>()
    const unique: typeof projectSkills = []
    for (const skill of projectSkills) {
      const key = skill.source + '\u0000' + skill.name
      if (seen.has(key)) continue
      seen.add(key)
      unique.push(skill)
    }
    return sortSkills(unique, hub.sortKey, (name) => usageTotal(hub.uses.get(name)))
  }, [isFlatView, projectSkills, hub.sortKey, hub.uses])

  const rowProps = {
    uses: hub.uses,
    permanentUses: hub.permanentUses,
    hubConfig: hub.hubConfig,
    busyNames: hub.busyNames,
    editMode: hub.editMode,
    tagBusy: hub.tagBusy,
    duplicateNames,
    // Project skills are toggled through invocation overrides, never through
    // the disabled sidecar. Keep rows visible so the switch always represents
    // the current model-invocation state.
    statusFilter: 'all' as const,
    toggle: hub.toggle,
    openDetail: hub.openDetail,
    requestDeleteSkill: hub.requestDeleteSkill,
    requestTrashSkill: hub.requestTrashSkill,
  }

  return (
    <>
      <div className={css.filterBar + ' ' + css.workspaceBar}>
        {/* 控件顺序固定：项目下拉 → 状态 → 调用方式 → 搜索。
            多条件之间是「与」语义：项目由后端按 cwd 取、状态与调用方式在
            hub.sorted 里叠加过滤。 */}
        <select
          className={css.select + ' ' + css.workspaceSelectStrong}
          value={hub.workspace}
          aria-label={tt('panel.workspaceLabel')}
          title={tt('panel.workspaceHint')}
          onChange={(event) => { hub.setWorkspace(event.target.value) }}
        >
          {hub.workspace === '' ? <option value=''>{tt('panel.workspaceAll')}</option> : null}
          {options.map((option) => <option key={option.path} value={option.path}>{option.label}</option>)}
        </select>

        <select
          className={css.select + ' ' + css.workspaceStatusSelect}
          value={hub.statusFilter}
          aria-label={tt('filter.status')}
          onChange={(event) => { hub.setStatusFilter(event.target.value as SkillStatusFilter) }}
        >
          <option value='all'>{tt('filter.statusAll')}</option>
          <option value='enabled'>{tt('filter.statusEnabled')}</option>
          <option value='disabled'>{tt('filter.statusDisabled')}</option>
        </select>

        <select
          className={css.select + ' ' + css.filterInline}
          value={hub.invocationFilter}
          aria-label={tt('filter.invocation')}
          onChange={(event) => { hub.setInvocationFilter(event.target.value as 'all' | 'model' | 'user') }}
        >
          <option value='all'>{tt('filter.invocationAll')}</option>
          <option value='model'>{tt('filter.modelOnly')}</option>
          <option value='user'>{tt('filter.userOnly')}</option>
        </select>

        <select
          className={css.select + ' ' + css.filterInline}
          value={hub.sortKey}
          aria-label={tt('sort.label')}
          onChange={(event) => { hub.setSortKey(event.target.value as SortKey) }}
        >
          <option value='uses'>{tt('sort.uses')}</option>
          <option value='added'>{tt('sort.added')}</option>
          <option value='name'>{tt('sort.name')}</option>
        </select>

        {/* 与通用页共用搜索组件：输入只改草稿，点按钮/Enter 才应用。 */}
        <FilterSearch value={hub.search} onApply={hub.setSearch} inputClassName={css.workspaceSearch} placeholderKey='panel.searchDetail' />
      </div>

      {projectSkills.length === 0 ? (
        <div className={css.workspaceEmptyState}>{tt('panel.workspaceEmpty')}</div>
      ) : isFlatView ? (
        /*
         * 选中具体工作区 → **平铺**。
         *
         * 用户要的是「选了项目文件夹 = 直接看这个文件夹下有什么技能」。
         * 分组头（「项目级 · N」「sports-coach · 1」）在这种场景下只会把同一批
         * 技能隔开、甚至让同一个技能在两处各出现一次，所以整层去掉。
         * 只在「全部工作区」时保留分组能力。
         */
        <div className={css.workspaceFlatList}>
          <SkillRows skills={flatSkills} rowProps={rowProps} />
        </div>
      ) : (
        <ProjectTree
          editMode={hub.editMode}
          canMoveUp={false}
          canMoveDown={false}
          onMove={() => {}}
          skills={projectSkills}
          expandedGroups={hub.expandedGroups}
          toggleGroupExpanded={hub.toggleGroupExpanded}
          subdividedProjects={hub.subdividedProjects}
          toggleSubdivide={hub.toggleSubdivide}
          rowProps={rowProps}
        />
      )}
    </>
  )
}
