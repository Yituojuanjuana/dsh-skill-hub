// @vitest-environment jsdom
/**
 * 回归：角色视图不受状态筛选影响。
 *
 * 现场：用户在「按目录」把状态设为「已启用」，切到「按角色」后整块空白 ——
 * RoleGroupsView 误读 hub.sorted（带状态过滤）而非 searchedSorted。
 * 本测试构造带 statusFilter='enabled' 的 hub，断言仍渲染出角色分组与条目。
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { CatalogSkill } from '../../protocol.ts'
import { RoleGroupsView } from './RoleGroupsView.tsx'
import type { SkillHubState } from './useSkillHub.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function skill(name: string, description: string): CatalogSkill {
  return {
    name, description, invocation: { modelInvocable: true, userInvocable: true },
    provider: 'filesystem', writable: false, source: 'user-dsh',
  }
}

const skills = [
  skill('docx-writer', 'office 文档写作'),
  skill('figma-to-css', '设计稿转 CSS 界面'),
  skill('tdd-runner', '测试驱动开发'),
  skill('mystery', '没有明显角色关键词'),
]

function makeHub(statusFilter: 'all' | 'enabled' | 'disabled'): SkillHubState {
  const searchedSorted = skills
  const sorted = statusFilter === 'disabled' ? [] : searchedSorted
  return {
    catalog: { ok: true, pluginVersion: 'x', complete: true, skills, disabled: [], diagnostics: [],
      announcement: { skills: skills.length, chars: 0, approxTokens: 0, descriptionMaxLength: 400, truncated: 0 },
      workspaces: [], currentWorkspace: '' },
    searchedSorted, sorted,
    statusFilter,
    expandedGroups: new Set<string>(['role:doc', 'role:design', 'role:dev', 'role:other']),
    viewNames: new Set(skills.map((s) => s.name)),
    actionNames: new Set<string>(),
    batchBusy: false, busyNames: new Set<string>(), tagBusy: false, editMode: false,
    uses: new Map(), permanentUses: new Map(), hubConfig: null,
    duplicateNames: new Set<string>(),
    setInvocation: async () => true,
    toggleGroupExpanded: () => {},
    batchToggleNames: async () => {},
  } as unknown as SkillHubState
}

let root: Root | undefined
let container: HTMLDivElement
afterEach(() => { act(() => root?.unmount()); container?.remove() })

describe('RoleGroupsView 不受状态筛选影响', () => {
  it('statusFilter=disabled（sorted 为空）仍渲染全部角色分组与条目', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => { root!.render(createElement(RoleGroupsView, { hub: makeHub('disabled') })) })
    const html = container.innerHTML
    expect(html).not.toContain('没有匹配的技能')
    // 4 个角色都有条目（docx 在这里归入文档与写作，由分类器决定）。
    // 4 个角色分组都有标题与成员数（核心修复：分组不再是空集）。
    expect(html).toContain('文档与写作 · 1')
    expect(html).toContain('设计与界面 · 1')
    expect(html).toContain('开发与工程 · 1')
    expect(html).toContain('其他 · 1')
  })

  it('搜索/调用方式过滤仍生效（searchedSorted 是唯一行源）', () => {
    const hub = makeHub('all')
    expect(hub.searchedSorted).toHaveLength(skills.length)
  })
})
