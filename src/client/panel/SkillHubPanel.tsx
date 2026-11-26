/**
 * The skill hub panel: catalog ranked by usage or grouped by role / location,
 * search and filter in one row, per-group tri-state switches with conflict
 * dialogs, upstream source tracking (check / sync / follow upstream deletion
 * into a restorable trash), market sources, disabled re-enable, detail
 * inspection, and the new-skill scaffold form.
 *
 * Thin shell: state and flows live in useSkillHub, the tab contents live in
 * RoleGroupsView / LocationsView / MarketView, the dialog family
 * lives in dialogs.tsx, and their wiring lives in PanelDialogs.tsx. This
 * component owns only the shared chrome (header, banners, filter bar, shared
 * sections) and the view routing. Hooks below own only its local UI state.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { IconSkillOutline16 } from '../icons.tsx'
import type { SkillHubApi } from '../api.ts'
import { errorMessage, tt } from '../helpers.ts'
import { isProjectSource, type SortKey } from '../grouping.ts'
import { dotStyle } from './format.ts'
import { SkillDetailView } from './SkillDetailView.tsx'
import { LocationsView } from './LocationsView.tsx'
import { SkillRows } from './SkillRows.tsx'
import { FilterSearch } from './FilterSearch.tsx'
import { RoleGroupsView } from './RoleGroupsView.tsx'
import { UsageView } from './UsageView.tsx'
import { EvolutionView } from './EvolutionView.tsx'
import { WorkspaceView } from './WorkspaceView.tsx'
import { TrashView } from './TrashView.tsx'
import { MarketView } from './MarketView.tsx'
import { PanelDialogs } from './PanelDialogs.tsx'
import { ForeignImportDialog } from './ForeignImportDialog.tsx'
import { CreateSkillDialog } from './CreateSkillDialog.tsx'
import { useSkillHub, type GeneralView } from './useSkillHub.ts'
import css from './panel.module.css'

export interface SkillHubPanelProps {
  api: SkillHubApi
  /** Settings panels stay 720px; the sidebar main panel gets the wide shell. */
  mode?: 'settings' | 'sidebar'
  /** 插件设置入口：点击「设置」按钮跳转到插件设置页（由宿主提供，缺省时隐藏按钮）。 */
  onOpenSettings?: () => void
}

