/**
 * One enabled skill row: name + invocation dots + usage meta, delete and
 * disable actions. Shared by the flat list and both grouped views.
 */

import { memo, useLayoutEffect, useRef, useState, type JSX } from 'react'
import type { CatalogSkill, HubConfig, PermanentStat } from '../../protocol.ts'
import type { SkillStatusFilter } from './hooks/useCatalogFlow.ts'
import { IconTrashOutline16 } from '../icons.tsx'
import { isDisplayNameDistinct, tt } from '../helpers.ts'
import { formatDateTime, formatSuccessRate, relativeTimeText } from './format.ts'
import { sourceLabel } from './source-label.ts'
import css from './panel.module.css'

/** The narrowed hub surface one skill row consumes. */
export interface SkillRowProps {
  skill: CatalogSkill
  /** skillName → usage stats. */
  uses: ReadonlyMap<string, { count: number; lastUsed?: number; permanent?: PermanentStat }>
  /** skillName → permanent ledger stats (day/week/total). Optional for callers that enrich `uses`. */
  permanentUses?: ReadonlyMap<string, PermanentStat>
  /** Effective hub config; null while it has not loaded. */
  hubConfig: HubConfig | null
  /** Names with an in-flight toggle/delete. */
  busyNames: ReadonlySet<string>
  /** Whether the edit affordances (delete) are shown. */
  editMode: boolean
  /** True while a tag operation runs (also blocks row deletes). */
  tagBusy: boolean
  /** Names that collide with another skill (duplicate badge). */
  duplicateNames: ReadonlySet<string>
  /** Status filter owned by the list shell; rows read it through SkillRows. */
  statusFilter?: SkillStatusFilter
  /** Hide the discovery-root badge — the by-location view already names it on the card. */
  hideSourceBadge?: boolean
  /** 改 frontmatter 的模型/用户可调用开关；Promise resolve 为 false 表示失败需回滚。 */
  setInvocation: (skill: CatalogSkill, patch: { modelInvocable?: boolean; userInvocable?: boolean }) => Promise<boolean>
  toggle: (skill: CatalogSkill, enabled: boolean) => Promise<void>
  openDetail: (name: string, workspace?: string) => Promise<void>
  requestDeleteSkill: (name: string) => void
  /**
   * 移入回收站（可恢复）。
   *
   * 与 requestDeleteSkill 走同一条后端路径，但语义是「归档」不是「删除」，
   * 前端会弹一个明确的「可在回收站恢复」确认框。
   */
  requestTrashSkill: (name: string) => void
}

