/**
 * 筛选行末尾的搜索框 + 搜索按钮。
 *
 * 交互：输入框只改草稿值，点「搜索」或按 Enter 才把草稿应用到 hub.search。
 * 这样连续输入不会每敲一个字就重排整个列表；清空输入再点按钮 → 恢复全量。
 *
 * 通用页与工作区页**共用这一个组件**，保证两页的搜索行为与样式完全一致。
 */

import { useEffect, useState, type JSX } from 'react'
import { tt } from '../helpers.ts'
import css from './panel.module.css'

export interface FilterSearchProps {
  /** 当前已应用的搜索值。 */
  value: string
  /** 应用搜索值。 */
  onApply: (value: string) => void
  /** 额外的输入框类名（工作区页用于占满剩余宽度）。 */
  inputClassName?: string
  /** 搜索框占位文案的 key。 */
  placeholderKey?: 'panel.search' | 'panel.searchDetail'
}

export function FilterSearch(props: FilterSearchProps): JSX.Element {
  const { value, onApply, inputClassName, placeholderKey = 'panel.search' } = props
  // 草稿值：输入只改它，不直接改已应用的搜索。
  const [draft, setDraft] = useState(value)
  // 外部值变化（例如别处清空了筛选）时同步草稿，避免按钮状态与列表脱节。
  useEffect(() => { setDraft(value) }, [value])

  const apply = (): void => { onApply(draft.trim()) }

  return (
    // 输入框与按钮同处一个 wrapper，共用**一个边框**：边框放在 wrapper 上，
    // 内部 input 去掉自己的边框/背景，按钮绝对定位在右侧内嵌。
    // 宽度与高度全部由 wrapper 决定，input 只留 padding-right 给按钮让位。
    <span className={css.filterSearch + ' ' + (inputClassName ?? '')}>
      <input
        className={css.filterSearchInput}
        value={draft}
        placeholder={tt(placeholderKey)}
        aria-label={tt('panel.search')}
        onChange={(event) => { setDraft(event.target.value) }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); apply() }
        }}
      />
      <button
        type='button'
        className={css.filterSearchButton}
        onClick={apply}
        aria-label={tt('panel.searchAction')}
        title={tt('panel.searchAction')}
      >{tt('panel.searchAction')}</button>
    </span>
  )
}