export function SkillHubPanel(props: SkillHubPanelProps): React.JSX.Element {
  const hub = useSkillHub(props.api)
  const isSidebar = props.mode === 'sidebar'
  /** 工作区输入草稿：回车才应用，避免每次按键都触发目录重拉。 */
  /** 「从其他 Agent 导入」弹窗开合。 */
  const [showForeign, setShowForeign] = useState(false)
  /** ZIP 导入：隐藏的文件选择框 + 上传中状态。 */
  const zipInputRef = useRef<HTMLInputElement | null>(null)
  const [zipBusy, setZipBusy] = useState(false)
  /** 「筛选」面板开合（来源 + 调用方式收进这里；搜索/排序/视图切换始终可见）。 */
  /** 「更多」溢出菜单：低频导入动作收进这里，保持顶部克制。 */
  const [moreOpen, setMoreOpen] = useState(false)
  const {
    catalog, loading, loadError, successBanner, updateState, detail, detailLoading, showForm, formName, formDesc,
    formBody, formRoot, formWorkspace, workspaces, formBusy, formMessage, hubConfig, tab, generalView, statusFilter, sortKey, search,
    sourcesState, tagBusy, batchBusy, filtered,
    confirmDialog, deleteSkillDialog, deleteGroupDialog, confirmClearTrash, branchChoice, branchBusy, marketSyncDialog,
    syncBusy, uses, sourceCheck, checkingSource, syncingSource,
    showLegend,
    setLoadError, setSuccessBanner, setDetail, setShowForm, setFormName, setFormDesc, setFormBody, setFormRoot, setFormWorkspace, setFormMessage, setTab,
    setGeneralView, setStatusFilter, setSortKey, setSearch, setConfirmDialog, setDeleteSkillDialog, setDeleteGroupDialog,
    setConfirmClearTrash, setBranchChoice, setMarketSyncDialog,
    setShowLegend,
    checkUpdate, loadMarket, checkSources, requestSync, requestDelete, clearTrash, runDeleteSkill, runDeleteGroup,
    runConfirmed, confirmBranchChoice, confirmMarketSync, create, enableDisabled, reloadCatalog,
  } = hub
  const { shortenedCount, fixingPaths, clearListFilters } = hub
  /**
   * 诊断分级由服务端单点判定（error = provider 跳过、技能不可用；warn = 能加载
   * 但有问题）。这里只计数，别在 UI 里按 reason 文案反推级别。
   */
  const diagErrorCount = catalog?.diagnostics.filter((entry) => entry.level === 'error').length ?? 0
  const diagWarnCount = (catalog?.diagnostics.length ?? 0) - diagErrorCount

  /**
   * ZIP 导入：选完文件立刻上传，不做二次确认 —— 服务端逐条回报
   * imported / skipped / failed，阻断级内容根本落不了盘，结果直接进横幅。
   * 部分成功也要显示成功数，否则用户会以为一个都没进去。
   */
  const importZip = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return
    setZipBusy(true)
    setLoadError(null)
    setSuccessBanner(null)
    try {
      const result = await props.api.importZip(file)
      const replaced = result.replaced?.length ?? 0
      if (result.imported.length > 0) {
        void reloadCatalog()
        setSuccessBanner(tt(replaced > 0 ? 'zip.importedReplacedBanner' : 'zip.importedBanner', { count: result.imported.length, replaced }))
      }
      const notes: string[] = []
      if (result.skipped.length > 0) notes.push(tt('zip.skippedBanner', { count: result.skipped.length }))
      if (result.failed.length > 0) {
        const detail = result.failed.slice(0, 3).map((failure) => failure.name + ': ' + failure.error).join('; ')
        notes.push(tt('zip.failedBanner', { count: result.failed.length, detail }))
      }
      if (result.warnings.length > 0) notes.push(tt('zip.warnBanner', { count: result.warnings.length }))
      if (notes.length > 0) setLoadError(notes.join(' '))
    } catch (caught) {
      setLoadError(errorMessage(caught))
    } finally {
      setZipBusy(false)
      // 清空 value：同一个文件连选两次也要能再次触发 change。
      if (zipInputRef.current !== null) zipInputRef.current.value = ''
    }
  }

  // -------------------------------------------------------------- detail

  useEffect(() => {
    if (detail === null) return
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') setDetail(null) }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [detail, setDetail])

  if (detail !== null) {
    const disabledRecord = detail.source !== undefined && isProjectSource(detail.source)
      ? undefined
      : catalog?.disabled.find((record) => {
          if (detail.path === undefined) return record.name === detail.name
          // 台账 path 就是发现文件本身（停用不再改名），直接比即可。
          return record.path === detail.path
        })
    return (
      <div className={css.detailOverlay} role='presentation' onMouseDown={(event) => { if (event.target === event.currentTarget) setDetail(null) }}>
        <div className={css.detailModal} role='dialog' aria-modal='true' aria-label={tt('detail.title')}>
          <SkillDetailView
            detail={detail}
            hubConfig={hubConfig}
            uses={uses}
            sourcesState={sourcesState}
            sourceCheck={sourceCheck}
            checkingSource={checkingSource}
            syncingSource={syncingSource}
            disabled={disabledRecord !== undefined}
            onEnable={disabledRecord !== undefined ? () => { void enableDisabled(disabledRecord).then(() => { setDetail(null) }) } : undefined}
            onBack={() => { setDetail(null) }}
            onCheck={(repo) => { void checkSources(repo) }}
            onSync={requestSync}
            onFollowDelete={requestDelete}
            modal
          />
        </div>
      </div>
    )
  }

  /**
   * The role view ignores the persisted status filter (a role is derived from
   * the whole catalog — see RoleGroupsView), so it must not count as active
   * there, and the header must not report a shrunken total.
   */
  const rolesView = tab === 'general' && generalView === 'scene'
  const statusFilterActive = !rolesView && statusFilter !== 'all'
  /** 生效中的筛选条件数（调用方式 + 状态），显示在「筛选」按钮上。 */

  /** 检查结果的悬停提示：收敛到「检查更新」按钮上，不再占面板顶部横幅。 */
  const updateTitle = ((): string | undefined => {
    if (updateState.status === 'checking') return tt('update.checking')
    if (updateState.status === 'error') return tt('update.error', { error: updateState.message })
    if (updateState.status === 'ready') {
      const data = updateState.data
      if (data.error !== undefined) return tt('update.error', { error: data.error })
      if (data.updateAvailable) return tt('update.available', { version: data.latestVersion ?? '', current: data.currentVersion })
      if (data.latestVersion === null) return tt('update.unavailable')
      return tt('update.upToDate', { version: data.latestVersion })
    }
    return undefined
  })()

  const projectCount = catalog?.skills.filter((skill) => isProjectSource(skill.source)).length ?? 0
  const generalAllActive = (catalog?.skills ?? []).filter((skill) => !isProjectSource(skill.source))
  const generalSkills = generalAllActive
  // 停用技能已在 `catalog.skills` 里带 `modelOverride`，sidecar 的
  // `catalog.disabled` 只是台账。计数只能数 skills[] 一次 —— 以前把台账
  // 再加一遍，头部的「共 N 个」会把停用技能算成两份。
  const generalCount = generalSkills.length
  const generalDisabledAll = generalSkills.filter((skill) => skill.modelOverride === true).length
  const generalEnabledCount = generalCount - generalDisabledAll
  const generalActiveShown = rolesView
    ? generalAllActive.length
    : statusFilter === 'disabled'
      ? generalDisabledAll
      : statusFilter === 'enabled'
        ? generalEnabledCount
        : generalCount
  const scopedSkills = (catalog?.skills ?? []).filter((skill) => tab === 'workspace' ? isProjectSource(skill.source) : !isProjectSource(skill.source))
  const rowSource = rolesView ? hub.searchedSorted : filtered
  const scopedFilteredBase = rowSource.filter((skill) => tab === 'workspace' ? isProjectSource(skill.source) : !isProjectSource(skill.source))
  const scopedFiltered = scopedFilteredBase
  /**
   * 「全部分类」平铺专用的行源。
   *
   * 修复：平铺分支以前用 `scopedFiltered`（源自未排序的 `filtered`），
   * 于是切到「全部」时排序键失效、退回目录顺序。分组视图（按目录/按角色）
   * 读的是 `hub.sorted`，所以只有平铺这一支漏了。这里改成从 `hub.sorted`
   * 取，三种分类统一吃同一个排序结果。
   */
  const scopedSorted = useMemo(
    () => hub.sorted.filter((skill) => !isProjectSource(skill.source)),
    [hub.sorted],
  )
  const visibleDisabledCount = scopedFiltered.filter((skill) => skill.modelOverride === true).length
  const shownCount = scopedFiltered.length
  /**
   * 「全部分类」平铺用的行属性。
   *
   * 与 LocationsView 里那份保持同一组字段（状态过滤、启用/禁用、移入回收站、
   * 查看详情都在），只是来源换成面板这一层的 hub。
   */
  const generalRowProps = {
    uses: hub.uses,
    // 与工作区页同一份 rowProps：调用量/最近调用由 SkillRow 统一读取
    // permanentUses（缺则回退 uses.permanent），受同一组 showUseCount/showUseTime 控制。
    permanentUses: hub.permanentUses,
    hubConfig: hub.hubConfig,
    busyNames: hub.busyNames,
    editMode: hub.editMode,
    tagBusy: hub.tagBusy,
    duplicateNames: new Set(catalog?.duplicateNames ?? []),
    statusFilter: hub.statusFilter,
    hideSourceBadge: true,
    toggle: hub.toggle,
    openDetail: hub.openDetail,
    requestDeleteSkill: hub.requestDeleteSkill,
    requestTrashSkill: hub.requestTrashSkill,
  }
  const totalCount = tab === 'general' ? generalActiveShown : scopedSkills.length
  const headerCount = tab === 'workspace'
    ? projectCount
    : tab === 'trash'
      ? (sourcesState?.trash.length ?? 0)
      : tab === 'market' || tab === 'evolution'
        ? null
        : generalActiveShown

  return (
    <div className={css.panel + (isSidebar ? ' ' + css.panelWide : '')} aria-busy={batchBusy || tagBusy}>
      <div className={css.header}>
        <h2 className={css.title}><IconSkillOutline16 size={16} className={css.titleIcon} /> {tt('panel.title')}{catalog !== null ? <span className={css.pluginVersion}>v{catalog.pluginVersion}</span> : null}</h2>
        {headerCount !== null
          ? <span className={css.headerCount}>
              {tt('panel.count', { count: headerCount })}
              {tab === 'general' && catalog !== null && (rolesView || statusFilter !== 'enabled') && visibleDisabledCount > 0 ? ' · ' + tt('panel.disabledCount', { count: visibleDisabledCount }) : null}
            </span>
          : null}
        {catalog !== null && !catalog.complete ? <span className={css.hint}>{tt('panel.incomplete')}</span> : null}
        {catalog !== null && (catalog.duplicateNames?.length ?? 0) > 0 ? <button type='button' className={css.opBtn} title={tt('row.duplicateHint')} onClick={() => { clearListFilters() }}>⚠ {tt('row.duplicate')}×{(catalog.duplicateNames ?? []).length}</button> : null}
        <span className={css.actions}>
          {updateState.status === 'ready' && updateState.data.updateAvailable && updateState.data.url !== null
            ? <a className={css.updateLink} href={updateState.data.url} target='_blank' rel='noreferrer'>{tt('update.newVersion', { version: updateState.data.latestVersion ?? '' })}</a>
            : null}
          {props.onOpenSettings !== undefined ? (
            <button type='button' className={css.button} title={tt('settings.openHint')} onClick={props.onOpenSettings}>{tt('settings.open')}</button>
          ) : null}
          <button type='button' className={css.button + ' ' + css.primary} onClick={() => { setShowForm((value) => !value) }}>{tt('panel.new')}</button>
          <button type='button' className={css.legendToggle + (showLegend ? ' ' + css.legendToggleActive : '')} aria-label={tt('legend.hint')} onClick={() => { setShowLegend((value) => !value) }} title={tt('legend.hint')}>?</button>
          <span className={css.menuAnchor}>
            <button
              type='button'
              className={css.opBtn + ' ' + css.moreButton}
              aria-label={tt('panel.more')}
              aria-haspopup='menu'
              aria-expanded={moreOpen}
              title={tt('panel.more')}
              onClick={() => { setMoreOpen((value) => !value) }}
            >⋯</button>
            {moreOpen ? (
              <div className={css.menu} role='menu'>
                <button type='button' role='menuitem' className={css.menuItem} disabled={updateState.status === 'checking'} title={updateTitle} onClick={() => { setMoreOpen(false); void checkUpdate() }}>{updateState.status === 'checking' ? tt('update.checking') : tt('update.check')}</button>
                <button type='button' role='menuitem' className={css.menuItem} onClick={() => { setMoreOpen(false); setShowForeign(true) }}>{tt('foreign.open')}</button>
                <button type='button' role='menuitem' className={css.menuItem} disabled={zipBusy} title={tt('zip.hint')} onClick={() => { setMoreOpen(false); zipInputRef.current?.click() }}>{zipBusy ? tt('zip.importing') : tt('zip.open')}</button>
              </div>
            ) : null}
          </span>
        </span>
      </div>
      <div className={css.mainTabs} role='tablist' aria-label={tt('panel.title')}>
        <button type='button' role='tab' aria-selected={tab === 'general'} className={css.mainTab + (tab === 'general' ? ' ' + css.mainTabActive : '')} onClick={() => { setTab('general') }}>{tt('view.general')}</button>
        <button type='button' role='tab' aria-selected={tab === 'workspace'} className={css.mainTab + (tab === 'workspace' ? ' ' + css.mainTabActive : '')} onClick={() => { setTab('workspace') }}>{tt('view.workspace')}</button>
        <button type='button' role='tab' aria-selected={tab === 'market'} className={css.mainTab + (tab === 'market' ? ' ' + css.mainTabActive : '')} onClick={() => { setTab('market'); void loadMarket() }}>{tt('view.market')}</button>
        <button type='button' role='tab' aria-selected={tab === 'evolution'} className={css.mainTab + (tab === 'evolution' ? ' ' + css.mainTabActive : '')} onClick={() => { setTab('evolution') }}>{tt('view.evolution')}</button>
        <button type='button' role='tab' aria-selected={tab === 'trash'} className={css.mainTab + (tab === 'trash' ? ' ' + css.mainTabActive : '')} onClick={() => { setTab('trash') }}>{tt('view.trash')}{tab !== 'trash' && (sourcesState?.trash.length ?? 0) > 0 ? <span className={css.tabCount}>{sourcesState?.trash.length}</span> : null}</button>
      </div>
      <input
        ref={zipInputRef}
        type='file'
        accept='.zip,application/zip'
        className={css.hiddenFile}
        onChange={(event) => { void importZip(event.target.files?.[0]) }}
      />

      {showForeign ? (
        <ForeignImportDialog
          api={props.api}
          onClose={() => { setShowForeign(false) }}
          onImported={(imported, replaced) => {
            void reloadCatalog()
            setSuccessBanner(tt(replaced > 0 ? 'foreign.importedReplacedBanner' : 'foreign.importedBanner', { count: imported.length, replaced }))
          }}
        />
      ) : null}

      {showForm ? (
        <CreateSkillDialog
          name={formName}
          desc={formDesc}
          body={formBody}
          root={formRoot}
          workspace={formWorkspace}
          workspaces={workspaces}
          busy={formBusy}
          message={formMessage}
          onNameChange={setFormName}
          onDescChange={setFormDesc}
          onBodyChange={setFormBody}
          onWorkspaceChange={setFormWorkspace}
          onRootChange={setFormRoot}
          onSubmit={(event) => { void create(event) }}
          onClose={() => { setShowForm(false); setFormMessage(null) }}
        />
      ) : null}

      {loadError !== null ? (
        <div className={css.errorBanner} role='alert'>
          <span>{loadError}</span>
          <button type='button' className={css.button} aria-label={tt('err.dismiss')} onClick={() => { setLoadError(null) }}>{tt('err.dismiss')}</button>
        </div>
      ) : null}

      {successBanner !== null ? (
        <div className={css.successBanner} role='status'>
          <span>{successBanner}</span>
          <button type='button' className={css.button} aria-label={tt('err.dismiss')} onClick={() => { setSuccessBanner(null) }}>{tt('err.dismiss')}</button>
        </div>
      ) : null}

      {showLegend ? (
        <div className={css.legend}>
          <span className={css.legendItem}><span className={css.dot + ' ' + css.dotModel} style={dotStyle(hubConfig?.dotModelColor)} />{tt('legend.model')}</span>
          <span className={css.legendItem}><span className={css.dot + ' ' + css.dotUser} style={dotStyle(hubConfig?.dotUserColor)} />{tt('legend.user')}</span>
          <span className={css.legendHint}>{tt('legend.hint')}</span>
        </div>
      ) : null}

      {loading ? (
        <div className={css.skeleton} role='status' aria-label={tt('panel.loading')}>
          <div className={css.skeletonRow} />
          <div className={css.skeletonRow} />
          <div className={css.skeletonRow} />
        </div>
      ) : null}

      {detailLoading ? <div className={css.empty}>{tt('detail.loading')}</div> : null}

      {tab === 'market' ? (
        <MarketView hub={hub} />
      ) : tab === 'evolution' ? (
        <EvolutionView api={props.api} onApplied={() => { void hub.reloadCatalog() }} />
      ) : tab === 'trash' ? (
        <TrashView hub={hub} />
      ) : catalog !== null ? (
        <>
          {/* 工作区页的整条工具栏（项目下拉 / 状态 / 调用方式 / 搜索）由
              WorkspaceView 独占渲染。这里**整块不渲染**，而不是只清空内容 ——
              以前是 `{tab === 'workspace' ? null : (...)}` 只排除了内部控件，
              外层 `<div className={css.filterBar}>` 仍然存在，于是工作区页会
              出现「空的一行筛选条 + 页内真控件」两份卡片叠在一起。
              条件前置到容器上，工作区页只剩 WorkspaceView 那一份。 */}
          {tab === 'workspace' ? null : (
            <div className={css.filterBar}>
              {/* 控件顺序固定：分类 → 状态 → 排序 → 调用方式 → 搜索。
                  分类用 select 而不是分段按钮：三项之后还会增删口径，
                  下拉不会把筛选行越挤越宽。 */}
              {tab === 'general' ? (
                <select
                  className={css.select + ' ' + css.filterInline}
                  value={generalView}
                  aria-label={tt('view.category')}
                  title={tt('view.category')}
                  onChange={(event) => { setGeneralView(event.target.value as GeneralView) }}
                >
                  <option value='all'>{tt('view.allCategories')}</option>
                  <option value='location'>{tt('view.byLocation')}</option>
                  <option value='scene'>{tt('view.byRole')}</option>
                </select>
              ) : null}
              {rolesView ? null : (
                <select className={css.select + ' ' + css.filterInline} value={statusFilter} aria-label={tt('filter.status')} onChange={(event) => { setStatusFilter(event.target.value as 'all' | 'enabled' | 'disabled') }}>
                  <option value='all'>{tt('filter.statusAll')}</option>
                  <option value='enabled'>{tt('filter.statusEnabled')}</option>
                  <option value='disabled'>{tt('filter.statusDisabled')}</option>
                </select>
              )}
              <select className={css.select + ' ' + css.filterInline} value={hub.invocationFilter} aria-label={tt('filter.invocation')} onChange={(event) => { hub.setInvocationFilter(event.target.value as 'all' | 'model' | 'user') }}>
                <option value='all'>{tt('filter.invocationAll')}</option>
                <option value='model'>{tt('filter.modelOnly')}</option>
                <option value='user'>{tt('filter.userOnly')}</option>
              </select>
              {/* 排序放在调用方式之后；选项顺序 按调用量 → 创建时间 → 名称（默认 uses）。 */}
              <select className={css.select + ' ' + css.filterInline} value={sortKey} aria-label={tt('sort.label')} onChange={(event) => { setSortKey(event.target.value as SortKey) }}>
                <option value='uses'>{tt('sort.uses')}</option>
                <option value='added'>{tt('sort.added')}</option>
                <option value='name'>{tt('sort.name')}</option>
              </select>
              {/* 搜索固定放在整行最后：输入只改草稿，点按钮/Enter 才应用。 */}
              <FilterSearch value={search} onApply={setSearch} />
            </div>
          )}
          {rolesView ? <p className={css.filterNote}>{tt('role.filterNote')}</p> : null}
          {shownCount > 0 && (shownCount !== totalCount || hub.invocationFilter !== 'all' || statusFilterActive) ? (
            <div className={css.hintLine + ' ' + css.hintRowTight}>
              <span>{tt('filter.showing', { shown: shownCount, total: totalCount, filtered: hub.invocationFilter !== 'all' || statusFilterActive ? tt('filter.filteredSuffix') : '' })}</span>
              {shortenedCount > 0 ? <span title={tt('filter.shortened', { count: shortenedCount })}>{tt('filter.shortened', { count: shortenedCount })}</span> : null}
            </div>
          ) : null}

          {tab === 'general' && shownCount === 0 ? (
            catalog.skills.length === 0 && catalog.disabled.length === 0 && catalog.diagnostics.length === 0
              ? <div className={css.empty}>{tt('panel.emptyAll')}</div>
              : <div className={css.empty}>{tt('panel.empty')}</div>
          ) : null}

          {/* 「全部分类」：不做任何分组，全部技能平铺一层。
              复用 WorkspaceView 里同一套平铺容器与行组件（`SkillRows`），
              不另造一套列表 —— 行尺寸、操作、状态徽标因此完全一致。 */}
          {tab === 'general' && generalView === 'all' ? (
            <div className={css.workspaceFlatList}>
              <SkillRows skills={scopedSorted} rowProps={generalRowProps} />
            </div>
          ) : null}
          {tab === 'general' && generalView === 'location' ? <LocationsView hub={hub} /> : null}
          {tab === 'general' && generalView === 'scene' ? <RoleGroupsView hub={hub} /> : null}
          {tab === 'general' && generalView === 'usage' ? <UsageView hub={hub} /> : null}
          {tab === 'workspace' ? <WorkspaceView hub={hub} /> : null}

          {catalog.diagnostics.length > 0 ? (
            <section className={css.section}>
              <div className={css.sectionTitle + ' ' + css.diagSectionTitle}>
                <span>{tt('panel.diagnostics', { count: catalog.diagnostics.length })}</span>
                <span className={css.diagSummary}>{tt('diag.summary', { error: diagErrorCount, warn: diagWarnCount })}</span>
              </div>
              {catalog.diagnostics.map((entry, index) => (
                <div key={entry.path + '|' + String(index)} className={css.diagRow + (entry.level === 'error' ? ' ' + css.diagRowBlock : '') + ' ' + css.diagRowFlex}>
                  <div className={css.diagMain}>
                    <div className={css.diagPath}>
                      <span
                        className={css.diagBadge + ' ' + (entry.level === 'error' ? css.diagBadgeError : css.diagBadgeWarn)}
                        title={tt(entry.level === 'error' ? 'diag.levelErrorHint' : 'diag.levelWarnHint')}
                      >{tt(entry.level === 'error' ? 'diag.levelError' : 'diag.levelWarn')}</span>
                      {entry.kind === 'security' ? <span className={css.auditBadge}>{tt('panel.auditBadge')}</span> : null}
                      {entry.path}
                    </div>
                    <div className={css.diagReason}>{entry.reason}</div>
                  </div>
                  {entry.fixable === true ? (
                    <button
                      type='button'
                      disabled={fixingPaths.has(entry.path)}
                      onClick={() => { void hub.fixDiagnostic(entry.path) }}
                      className={css.opBtn + ' ' + css.diagFix}
                    >{fixingPaths.has(entry.path) ? tt('diag.fixing') : tt('diag.fix')}</button>
                  ) : null}
                </div>
              ))}
            </section>
          ) : null}
        </>
      ) : null}

      <PanelDialogs
        confirmDialog={confirmDialog}
        setConfirmDialog={setConfirmDialog}
        runConfirmed={runConfirmed}
        sourceCheck={sourceCheck}
        branchChoice={branchChoice}
        branchBusy={branchBusy}
        setBranchChoice={setBranchChoice}
        confirmBranchChoice={confirmBranchChoice}
        versionDialog={hub.versionDialog}
        versionBusy={hub.versionBusy}
        setVersionDialog={hub.setVersionDialog}
        confirmVersionDialog={hub.confirmVersionDialog}
        marketSyncDialog={marketSyncDialog}
        syncBusy={syncBusy}
        setMarketSyncDialog={setMarketSyncDialog}
        confirmMarketSync={confirmMarketSync}
        deleteSkillDialog={deleteSkillDialog}
        setDeleteSkillDialog={setDeleteSkillDialog}
        runDeleteSkill={runDeleteSkill}
        deleteGroupDialog={deleteGroupDialog}
        setDeleteGroupDialog={setDeleteGroupDialog}
        runDeleteGroup={runDeleteGroup}
        confirmClearTrash={confirmClearTrash}
        setConfirmClearTrash={setConfirmClearTrash}
        clearTrash={clearTrash}
      />
    </div>
  )
}
