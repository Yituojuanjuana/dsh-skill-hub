/**
 * 本批改动的行为测试：
 * - 排序权重用 permanent.total（不是会话 count）
 * - 清除筛选按钮已移除
 * - 两页控件顺序：调用方式 → 排序 → 搜索框+按钮
 * - 搜索框草稿式（输入不立即应用，按钮/Enter 才应用）
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sortSkills, usageTotal } from '../grouping.ts'
import type { CatalogSkill } from '../../protocol.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PANEL = readFileSync(join(HERE, 'SkillHubPanel.tsx'), 'utf8')
const WORKSPACE = readFileSync(join(HERE, 'WorkspaceView.tsx'), 'utf8')
const CATALOG = readFileSync(join(HERE, 'hooks', 'useCatalogFlow.ts'), 'utf8')

describe('sort weight is permanent.total', () => {
  it('usageTotal prefers permanent.total over count', () => {
    expect(usageTotal({ count: 1, permanent: { total: 17 } })).toBe(17)
    expect(usageTotal({ count: 9 })).toBe(9)
    expect(usageTotal(undefined)).toBe(0)
  })

  it('sorts by permanent.total even when count disagrees', () => {
    const skills = [
      { name: 'low' },
      { name: 'high' },
      { name: 'mid' },
    ] as CatalogSkill[]
    // count 故意与 permanent.total 反着来。
    const uses = new Map([
      ['low', { count: 99, permanent: { total: 1 } }],
      ['high', { count: 1, permanent: { total: 50 } }],
      ['mid', { count: 50, permanent: { total: 10 } }],
    ])
    const sorted = sortSkills(skills, 'uses', (name) => usageTotal(uses.get(name)))
    expect(sorted.map((s) => s.name)).toEqual(['high', 'mid', 'low'])
  })

  it('both pages call usageTotal for the sort weight', () => {
    expect(CATALOG).toContain('usageTotal(uses.get(name))')
    expect(WORKSPACE).toContain('usageTotal(hub.uses.get(name))')
    expect(CATALOG).not.toContain('uses.get(name)?.count')
    expect(WORKSPACE).not.toContain('hub.uses.get(name)?.count')
  })
})

describe('clear-filter button removed', () => {
  it('no filter.clear button or activeFilterCount in the panel', () => {
    expect(PANEL).not.toContain('filter.clear')
    expect(PANEL).not.toContain('activeFilterCount')
  })
})

describe('control order on both pages', () => {
  it('general: category → status → invocation → sort → search', () => {
    const bar = PANEL.slice(PANEL.indexOf('className={css.filterBar}'), PANEL.indexOf("generalView === 'all'"))
    const order = ['view.category', 'filter.status', 'filter.invocation', 'sort.label', 'FilterSearch']
    const pos = order.map((t) => bar.indexOf(t))
    for (const p of pos) expect(p).toBeGreaterThan(-1)
    for (let i = 1; i < pos.length; i += 1) expect(pos[i]!).toBeGreaterThan(pos[i - 1]!)
  })

  it('workspace: project → status → invocation → sort → search', () => {
    const bar = WORKSPACE.slice(WORKSPACE.indexOf('css.workspaceBar'), WORKSPACE.indexOf('projectSkills.length === 0'))
    const order = ['workspaceSelectStrong', 'workspaceStatusSelect', 'filter.invocation', 'sort.label', 'FilterSearch']
    const pos = order.map((t) => bar.indexOf(t))
    for (const p of pos) expect(p).toBeGreaterThan(-1)
    for (let i = 1; i < pos.length; i += 1) expect(pos[i]!).toBeGreaterThan(pos[i - 1]!)
  })
})

describe('shared search component with draft', () => {
  const SEARCH = readFileSync(join(HERE, 'FilterSearch.tsx'), 'utf8')

  it('is used on both pages', () => {
    expect(PANEL).toContain('<FilterSearch')
    expect(WORKSPACE).toContain('<FilterSearch')
  })

  it('holds a draft and only applies on button or Enter', () => {
    expect(SEARCH).toContain('useState(value)')
    expect(SEARCH).toContain("onApply(draft.trim())")
    expect(SEARCH).toContain("event.key === 'Enter'")
    expect(SEARCH).toContain('onClick={apply}')
  })

  it('syncs draft when the applied value changes externally', () => {
    expect(SEARCH).toContain('useEffect(() => { setDraft(value) }, [value])')
  })
})

describe('both pages share rowProps for usage display', () => {
  it('workspace rows get permanentUses and hubConfig', () => {
    const block = WORKSPACE.slice(WORKSPACE.indexOf('const rowProps'), WORKSPACE.indexOf('const rowProps') + 400)
    expect(block).toContain('permanentUses: hub.permanentUses')
    expect(block).toContain('hubConfig: hub.hubConfig')
  })

  it('general flat rows get the same fields', () => {
    const block = PANEL.slice(PANEL.indexOf('const generalRowProps'), PANEL.indexOf('const generalRowProps') + 400)
    expect(block).toContain('permanentUses: hub.permanentUses')
    expect(block).toContain('hubConfig: hub.hubConfig')
  })
})
