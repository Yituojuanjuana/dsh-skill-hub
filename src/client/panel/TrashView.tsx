/**
 * Trash tab: restorable skills that were removed locally or followed an
 * upstream deletion. Kept separate from the general list so recoverable
 * content never mixes with active skills.
 *
 * 每条支持点开看「技能说明 + 原路径」：说明来自移入回收站时的 description
 * 快照；老数据没有这个字段时显示「该技能没有写描述」，不渲染空白。
 * 展开区与详情一样进 PanelBoundary —— 展开分支里出错不能把整个 tab 打白。
 */

import { useState, type JSX } from 'react'
import { tt } from '../helpers.ts'
import { relativeTimeText } from './format.ts'
import { GroupHeader } from './GroupHeader.tsx'
import { GroupSection } from './GroupSection.tsx'
import { PanelBoundary } from './PanelErrorBoundary.tsx'
import type { SkillHubState } from './useSkillHub.ts'
import type { TrashEntry } from '../../protocol.ts'
import css from './panel.module.css'

/**
 * 单行回收站条目。useState 放在组件最顶部 —— 早于任何 return，
 * 避免「Rendered fewer hooks than expected」那类白屏。
 */
function TrashRow(props: { entry: TrashEntry; hub: SkillHubState }): JSX.Element {
  const { entry, hub } = props
  const [open, setOpen] = useState(false)

  return (
    <div className={css.row + ' ' + css.rowStatic}>
      <button
        type='button'
        className={css.rowMainButton}
        aria-expanded={open}
        onClick={() => { setOpen((value) => !value) }}
      >
        <span className={css.rowName}>{entry.name}</span>
        <span className={css.rowDesc}>{relativeTimeText(entry.movedAt)}</span>
        <span className={css.trashChevron}>{open ? '▾' : '▸'}</span>
      </button>
      <button type='button' className={css.opBtn} disabled={hub.tagBusy} onClick={() => { void hub.restoreTrash(entry.name) }}>{tt('source.restore')}</button>
      {open ? (
        <PanelBoundary scope={'trash:' + entry.name} onRetry={() => { setOpen(false); void hub.reloadCatalog() }}>
          <div className={css.trashDetail}>
            <div className={css.trashDetailLine}>
              <strong>{tt('trash.description')}：</strong>
              {entry.description !== undefined && entry.description.trim() !== ''
                ? entry.description
                : tt('trash.noDescription')}
            </div>
            {entry.sourcePath !== undefined && entry.sourcePath !== '' ? (
              <div className={css.trashDetailLine}>
                <strong>{tt('trash.originalPath')}：</strong>
                <code>{entry.sourcePath}</code>
              </div>
            ) : null}
          </div>
        </PanelBoundary>
      ) : null}
    </div>
  )
}

export function TrashView(props: { hub: SkillHubState }): JSX.Element {
  const { hub } = props
  const entries = hub.sourcesState?.trash ?? []
  if (entries.length === 0) {
    return <div className={css.empty}>{tt('source.trashEmpty')}</div>
  }
  return (
    <GroupSection>
      <GroupHeader
        title={tt('source.trash')}
        actions={(
          <button type='button' className={css.opBtn + ' ' + css.opDanger} disabled={hub.tagBusy} onClick={() => { hub.setConfirmClearTrash(true) }}>
            {tt('source.clearTrash')}
          </button>
        )}
      />
      {entries.map((entry) => <TrashRow key={entry.name} entry={entry} hub={hub} />)}
    </GroupSection>
  )
}
