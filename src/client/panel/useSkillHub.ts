/**
 * useSkillHub — 面板的状态聚合根：只持有跨域共享的通知状态与纯视图状态，
 * 各域状态与动作分散在 ./hooks/*，这里按依赖顺序组装（meta → 目录 →
 * 分组 → 来源 → 市场），轮询与派生组装在此。返回形状与拆分前完全一致，
 * 所有视图无需改动。All hooks run unconditionally at the top, so the panel
 * may early-return for the detail and tag-editor views without violating
 * the rules of hooks.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SkillHubApi } from '../api.ts'
import type { PermanentStat } from '../../protocol.ts'
import { useMetaFlow } from './hooks/useMetaFlow.ts'
import { useCatalogFlow } from './hooks/useCatalogFlow.ts'
import { useGroupFlow } from './hooks/useGroupFlow.ts'
import { useSourceFlow } from './hooks/useSourceFlow.ts'
import { useMarketFlow } from './hooks/useMarketFlow.ts'
import { markAutoChecked, POLL_MS, shouldAutoCheck, SLOW_POLL_MS, type FlowNotices } from './hooks/shared.ts'

/** The hook's result: the panel's complete state + action surface. */
export type SkillHubState = ReturnType<typeof useSkillHub>

/** 一级视图：通用 / 工作区 / 市场 / 回收站。 */
export type SkillTab = 'general' | 'workspace' | 'market' | 'evolution' | 'trash'

/** 通用页二级查看方式：按调用量 / 按位置 / 按角色。 */
/**
 * 通用页的分类方式。
 *
 * - ll      ：不做分类，全部技能平铺一层
 * - location ：按目录分类（默认）
 * - scene    ：按角色分类
 * - usage    ：按调用量分组（已从分类段移除入口，类型保留以免破坏既有引用）
 */
export type GeneralView = 'all' | 'location' | 'scene' | 'usage'

