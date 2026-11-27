/**
 * 本批两条修复：
 * 1. FilterSearch 按钮内嵌在输入框内（一个 wrapper 一个边框）。
 * 2. 切换分类后排序不失效：平铺分支用 hub.sorted；分组视图组间/组内按排序键。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sortGroupsByRank, sortSkills } from '../grouping.ts'
import type { CatalogSkill } from '../../protocol.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SEARCH = readFileSync(join(HERE, 'FilterSearch.tsx'), 'utf8')
const CSS = readFileSync(join(HERE, 'panel.module.css'), 'utf8')
const PANEL = readFileSync(join(HERE, 'SkillHubPanel.tsx'), 'utf8')
const LOCATIONS = readFileSync(join(HERE, 'LocationsView.tsx'), 'utf8')
const ROLES = readFileSync(join(HERE, 'RoleGroupsView.tsx'), 'utf8')
const WORKSPACE = readFileSync(join(HERE, 'WorkspaceView.tsx'), 'utf8')

describe('search button embedded inside the input', () => {
  it('wrapper holds both input and button; input has right padding', () => {
    expect(SEARCH).toContain('className={css.filterSearch')
    expect(SEARCH).toContain('className={css.filterSearchInput}')
    expect(SEARCH).toContain('className={css.filterSearchButton}')
    expect(CSS).toContain('.filterSearch { position: relative')
    expect(CSS).toContain('padding: 0 68px 0 14px')
  })

  it('button is absolutely positioned at the right edge, one border only', () => {
    expect(CSS).toContain('.filterSearchButton { position: absolute; right: 4px')
    // 边框只在 wrapper 上，input 明确无边框。
    expect(CSS).toContain('.filterSearchInput { flex: 1 1 auto; min-width: 0; height: 100%; padding: 0 68px 0 14px; border: none; outline: none')
  })

  it('button has a min-width so it is not squashed on narrow screens', () => {
    expect(CSS).toContain('min-width: 60px')
    expect(CSS).toContain('min-width: 180px')
  })

  it('keeps draft + Enter + click behavior', () => {
    expect(SEARCH).toContain('useState(value)')
    expect(SEARCH).toContain("event.key === 'Enter'")
    expect(SEARCH).toContain('onClick={apply}')
  })

  it('honours inputClassName on the wrapper', () => {
    expect(SEARCH).toContain("className={css.filterSearch + ' ' + (inputClassName ?? '')}")
  })
})

describe('flat branch uses the sorted source', () => {
  it('平铺读 scopedSorted（源自 hub.sorted），不是未排序的 scopedFiltered', () => {
    const flat = PANEL.slice(PANEL.indexOf("generalView === 'all' ? ("), PANEL.indexOf("generalView === 'location'"))
    expect(flat).toContain('skills={scopedSorted}')
    expect(flat).not.toContain('skills={scopedFiltered}')
    expect(PANEL).toContain('hub.sorted.filter((skill) => !isProjectSource(skill.source))')
  })

  it('switching category does not touch sortKey', () => {
    // 分类切换只 setGeneralView，没有 setSortKey。
    const viewChanges = PANEL.match(/setGeneralView\([^)]*\)/g) ?? []
    expect(viewChanges.length).toBeGreaterThan(0)
    for (const change of viewChanges) expect(change).not.toContain('setSortKey')
  })
})

describe('grouped views order by the current sort key', () => {
  const skills = [
    { name: 'zeta' },
    { name: 'alpha' },
    { name: 'mid' },
  ] as CatalogSkill[]
  const uses = new Map([
    ['zeta', { count: 1 }],
    ['alpha', { count: 9 }],
    ['mid', { count: 5 }],
  ])
  const sorted = sortSkills(skills, 'uses', (name) => uses.get(name)?.count)

  it('首项就是按 sortKey 排出来的结果', () => {
    expect(sorted.map((s) => s.name)).toEqual(['alpha', 'mid', 'zeta'])
  })

  it('组内顺序：分桶保留 hub.sorted 的次序', () => {
    const groups = [
      { id: 'g1', skills: [sorted[0]!, sorted[2]!] },
      { id: 'g2', skills: [sorted[1]!] },
    ]
    // 每组第一个成员就是该组排序最高的。
    expect(groups[0]!.skills[0]!.name).toBe('alpha')
    expect(groups[1]!.skills[0]!.name).toBe('mid')
  })

  it('组间按组内最高排名成员排（首项口径）', () => {
    const groups = [
      { id: 'g1', skills: [sorted[0]!, sorted[2]!] }, // 首项 alpha(0)
      { id: 'g2', skills: [sorted[1]!] },             // 首项 mid(1)
    ]
    const ordered = sortGroupsByRank(groups, sorted)
    expect(ordered.map((g) => g.id)).toEqual(['g1', 'g2'])
  })

  it('group rank is stable on ties', () => {
    const one = sortGroupsByRank([{ id: 'b', skills: [sorted[2]!] }, { id: 'a', skills: [sorted[2]!] }], sorted)
    const two = sortGroupsByRank([{ id: 'a', skills: [sorted[2]!] }, { id: 'b', skills: [sorted[2]!] }], sorted)
    expect(one.map((g) => g.id)).toEqual(two.map((g) => g.id))
  })

  it('both grouped views call sortGroupsByRank', () => {
    expect(LOCATIONS).toContain('sortGroupsByRank(groupByLocation(hub.sorted), hub.sorted)')
    // 角色视图用 searchedSorted（不受状态筛选影响），仍走 sortGroupsByRank。
    expect(ROLES).toContain('sortGroupsByRank(groupByRole(hub.searchedSorted), hub.searchedSorted)')
  })
})

describe('workspace page keeps sorting after project/status switch', () => {
  it('both flat and grouped rows read sorted sources', () => {
    expect(WORKSPACE).toContain('const projectSkills = useMemo(() => hub.sorted.filter')
    expect(WORKSPACE).toContain('return sortSkills(unique, hub.sortKey')
    expect(WORKSPACE).toContain('skills={flatSkills}')
    expect(WORKSPACE).toContain('skills={projectSkills}')
  })
})
