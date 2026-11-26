/**
 * 筛选条：工作区页只渲染一份、通用页默认值与控件顺序。
 *
 * 真实问题：
 * 1. 工作区页有两个 `filterBar` —— 面板级那个只清空了内部控件、外层容器还在，
 *    于是「空的一行 + 页内真控件」两份卡片叠在一起。
 * 2. 通用页的状态/排序/调用方式藏在「筛选」按钮后面的折叠面板里，不点开看不到。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 测试文件自身所在目录，避免依赖 process.cwd()（vitest 的 cwd 是 workspace 根）。
const HERE = dirname(fileURLToPath(import.meta.url))

const PANEL = readFileSync(join(HERE, 'SkillHubPanel.tsx'), 'utf8')
const WORKSPACE = readFileSync(join(HERE, 'WorkspaceView.tsx'), 'utf8')
const CATALOG = readFileSync(join(HERE, 'hooks', 'useCatalogFlow.ts'), 'utf8')
const HUB = readFileSync(join(HERE, 'useSkillHub.ts'), 'utf8')

describe('workspace page renders exactly one filter bar', () => {
  it('the panel-level filter bar is gated on the workspace tab', () => {
    // 条件必须在容器上，而不是只排除容器内部控件。
    expect(PANEL).toContain("tab === 'workspace' ? null : (")
    // 该 null 分支后面紧跟的就是 filterBar 容器。
    const idx = PANEL.indexOf("tab === 'workspace' ? null : (")
    expect(idx).toBeGreaterThan(-1)
    const after = PANEL.slice(idx, idx + 200)
    expect(after).toContain('css.filterBar')
  })

  it('the panel no longer renders a second bar for the workspace tab', () => {
    // 以前是容器常驻 + 内部 `{tab === 'workspace' ? null : ...}`，会出现空卡片。
    // 只统计真正的 JSX 标签行（注释里提到这个类名不算）。
    const jsxBars = PANEL.split('\n').filter((line) => {
      const trimmed = line.trim()
      return trimmed.startsWith('<div') && trimmed.includes('className={css.filterBar}')
    })
    expect(jsxBars).toHaveLength(1)
  })

  it('WorkspaceView owns its own single bar', () => {
    const own = (WORKSPACE.match(/css\.filterBar/g) ?? []).length
    expect(own).toBe(1)
  })
})

describe('workspace filter bar has the five controls in order', () => {
  it('orders: project dropdown → status → invocation → search', () => {
    const order = [
      'workspaceSelectStrong',   // 1 项目/工作区
      'workspaceStatusSelect',   // 2 状态
      'filterInline',            // 3 调用方式
      'workspaceSearch',         // 4 搜索
    ]
    const positions = order.map((cls) => WORKSPACE.indexOf('css.' + cls))
    for (const pos of positions) expect(pos).toBeGreaterThan(-1)
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i]!).toBeGreaterThan(positions[i - 1]!)
    }
  })
})

describe('general page defaults', () => {
  it('category defaults to by-location', () => {
    // generalView 的初始值必须是 'location'（定义在 useSkillHub）。
    expect(HUB).toMatch(/useState<GeneralView>\('location'\)/)
  })

  it('status defaults to enabled', () => {
    expect(CATALOG).toMatch(/useState<SkillStatusFilter>\('enabled'\)/)
  })

  it('sort defaults to uses (by call count)', () => {
    expect(CATALOG).toMatch(/useState<SortKey>\('uses'\)/)
  })
})

describe('category segmented control has exactly three options', () => {
  it('is a select, not segmented buttons', () => {
    // 分类已改为下拉；分段按钮的类名不应再出现在面板里。
    expect(PANEL).not.toContain('css.segmented')
    expect(PANEL).not.toContain('css.segBtn')
    // 但必须仍有 aria-label。
    expect(PANEL).toContain("aria-label={tt('view.category')}")
  })

  it('offers all / location / scene in that order', () => {
    const all = PANEL.indexOf("<option value='all'>{tt('view.allCategories')}")
    const location = PANEL.indexOf("<option value='location'>{tt('view.byLocation')}")
    const scene = PANEL.indexOf("<option value='scene'>{tt('view.byRole')}")
    for (const pos of [all, location, scene]) expect(pos).toBeGreaterThan(-1)
    expect(location).toBeGreaterThan(all)
    expect(scene).toBeGreaterThan(location)
  })

  it('defaults to location', () => {
    expect(HUB).toMatch(/useState<GeneralView>\('location'\)/)
  })

  it('no longer offers 按用量 as a category', () => {
    expect(PANEL).not.toContain("setGeneralView('usage')")
  })
})

describe('search input is the last control on the bar', () => {
  it('general page: FilterSearch comes after every select', () => {
    const bar = PANEL.slice(PANEL.indexOf('className={css.filterBar}'), PANEL.indexOf("generalView === 'all'"))
    const search = bar.indexOf('<FilterSearch')
    expect(search).toBeGreaterThan(-1)
    for (const cls of ['view.category', 'filter.status', 'sort.label', 'filter.invocation']) {
      const pos = bar.indexOf(cls)
      if (pos >= 0) expect(search).toBeGreaterThan(pos)
    }
  })

  it('workspace page: search comes after the sort and invocation selects', () => {
    const bar = WORKSPACE.slice(WORKSPACE.indexOf('css.workspaceBar'), WORKSPACE.indexOf('projectSkills.length === 0'))
    const search = bar.indexOf('<FilterSearch')
    expect(search).toBeGreaterThan(-1)
    expect(search).toBeGreaterThan(bar.indexOf('workspaceSelectStrong'))
    expect(search).toBeGreaterThan(bar.indexOf('workspaceStatusSelect'))
    expect(search).toBeGreaterThan(bar.indexOf('sort.label'))
    expect(search).toBeGreaterThan(bar.indexOf('filter.invocation'))
  })
})

describe('workspace page has five controls including sort', () => {
  it('orders: project → status → invocation → sort → search', () => {
    const bar = WORKSPACE.slice(WORKSPACE.indexOf('css.workspaceBar'), WORKSPACE.indexOf('projectSkills.length === 0'))
    const order = ['workspaceSelectStrong', 'workspaceStatusSelect', 'filter.invocation', 'sort.label', 'FilterSearch']
    const positions = order.map((token) => bar.indexOf(token))
    for (const pos of positions) expect(pos).toBeGreaterThan(-1)
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i]!).toBeGreaterThan(positions[i - 1]!)
    }
  })

  it('reuses the shared sortKey, not a local sort state', () => {
    // 关键：工作区页必须读 hub.sortKey / hub.setSortKey。
    expect(WORKSPACE).toContain('hub.sortKey')
    expect(WORKSPACE).toContain('hub.setSortKey')
    // 并且调用共享的 sortSkills，而不是本地 localeCompare。
    expect(WORKSPACE).toContain('sortSkills(')
    expect(WORKSPACE).not.toContain('localeCompare')
  })

  it('sort defaults to uses', () => {
    expect(CATALOG).toMatch(/useState<SortKey>\('uses'\)/)
  })
})

describe('general page sort option order', () => {
  it('is uses → added → name', () => {
    const uses = PANEL.indexOf("<option value='uses'>{tt('sort.uses')}")
    const added = PANEL.indexOf("<option value='added'>{tt('sort.added')}")
    const name = PANEL.indexOf("<option value='name'>{tt('sort.name')}")
    for (const pos of [uses, added, name]) expect(pos).toBeGreaterThan(-1)
    expect(added).toBeGreaterThan(uses)
    expect(name).toBeGreaterThan(added)
  })
})

describe('全部分类 renders a flat list with no group headers', () => {
  it('routes generalView=all to SkillRows inside the flat container', () => {
    // 找渲染分支（带 workspaceFlatList 的那个），不是分段按钮里的判断。
    const idx = PANEL.indexOf('workspaceFlatList')
    expect(idx).toBeGreaterThan(-1)
    const before = PANEL.slice(Math.max(0, idx - 400), idx + 200)
    expect(before).toContain("generalView === 'all'")
    expect(before).toContain('SkillRows')
  })

  it('does not render any GroupHeader / ProjectTree in that branch', () => {
    const start = PANEL.indexOf('workspaceFlatList')
    const end = PANEL.indexOf("generalView === 'location'", start)
    expect(end).toBeGreaterThan(start)
    const branch = PANEL.slice(start, end)
    expect(branch).not.toContain('GroupHeader')
    expect(branch).not.toContain('ProjectTree')
  })
})

describe('the old "filter" toggle button is gone', () => {
  it('no filter button and no collapsed panel remain', () => {
    expect(PANEL).not.toContain('css.filterButton')
    expect(PANEL).not.toContain('skill-hub-filter-panel')
    expect(PANEL).not.toContain('filtersOpen')
  })

  it('the dropdowns sit inline on the bar instead', () => {
    // 分类 / 状态 / 排序 / 调用方式 各有一个 filterInline 下拉。
    const inline = (PANEL.match(/css\.filterInline/g) ?? []).length
    expect(inline).toBe(4)
  })
})

describe('invocation filter maps to an existing field', () => {
  it('uses hub.invocationFilter with all/model/user', () => {
    expect(PANEL).toContain('hub.invocationFilter')
    expect(PANEL).toContain("'model'")
    expect(PANEL).toContain("'user'")
    expect(WORKSPACE).toContain('hub.setInvocationFilter')
  })
})