export function SkillRowImpl(props: SkillRowProps): JSX.Element {
  const { skill, uses, permanentUses, hubConfig, busyNames, editMode, tagBusy, duplicateNames, hideSourceBadge, setInvocation, toggle, openDetail, requestDeleteSkill, requestTrashSkill } = props
  const [menuOpen, setMenuOpen] = useState(false)
  /** 调用开关的本地乐观覆盖：null 表示跟随 catalog 真值。所有 hook 在 early return 之前。 */
  const [invOverride, setInvOverride] = useState<{ modelInvocable: boolean; userInvocable: boolean } | null>(null)
  const [invoking, setInvoking] = useState(false)
  /**
   * 菜单的实测坐标。
   *
   * 菜单不能用 `position: absolute` 挂在行内：行所在的 `.section` 卡片是
   * `overflow: hidden`（为了让分组卡有圆角裁切），绝对定位的菜单会被卡片
   * 下边缘直接切掉 —— 最后一项「禁用」就是这么消失的。改成 `position: fixed`
   * 用视口坐标后，菜单脱离卡片裁切，卡片怎么改都不会再压住它。
   */
  const moreRef = useRef<HTMLButtonElement | null>(null)
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null)
  // 调用量只认永久账本（插件自己记的日/周/总）。会话日志统计已移除，
  // 这里不再读 `uses.count` / `uses.lastUsed`。
  const stat = uses.get(skill.name)
  const permStat = permanentUses?.get(skill.name) ?? stat?.permanent
  // 打开时量一次按钮位置。菜单高约 3 行，视口底部放不下就翻到按钮上方 ——
  // 否则最后几行的菜单会被窗口下边缘截断，和卡片裁切是同一类问题。
  useLayoutEffect(() => {
    if (!menuOpen) { setMenuPos(null); return }
    const rect = moreRef.current?.getBoundingClientRect()
    if (rect === undefined) return
    const MENU_HEIGHT_ESTIMATE = 132
    const opensUp = rect.bottom + 6 + MENU_HEIGHT_ESTIMATE > window.innerHeight
    setMenuPos({
      top: opensUp ? Math.max(8, rect.top - 6 - MENU_HEIGHT_ESTIMATE) : rect.bottom + 6,
      right: Math.max(8, window.innerWidth - rect.right),
    })
  }, [menuOpen])

  const isDuplicate = duplicateNames.has(skill.name)
  const externalSource = hideSourceBadge !== true && skill.source.startsWith('agent-') ? sourceLabel(skill.source) : null
  const invocation = invOverride ?? skill.invocation
  /** 点击调用开关：乐观本地覆盖 → 调后端 → 失败回滚到点击前的值；在途禁点。 */
  const onInvocation = (patch: { modelInvocable?: boolean; userInvocable?: boolean }): void => {
    if (invoking) return
    const before: { modelInvocable: boolean; userInvocable: boolean } = { ...invocation }
    const next = { ...before, ...patch }
    setInvOverride(next)
    setInvoking(true)
    void setInvocation(skill, patch).then((ok) => {
      if (!ok) setInvOverride(before)
      else setInvOverride(null) // 成功后 catalog 已被 reload，跟随真值
    }).catch(() => setInvOverride(before)).finally(() => setInvoking(false))
  }
  return (
    <div className={css.row + (skill.modelOverride === true ? ' ' + css.rowOff : '')}>
      <button
        type='button'
        className={css.rowMainButton}
        aria-label={tt('row.open', { name: skill.name })}
        onClick={() => { void openDetail(skill.name, skill.workspace) }}
      >
        <div className={css.rowMain}>
        <div className={css.rowName}>
          <span className={css.rowNameText}>{skill.name}</span>
          {externalSource !== null ? <span className={css.badge + ' ' + css.badgeSource} title={skill.source}>{externalSource}</span> : null}
          {isDisplayNameDistinct(skill.name, skill.displayName) ? <span className={css.displayName} title={skill.displayName}>{skill.displayName}</span> : null}
          {/* 调用量 + 成功率：日 / 周 / 总 ｜ 成功率。同一行，用 ｜ 分隔。 */}
          {permStat !== undefined && hubConfig?.showUseCount !== false ? (
            <span className={css.permStat} title={tt('row.permStatHint')}>
              {tt('row.day') + ' ' + permStat.today + ' · ' + tt('row.week') + ' ' + permStat.week + ' · ' + tt('row.total') + ' ' + permStat.total}
              {' ｜ '}
              <span className={css.permRate} title={tt('row.successRateHint')}>{tt('row.successRate') + '：' + formatSuccessRate(permStat)}</span>
            </span>
          ) : null}
          {/* 最近一次调用：直接跟在调用量后面，不再甩到行尾。 */}
          {permStat !== undefined && permStat.lastUsed > 0 && hubConfig?.showUseTime !== false ? <span className={css.useTimeInline} title={tt('row.lastUsedHint')}>{relativeTimeText(permStat.lastUsed)}</span> : null}
          {isDuplicate ? <span className={css.badge + ' ' + css.statusError} title={tt('row.duplicateHint')}>{tt('row.duplicate')}</span> : null}
          {/* 安装时间靠右：与调用量/最近调用分属不同性质，放在行尾对齐成列。 */}
          {skill.addedAt !== undefined && skill.addedAt > 0 ? <span className={css.installedAt} title={tt('row.installedHint') + ' ' + formatDateTime(skill.addedAt)}>{tt('row.installed')} {relativeTimeText(skill.addedAt)}</span> : null}
        </div>
          <div className={css.rowDesc} title={skill.description}>{skill.shortDescription ?? skill.description}</div>
        </div>
      </button>
      <span className={css.invocationChips}>
        <button
          type='button'
          className={css.invocationChip + (invocation.modelInvocable ? ' ' + css.invocationChipOn : '')}
          aria-pressed={invocation.modelInvocable}
          title={tt('legend.model')}
          disabled={invoking || busyNames.has(skill.name)}
          onClick={(event) => { event.stopPropagation(); onInvocation({ modelInvocable: !invocation.modelInvocable }) }}
        >{tt('legend.model')}</button>
        <button
          type='button'
          className={css.invocationChip + (invocation.userInvocable ? ' ' + css.invocationChipOn : '')}
          aria-pressed={invocation.userInvocable}
          title={tt('legend.user')}
          disabled={invoking || busyNames.has(skill.name)}
          onClick={(event) => { event.stopPropagation(); onInvocation({ userInvocable: !invocation.userInvocable }) }}
        >{tt('legend.user')}</button>
      </span>
      {skill.writable || skill.toggleable === true
        ? <>
            <button
              type='button'
              role='switch'
              aria-checked={!(skill.modelOverride === true)}
              aria-label={tt(skill.modelOverride === true ? 'row.enable' : 'row.disable')}
              title={skill.toggleable === true && !skill.writable ? tt('row.disableProjectHint') : undefined}
              className={css.switch + (skill.modelOverride === true ? '' : ' ' + css.switchOn)}
              disabled={busyNames.has(skill.name)}
              onClick={(event) => { event.stopPropagation(); void toggle(skill, skill.modelOverride === true) }}
            ><span className={css.switchThumb} /></button>
            {skill.modelOverride === true ? <span className={css.badge + ' ' + css.statusLocal} title={tt('row.modelOverrideHint')}>{tt('row.modelOverride')}</span> : null}
          </>
        : <span className={css.badge + ' ' + css.badgeReadonly}>{tt('row.readonly')}</span>}
      <span className={css.menuAnchor} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMenuOpen(false) }}>
        <button
          ref={moreRef}
          type='button'
          className={css.opBtn + ' ' + css.moreButton}
          aria-label={tt('row.more')}
          aria-haspopup='menu'
          aria-expanded={menuOpen}
          onClick={(event) => { event.stopPropagation(); setMenuOpen((open) => !open) }}
        >⋯</button>
        {menuOpen && menuPos !== null ? <div className={css.menu} role='menu' style={{ top: menuPos.top, right: menuPos.right }}>
          <button type='button' role='menuitem' className={css.menuItem} onClick={(event) => { event.stopPropagation(); setMenuOpen(false); void openDetail(skill.name, skill.workspace) }}>{tt('row.detail')}</button>
          {skill.writable || skill.toggleable === true ? <button type='button' role='menuitem' className={css.menuItem} disabled={busyNames.has(skill.name) || tagBusy} onClick={(event) => { event.stopPropagation(); setMenuOpen(false); void toggle(skill, skill.modelOverride === true) }}>{tt(skill.modelOverride === true ? 'row.enable' : 'row.disable')}</button> : null}
          {/* 移入回收站：与「删除」走同一条后端路径（都是移到 .trash），
              但显示条件放宽到 toggleable —— 项目级技能不是 dsh 可写根
              （writable=false），却完全应该能被回收。已禁用的技能也可以。 */}
          {skill.writable || skill.toggleable === true ? <button type='button' role='menuitem' className={css.menuItem} disabled={busyNames.has(skill.name) || tagBusy} onClick={(event) => { event.stopPropagation(); setMenuOpen(false); requestTrashSkill(skill.name) }}>{tt('row.moveToTrash')}</button> : null}
          {skill.writable ? <button type='button' role='menuitem' className={css.menuItem} disabled={busyNames.has(skill.name) || tagBusy} onClick={(event) => { event.stopPropagation(); setMenuOpen(false); requestDeleteSkill(skill.name) }}>{tt('row.delete')}</button> : null}
        </div> : null}
      </span>
      {editMode && skill.writable ? <button
        type='button'
        className={css.opBtn + ' ' + css.opDanger + ' ' + css.iconBtn}
        disabled={busyNames.has(skill.name) || tagBusy}
        title={tt('row.delete')}
        aria-label={tt('row.delete')}
        onClick={(event) => { event.stopPropagation(); requestDeleteSkill(skill.name) }}
      ><IconTrashOutline16 size={14} /></button> : null}
    </div>
  )
}

/**
 * 行级 memo —— 面板里唯一会被成百次渲染的组件。
 *
 * 5 秒轮询、搜索、筛选、排序都会让父级重跑；没有 memo 时每次都是「全部行 ×
 * 全量重建」。加上之后，只有 `skill` 引用变化（该行数据真变了）、或空闲态 /
 * 忙碌态 / 编辑模式变化时才重渲染。
 *
 * 生效前提（都在父级保证，改动时别破坏）：
 * - `toggle` 经 `catalogRef` 读快照，依赖收敛到 `[api, shared]`，引用稳定；
 * - `duplicateNames` 用 `useMemo` 缓存，不再每次 `new Set()`；
 * - 其余字段直接来自 state，值不变则引用不变。
 */
export const SkillRow = memo(SkillRowImpl)
