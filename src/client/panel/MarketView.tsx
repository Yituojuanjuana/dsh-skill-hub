/**
 * Market tab: one unified market list — built-in catalog entries (add
 * button while not yet added) and the user's market sources (full state
 * badges + actions once added, plus custom sources), with check-all and
 * update-all actions and the repo scan result with the importable checklist.
 * 行渲染在 MarketSourceRow，扫描卡片在 RepoScanCard，数字格式在 market-format。
 */

import { Fragment, useEffect, useMemo, useState, type JSX } from 'react'
import { tt } from '../helpers.ts'
import { MARKET_CATALOG } from '../market-catalog.ts'
import { ConfirmDialog } from './dialogs.tsx'
import type { SkillHubState } from './useSkillHub.ts'
import { MarketSourceRow } from './MarketSourceRow.tsx'
import { RepoScanCard } from './RepoScanCard.tsx'
import { SKILLS_SH_TOP_N } from './market-format.ts'
import css from './panel.module.css'

export function MarketView(props: { hub: SkillHubState }): JSX.Element {
  const { hub } = props
  const { marketState, marketCheck, sourceCheck, scanningRepo, newSourceName, setNewSourceName, tagBusy, batchBusy, addSource, addMarketSource, checkMarket, checkSources, updateAllDialog, setUpdateAllDialog, updateAll, removeMarketDialog, cancelRemoveMarketSource, confirmRemoveMarketSource, skillsShQuery, skillsShState, setSkillsShQuery, runSkillsShSearch, skillsShInstalling, installSkillsSh, skillsShSort, sortedSkillsSh, skillsShDetail, skillsShDetailLoading, skillsShDetailError, setSkillsShSort, loadSkillsShDetail } = hub
  /** 搜索区块默认展开：它是发现入口，收起状态留给用户自己决定。 */
  const [skillsShOpen, setSkillsShOpen] = useState(true)
  /** 当前展开了说明的结果键（`source/skillId`）；同时只展开一条，避免长文撑爆列表。 */
  const [skillsShDetailOpen, setSkillsShDetailOpen] = useState<string | null>(null)
  /** 市场操作的总忙态：扫描中或标签写入中都不该再触发新的源操作。 */
  const marketBusy = scanningRepo !== null || tagBusy || batchBusy
  /** 有可更新内容的 repo：来源技能更新与市场新 release 的并集。 */
  const sourceUpdatableRepos = Object.entries(sourceCheck).filter(([, check]) => check.changed && check.updated.length > 0)
  const releaseUpdatableRepos = Object.entries(marketCheck).filter(([, check]) => check.updateAvailable === true)
  const updatableRepos = [...new Set([...sourceUpdatableRepos.map(([repo]) => repo), ...releaseUpdatableRepos.map(([repo]) => repo)])]

  // 打开市场 tab 即拉一次星星/下载数（服务端小时级缓存）。挂载一次即可：
  // hub 对象每次渲染都是新引用，依赖它会让每次渲染都重拉。
  useEffect(() => { void hub.loadMarketStats() }, [])
  // eslint-disable-next-line react-hooks/exhaustive-deps

  // 统一列表：内置目录（未添加 → 描述+添加按钮；已添加 → 完整行）在前，
  // 自定义市场源（不在内置目录里）随后。同一个仓库不会出现两次。
  /**
   * 「已装 N 个」按 catalog 里的真实技能过滤。
   *
   * `sources[].skills` 是导入时写下的名字清单，技能文件被 hub 之外的方式删掉
   * （git 切分支、手工清理、外部工具）之后名字会留着，直接数它就会显示
   * 「已装 3 个」而下面只有 1 行。catalog 只覆盖当前已发现的技能，判据正好。
   */
  const installedNames = useMemo(() => new Set((hub.catalog?.skills ?? []).map((skill) => skill.name)), [hub.catalog])
  const rows: Array<{ key: string; element: JSX.Element }> = []
  for (const entry of MARKET_CATALOG) {
    const record = marketState.repos.find((item) => item.repo === entry.repo)
    if (record !== undefined) {
      rows.push({ key: entry.repo, element: <MarketSourceRow hub={hub} record={record} installedNames={installedNames} /> })
    } else {
      const busy = scanningRepo !== null || tagBusy
      rows.push({
        key: entry.repo,
        element: (
          <div className={css.row + ' ' + css.rowStatic}>
            <div className={css.rowMain}>
              <div className={css.rowName}>
                <a className={css.sourceLink} href={'https://github.com/' + entry.repo} target='_blank' rel='noreferrer'>{entry.repo}</a>
              </div>
              <div className={css.rowDesc}>{tt(entry.descriptionKey)}</div>
            </div>
            <button type='button' className={css.opBtn} disabled={busy} onClick={() => { void addSource(entry.repo) }}>{tt('market.add')}</button>
          </div>
        ),
      })
    }
  }
  for (const record of marketState.repos) {
    if (MARKET_CATALOG.some((entry) => entry.repo === record.repo)) continue
    rows.push({ key: record.repo, element: <MarketSourceRow hub={hub} record={record} installedNames={installedNames} /> })
  }
  const unaddedCatalog = MARKET_CATALOG.filter((entry) => !marketState.repos.some((record) => record.repo === entry.repo))

  return (
    <>
      {/* skills.sh 搜索：放在市场列表**上方** —— 它是「发现」的入口，用户先找到
          想要的技能，再去下面管理已添加的源。可收起，收起后只剩标题行。 */}
      <section className={css.section}>
        <div className={css.sectionTitle + ' ' + css.sectionHeadRow}>
          <button
            type='button'
            className={css.disclosure}
            aria-expanded={skillsShOpen}
            onClick={() => { setSkillsShOpen((open) => !open) }}
          >
            <span className={css.chevron + (skillsShOpen ? '' : ' ' + css.chevronCollapsed)} />
            <span className={css.sectionTitleFill}>{tt('market.skillsShTitle')}</span>
          </button>
        </div>
            <div className={css.buttons + ' ' + css.actionsPadded}>
              {/* 排序放在搜索框前面：它决定「搜完看到什么」，先选口径再搜更顺。 */}
              <select
                className={css.select}
                value={skillsShSort}
                onChange={(event) => { setSkillsShSort(event.target.value as 'installs' | 'az') }}
                title={tt('market.skillsShSortHint')}
              >
                <option value='installs'>{tt('market.skillsShSortInstalls')}</option>
                <option value='az'>{tt('market.skillsShSortAz')}</option>
              </select>
              <input
                className={css.input + ' ' + css.grow}
                value={skillsShQuery}
                onChange={(event) => { setSkillsShQuery(event.target.value) }}
                onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void runSkillsShSearch() } }}
                placeholder={tt('market.skillsShPlaceholder')}
              />
              <button
                type='button'
                className={css.button}
                disabled={skillsShQuery.trim().length < 2 || skillsShState.status === 'loading'}
                onClick={() => { void runSkillsShSearch() }}
              >
                {skillsShState.status === 'loading' ? tt('market.skillsShSearching') : tt('market.skillsShSearch')}
              </button>
            </div>
            <p className={css.hintLine + ' ' + css.hintPadded}>{tt('market.skillsShHint')}</p>
        {skillsShOpen ? (
          <>
              {skillsShState.status === 'error' ? (
                <p className={css.hintLine + ' ' + css.hintPadded + ' ' + css.formErrorText}>{skillsShState.message}</p>
              ) : null}
              {skillsShState.status === 'ready' && skillsShState.skills.length === 0 ? <div className={css.empty}>{tt('market.skillsShEmpty')}</div> : null}
              {skillsShState.status === 'ready' && skillsShState.skills.length > 0 && skillsShSort === 'installs' ? (
                <p className={css.hintLine + ' ' + css.hintPadded}>{tt('market.skillsShTopNote', { count: SKILLS_SH_TOP_N })}</p>
              ) : null}
              {sortedSkillsSh.map((entry) => {
                const key = entry.source + '/' + entry.skillId
                const detail = skillsShDetail.get(key)
                const detailOpen = skillsShDetailOpen === key
                return (
                  <div key={entry.id} className={css.row + ' ' + css.rowStatic}>
                    <div className={css.rowMain}>
                      <div className={css.rowName}>
                        <a className={css.sourceLink} href={'https://github.com/' + entry.source} target='_blank' rel='noreferrer'>{entry.name}</a>
                        {entry.installs !== undefined ? <span className={css.statusBadge}>{tt('market.skillsShInstalls', { count: entry.installs.toLocaleString() })}</span> : null}
                      </div>
                      <div className={css.rowDesc}>{entry.source} · {entry.skillId}</div>
                      {detailOpen ? (
                        <div className={css.skillDescBox}>
                          {skillsShDetailLoading === key
                            ? tt('market.skillsShDescLoading')
                            : detail !== undefined && detail !== ''
                              ? detail
                              : tt('market.skillsShDescEmpty')}
                        </div>
                      ) : null}
                      {detailOpen && skillsShDetailError !== null && detail === undefined ? (
                        <p className={css.hintLine + ' ' + css.formErrorText}>{skillsShDetailError}</p>
                      ) : null}
                    </div>
                    <span className={css.buttons}>
                      {/* 说明：按需下载技能包读 SKILL.md，所以只在点开时取一次，之后走缓存。 */}
                      <button
                        type='button'
                        className={css.opBtn}
                        title={tt('market.skillsShDesc')}
                        onClick={() => {
                          if (detailOpen) { setSkillsShDetailOpen(null); return }
                          setSkillsShDetailOpen(key)
                          void loadSkillsShDetail(entry.source, entry.skillId)
                        }}
                      >
                        {detailOpen ? tt('market.skillsShDescHide') : tt('market.skillsShDesc')}
                      </button>
                      {/* 只保留「安装」：「添加」与它表达的是同一件事（把这个技能弄进来），
                          两个按钮并排只会让人犹豫。要跟随上游更新可以在下面手动加源。 */}
                      <button
                        type='button'
                        className={css.opBtn}
                        disabled={marketBusy || skillsShInstalling !== null}
                        title={tt('market.skillsShInstall')}
                        onClick={() => { void installSkillsSh(entry.source, entry.skillId) }}
                      >
                        {skillsShInstalling === key
                          ? tt('market.skillsShInstalling')
                          : tt('market.skillsShInstall')}
                      </button>
                    </span>
                  </div>
                )
              })}
          </>
        ) : null}
      </section>

      <section className={css.section}>
        <div className={css.sectionTitle + ' ' + css.sectionHeadRow}>
          <span className={css.sectionTitleFill}>{tt('market.title')}</span>
          <button type='button' className={css.opBtn} disabled={marketBusy} onClick={() => { void checkSources(); void checkMarket() }}>{tt('market.checkAll')}</button>
          <button
            type='button'
            className={css.opBtn + (updatableRepos.length > 0 ? ' ' + css.opDanger : '')}
            disabled={updatableRepos.length === 0 || tagBusy || batchBusy}
            onClick={() => { setUpdateAllDialog(true) }}
          >{tt('market.updateAll')}</button>
        </div>
        <div className={css.buttons + ' ' + css.actionsPadded}>
          <input
            className={css.input + ' ' + css.grow}
            value={newSourceName}
            onChange={(event) => { setNewSourceName(event.target.value) }}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void addMarketSource() } }}
            placeholder={tt('market.addPlaceholder')}
          />
          <button type='button' className={css.button + ' ' + css.primary} disabled={newSourceName.trim() === ''} onClick={() => { void addMarketSource() }}>{tt('market.addSource')}</button>
        </div>
        {marketState.status === 'ready' && unaddedCatalog.length > 0 ? <p className={css.hintLine + ' ' + css.hintPadded}>{tt('market.catalogHint')}</p> : null}

        {marketState.status === 'loading' ? <div className={css.empty}>{tt('panel.loading')}</div> : null}
        {marketState.status === 'error' ? <div className={css.empty}>{tt('market.loadFailed')}</div> : null}
        {marketState.status === 'ready' && rows.length === 0 ? <div className={css.empty}>{tt('market.noSources')}</div> : null}
        {marketState.status === 'ready' ? rows.map((row) => <Fragment key={row.key}>{row.element}</Fragment>) : null}
      </section>
      {/* 扫描结果归属卡片：用同一 section 卡片包裹扫描中/错误/就绪，标题直接点明所属仓库，消除割裂感 */}
      <RepoScanCard hub={hub} />

      {removeMarketDialog !== null ? (
        <ConfirmDialog
          title={tt('market.removeConfirmTitle')}
          text={tt('market.removeConfirmText', { repo: removeMarketDialog })}
          confirmLabel={tt('market.removeConfirm')}
          danger
          onCancel={cancelRemoveMarketSource}
          onConfirm={() => { void confirmRemoveMarketSource() }}
        />
      ) : null}

      {updateAllDialog ? (
        <ConfirmDialog
          title={tt('market.updateAllConfirmTitle')}
          text={tt('market.updateAllConfirmText')}
          items={updatableRepos.map((repo) => {
            const check = sourceCheck[repo]
            if (check !== undefined && check.changed && check.updated.length > 0) {
              return tt('market.updateAllItem', { repo, count: check.updated.length })
            }
            const release = marketCheck[repo]
            return tt('market.updateAllReleaseItem', { repo, version: release?.latestTag ?? tt('market.updated') })
          })}
          confirmLabel={tt('market.updateAll')}
          danger
          onCancel={() => { setUpdateAllDialog(false) }}
          onConfirm={() => { void updateAll() }}
        />
      ) : null}
    </>
  )
}