export function useSkillHub(api: SkillHubApi) {
  // ------------------------------------------------------- shared notices
  // 多域共用的报错/成功条幅与忙碌开关：setter 本身引用稳定，memo 常驻后
  // 各域回调依赖它不会失稳。
  const [loadError, setLoadError] = useState<string | null>(null)
  /** Green success banner (create finished); shown outside the closing form. */
  const [successBanner, setSuccessBanner] = useState<string | null>(null)
  const [batchBusy, setBatchBusy] = useState(false)
  const [tagBusy, setTagBusy] = useState(false)
  const shared = useMemo<FlowNotices>(() => ({
    fail: (message: string) => setLoadError(message),
    clearFail: () => setLoadError(null),
    succeed: (message: string | null) => setSuccessBanner(message),
    setTagBusy,
    setBatchBusy,
  }), [])

  // ------------------------------------------------------------ view state
  // 纯视图状态：不触发数据加载，只影响渲染。
  const [tab, setTab] = useState<SkillTab>('general')
  // 默认「按目录」：调用量已经并入每行的日/周/总，「按调用量」这个独立视图
  // 只是把同一批技能按次数重排一遍，和「按目录」比没有额外信息。
  const [generalView, setGeneralView] = useState<GeneralView>('location')
  /**
   * 分组视图里**展开**的分组（key 为 tag:<id>、col:<name>、role:<id> 或 project 树键）。
   * 默认空集合 = 所有卡片收起：技能多的时候先看分组标题比先看一屏行有用，
   * 展开哪个由用户自己点。
   */
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(new Set())
  /** 项目级三级树里已细分（按 .dsh/.agents）的项目键。 */
  const [subdividedProjects, setSubdividedProjects] = useState<ReadonlySet<string>>(new Set())
  const [showLegend, setShowLegend] = useState(false)
  const [editMode, setEditMode] = useState(false)

  const toggleGroupExpanded = useCallback((key: string): void => {
    setExpandedGroups((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const toggleSubdivide = useCallback((key: string): void => {
    setSubdividedProjects((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  /** 整组展开/收起：传 null 全部收起，传键列表全部展开（视图侧自己算键）。 */
  const setAllGroupsExpanded = useCallback((keys: readonly string[] | null): void => {
    setExpandedGroups(keys === null ? new Set() : new Set(keys))
  }, [])

  /** 兼容旧调用点：技能数很多时不再需要「先折叠个人」，默认本来就是收起的。 */
  const collapsePersonal = useCallback((): void => {
    setExpandedGroups((previous) => {
      if (!previous.has('uncategorized-source')) return previous
      const next = new Set(previous)
      next.delete('uncategorized-source')
      return next
    })
  }, [])

  // ------------------------------------------------------------ meta first
  // 更新检查/统计/配置只依赖 api，最先组装。
  const meta = useMetaFlow(api)

  /**
   * 行列表在各自 view 文件里从 `hub.uses` 组装 rowProps。会话日志统计已移除，
   * 调用量唯一来源是永久账本，所以这里直接把 permanent 挂上去。
   */
  const uses = useMemo<ReadonlyMap<string, { count: number; lastUsed?: number; permanent?: PermanentStat }>>(() => {
    const merged = new Map<string, { count: number; lastUsed?: number; permanent?: PermanentStat }>()
    for (const [name, permanent] of meta.permanentUses) {
      merged.set(name, { count: permanent.total, lastUsed: permanent.lastUsed > 0 ? permanent.lastUsed : undefined, permanent })
    }
    return merged
  }, [meta.permanentUses])

  // ---------------------------------------------------------------- catalog
  const catalogFlow = useCatalogFlow(api, uses, shared, collapsePersonal)

  // ----------------------------------------------------------------- groups
  const groupFlow = useGroupFlow(api, shared)

  // ----------------------------------------------------------------- sources
  const sourceFlow = useSourceFlow(api, shared, catalogFlow.load, groupFlow.loadGroups)

  // ------------------------------------------------------------------ market
  const marketFlow = useMarketFlow(
    api,
    shared,
    catalogFlow.load,
    groupFlow.loadGroups,
    sourceFlow.loadSources,
    sourceFlow.checkSources,
    sourceFlow.sourceCheck,
  )

  // 初始全量加载 + 双速轮询：目录是「活视图」（文件变化要 5 秒内可见），
  // 统计/分组/来源/配置变化慢，60 秒一次足够；写操作本身会触发即时刷新。
  // 更新检查、来源检查、市场检查全部改为手动按钮触发，打开面板不再自动
  // 打三路 GitHub 请求。
  useEffect(() => {
    void catalogFlow.load()
    void meta.loadPermanentUses()
    void groupFlow.loadGroups()
    void sourceFlow.loadSources()
    void meta.loadConfig()
    const fast = window.setInterval(() => { void catalogFlow.load() }, POLL_MS)
    const slow = window.setInterval(() => { void meta.loadPermanentUses(); void groupFlow.loadGroups(); void sourceFlow.loadSources(); void meta.loadConfig() }, SLOW_POLL_MS)
    return () => { window.clearInterval(fast); window.clearInterval(slow) }
  }, [catalogFlow.load, meta.loadPermanentUses, groupFlow.loadGroups, sourceFlow.loadSources, meta.loadConfig])

  // ------------------------------------------------- daily auto-check
  // 打开面板时每天最多自动检查一次（自身更新 + 全部来源 + 全部市场源），
  // 时间戳存 localStorage 跨会话生效；手动按钮随时可用，不受节流限制。
  useEffect(() => {
    if (!shouldAutoCheck()) return
    markAutoChecked()
    void meta.checkUpdate()
    void sourceFlow.checkSources()
    void marketFlow.checkMarket()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return {
    // state
    catalog: catalogFlow.catalog, loading: catalogFlow.loading, loadError, successBanner,
    updateState: meta.updateState,
    repoDiscoverState: marketFlow.repoDiscoverState, scanningRepo: marketFlow.scanningRepo,
    repoSelected: marketFlow.repoSelected, repoImporting: marketFlow.repoImporting,
    repoResult: marketFlow.repoResult,
    search: catalogFlow.search, workspace: catalogFlow.workspace,
    detail: catalogFlow.detail, detailLoading: catalogFlow.detailLoading,
    busyNames: catalogFlow.busyNames, batchBusy,
    showForm: catalogFlow.showForm, formName: catalogFlow.formName, formDesc: catalogFlow.formDesc, formBody: catalogFlow.formBody,
    formRoot: catalogFlow.formRoot, formWorkspace: catalogFlow.formWorkspace, workspaces: catalogFlow.workspaces, formBusy: catalogFlow.formBusy, formMessage: catalogFlow.formMessage,
    uses, permanentUses: meta.permanentUses, hubConfig: meta.hubConfig, tab, generalView,
    invocationFilter: catalogFlow.invocationFilter, statusFilter: catalogFlow.statusFilter, sortKey: catalogFlow.sortKey,
    marketState: marketFlow.marketState, marketCheck: marketFlow.marketCheck,
    marketStats: marketFlow.marketStats, branchChoice: marketFlow.branchChoice, branchBusy: marketFlow.branchBusy,
    marketSyncDialog: marketFlow.marketSyncDialog, syncingMarket: marketFlow.syncingMarket,
    syncBusy: marketFlow.syncBusy, newSourceName: marketFlow.newSourceName,
    skillsShQuery: marketFlow.skillsShQuery, skillsShState: marketFlow.skillsShState,
    skillsShInstalling: marketFlow.skillsShInstalling,
    skillsShSort: marketFlow.skillsShSort, sortedSkillsSh: marketFlow.sortedSkillsSh,
    skillsShDetail: marketFlow.skillsShDetail, skillsShDetailLoading: marketFlow.skillsShDetailLoading,
    skillsShDetailError: marketFlow.skillsShDetailError,
    setSkillsShSort: marketFlow.setSkillsShSort, loadSkillsShDetail: marketFlow.loadSkillsShDetail,
    groupsState: groupFlow.groupsState, sourcesState: sourceFlow.sourcesState,
    sourceCheck: sourceFlow.sourceCheck, checkingSource: sourceFlow.checkingSource,
    syncingSource: sourceFlow.syncingSource,
    confirmDialog: sourceFlow.confirmDialog,
    deleteSkillDialog: sourceFlow.deleteSkillDialog, deleteGroupDialog: sourceFlow.deleteGroupDialog,
    confirmClearTrash: sourceFlow.confirmClearTrash, updateAllDialog: marketFlow.updateAllDialog,
    tagBusy, expandedGroups, subdividedProjects, showLegend, editMode,
    versionDialog: marketFlow.versionDialog, versionBusy: marketFlow.versionBusy,
    // derived
    actionNames: catalogFlow.actionNames, viewNames: catalogFlow.viewNames,
    filtered: catalogFlow.filtered, sorted: catalogFlow.sorted, searchedSorted: catalogFlow.searchedSorted,
    shortenedCount: catalogFlow.shortenedCount,
    // actions + setters
    setLoadError, setSuccessBanner, setSearch: catalogFlow.setSearch, setWorkspace: catalogFlow.setWorkspace,
    setDetail: catalogFlow.setDetail, setShowForm: catalogFlow.setShowForm, setFormName: catalogFlow.setFormName,
    setFormDesc: catalogFlow.setFormDesc, setFormBody: catalogFlow.setFormBody, setFormRoot: catalogFlow.setFormRoot, setFormWorkspace: catalogFlow.setFormWorkspace,
    setFormMessage: catalogFlow.setFormMessage,
    setRepoSelected: marketFlow.setRepoSelected, setTab, setGeneralView,
    setInvocationFilter: catalogFlow.setInvocationFilter, setStatusFilter: catalogFlow.setStatusFilter, setSortKey: catalogFlow.setSortKey,
    setBranchChoice: marketFlow.setBranchChoice, setMarketSyncDialog: marketFlow.setMarketSyncDialog,
    setNewSourceName: marketFlow.setNewSourceName,
    setSkillsShQuery: marketFlow.setSkillsShQuery,
    setConfirmDialog: sourceFlow.setConfirmDialog,
    setDeleteSkillDialog: sourceFlow.setDeleteSkillDialog, setDeleteGroupDialog: sourceFlow.setDeleteGroupDialog,
    setConfirmClearTrash: sourceFlow.setConfirmClearTrash, setUpdateAllDialog: marketFlow.setUpdateAllDialog,
    setShowLegend, setEditMode,
    setVersionDialog: marketFlow.setVersionDialog,
    toggleGroupExpanded, toggleSubdivide, setAllGroupsExpanded, checkUpdate: meta.checkUpdate, loadMarket: marketFlow.loadMarket,
    openDetail: catalogFlow.openDetail, toggle: catalogFlow.toggle, setInvocation: catalogFlow.setInvocation, enableDisabled: catalogFlow.enableDisabled,
    batchToggleNames: catalogFlow.batchToggleNames,
    runConfirmed: sourceFlow.runConfirmed, checkSources: sourceFlow.checkSources,
    requestSync: sourceFlow.requestSync, requestDelete: sourceFlow.requestDelete,
    restoreTrash: sourceFlow.restoreTrash, clearTrash: sourceFlow.clearTrash,
    fixingPaths: catalogFlow.fixingPaths, fixDiagnostic: catalogFlow.fixDiagnostic,
    clearListFilters: catalogFlow.clearListFilters, openVersionDialog: marketFlow.openVersionDialog,
    confirmVersionDialog: marketFlow.confirmVersionDialog, requestDeleteSkill: sourceFlow.requestDeleteSkill, requestTrashSkill: sourceFlow.requestTrashSkill,
    runDeleteSkill: sourceFlow.runDeleteSkill, requestDeleteGroup: sourceFlow.requestDeleteGroup,
    runDeleteGroup: sourceFlow.runDeleteGroup,
    addSource: marketFlow.addSource, addMarketSource: marketFlow.addMarketSource,
    runSkillsShSearch: marketFlow.runSkillsShSearch, installSkillsSh: marketFlow.installSkillsSh,
    removeMarketSource: marketFlow.removeMarketSource, requestRemoveMarketSource: marketFlow.requestRemoveMarketSource,
    cancelRemoveMarketSource: marketFlow.cancelRemoveMarketSource, confirmRemoveMarketSource: marketFlow.confirmRemoveMarketSource,
    removeMarketDialog: marketFlow.removeMarketDialog, scanRepo: marketFlow.scanRepo,
    confirmBranchChoice: marketFlow.confirmBranchChoice, toggleRepoSelected: marketFlow.toggleRepoSelected,
    importRepo: marketFlow.importRepo, cancelImport: marketFlow.cancelImport,
    clearScan: marketFlow.clearScan,
    checkMarket: marketFlow.checkMarket, loadMarketStats: marketFlow.loadMarketStats,
    syncMarketSource: marketFlow.syncMarketSource, confirmMarketSync: marketFlow.confirmMarketSync,
    updateAll: marketFlow.updateAll, create: catalogFlow.create, reloadCatalog: catalogFlow.load,
  }
}
