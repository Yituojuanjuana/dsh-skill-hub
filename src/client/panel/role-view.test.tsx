// @vitest-environment jsdom
/**
 * 角色视图与状态筛选的关系（0.6.3 起：显示且生效）。
 *
 * 历史教训：0.6.2 让角色视图忽略状态筛选，结果用户在「按目录」把状态设为
 * 「已启用/已停用」再切回来时分组变空集、而状态下拉又被隐藏，无法自救。
 * 现在角色视图与其它视图同源（读 hub.sorted，含状态过滤），并且：
 *  - 状态筛选为空集时给可操作空态 + 「清除筛选」按钮；
 *  - 点清除后立刻恢复全量分组。
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CatalogSkill } from '../../protocol.ts'
import { RoleGroupsView } from './RoleGroupsView.tsx'
import type { SkillHubState } from './useSkillHub.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function skill(name: string, description: string, disabled = false): CatalogSkill {
  return {
    name, description, invocation: { modelInvocable: true, userInvocable: true },
    provider: 'filesystem', writable: false, source: 'user-dsh',
    ...(disabled ? { modelOverride: true } : {}),
  }
}

const allSkills = [
  skill('docx-writer', 'office 文档写作'),
  skill('figma-to-css', '设计稿转 CSS 界面'),
  skill('tdd-runner', '测试驱动开发'),
  skill('mystery', '没有明显角色关键词'),
]

/**
 * 构造 hub。`sorted` 是**带状态过滤**后的行源（角色视图现在读它），
 * `searchedSorted` 不含状态过滤。两者按真实 hook 的语义分别给值。
 */
function makeHub(options: { statusFilter: 'all' | 'enabled' | 'disabled'; onClear?: () => void }): SkillHubState {
  const { statusFilter } = options
  const enabledOnly = allSkills.filter((s) => s.modelOverride !== true)
  const disabledOnly = allSkills.filter((s) => s.modelOverride === true)
  const sorted = statusFilter === 'disabled' ? disabledOnly : statusFilter === 'enabled' ? enabledOnly : allSkills
  return {
    catalog: {
      ok: true, pluginVersion: 'x', complete: true, skills: allSkills, disabled: [], diagnostics: [],
      announcement: { skills: allSkills.length, chars: 0, approxTokens: 0, descriptionMaxLength: 400, truncated: 0 },
      workspaces: [], currentWorkspace: '',
    },
    sorted,
    searchedSorted: allSkills,
    statusFilter,
    expandedGroups: new Set<string>(['role:doc', 'role:design', 'role:dev', 'role:other']),
    viewNames: new Set(allSkills.map((s) => s.name)),
    actionNames: new Set<string>(),
    batchBusy: false, busyNames: new Set<string>(), tagBusy: false, editMode: false,
    uses: new Map(), permanentUses: new Map(), hubConfig: null,
    duplicateNames: new Set<string>(),
    setInvocation: async () => true,
    toggleGroupExpanded: () => {},
    batchToggleNames: async () => {},
    clearListFilters: options.onClear ?? (() => {}),
  } as unknown as SkillHubState
}

let root: Root | undefined
let container: HTMLDivElement
afterEach(() => { act(() => root?.unmount()); container?.remove() })

async function render(hub: SkillHubState): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(createElement(RoleGroupsView, { hub })) })
  return container
}

describe('RoleGroupsView 与状态筛选', () => {
  it('状态=已停用且没有停用技能 → 渲染空态文案与「清除筛选」按钮', async () => {
    const el = await render(makeHub({ statusFilter: 'disabled' }))
    expect(el.textContent).toContain('当前筛选下没有技能')
    const clear = [...el.querySelectorAll('button')].find((b) => b.textContent === '清除筛选')
    expect(clear).toBeDefined()
    // 没有分组标题
    expect(el.textContent).not.toContain('文档与写作 ·')
  })

  it('点「清除筛选」调用 clearListFilters', async () => {
    const onClear = vi.fn()
    const el = await render(makeHub({ statusFilter: 'disabled', onClear }))
    const clear = [...el.querySelectorAll('button')].find((b) => b.textContent === '清除筛选')!
    await act(async () => { clear.click() })
    expect(onClear).toHaveBeenCalledOnce()
  })

  it('状态=全部 → 4 个角色分组各带成员数', async () => {
    const el = await render(makeHub({ statusFilter: 'all' }))
    expect(el.textContent).toContain('文档与写作 · 1')
    expect(el.textContent).toContain('设计与界面 · 1')
    expect(el.textContent).toContain('开发与工程 · 1')
    expect(el.textContent).toContain('其他 · 1')
  })

  it('状态=已停用且只有部分技能停用 → 分组只含停用技能', async () => {
    const hub = makeHub({ statusFilter: 'disabled' })
    // 让其中一条停用，并把带状态过滤的行源收窄到那一条。
    const paused = { ...allSkills[0], modelOverride: true as const }
    hub.catalog = { ...hub.catalog!, skills: [paused, ...allSkills.slice(1)] }
    hub.sorted = [paused]
    const el = await render(hub)
    expect(el.textContent).toContain('文档与写作 · 1')
    expect(el.textContent).not.toContain('设计与界面 ·')
  })
})
