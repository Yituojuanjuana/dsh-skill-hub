// @vitest-environment jsdom
/**
 * 回归：**详情分支**必须被错误边界盖住。
 *
 * 上一版的边界只包了列表内容区，而 `SkillHubPanel` 在 `detail !== null` 时
 * 提前 return 一整块 overlay —— 也就是说最脆弱的那条路径（详情）恰好不在
 * 边界内。hook 顺序修好之后它不会再炸，但下一次 `SkillDetailView` 内部抛错
 * 仍然会整块白屏。
 *
 * 这里把 `SkillDetailView` 替换成必抛错的替身，断言：
 *   1. 面板不白屏 —— 错误卡片可见；
 *   2. 卡片上带 `detail:<技能名>` 的 scope 标识；
 *   3. 点「重试」能退回列表（detail === null），列表行仍在。
 *
 * 同时断言遮罩仍在（overlay 在边界外），不会变成一块裸卡片浮在页面外。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CatalogResponse, CatalogSkill, SkillDetail } from '../../protocol.ts'

// 可控开关：只有这个用例把详情替身切成「必抛」。
const state = vi.hoisted(() => ({ shouldThrow: false }))

vi.mock('./SkillDetailView.tsx', () => ({
  SkillDetailView: function SkillDetailView(): never {
    if (state.shouldThrow) throw new Error('boom inside SkillDetailView')
    return null as never
  },
}))

const { SkillHubPanel } = await import('./SkillHubPanel.tsx')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PROJECT = 'E:\\67549\\Desktop\\sports-coach'
const SKILL = 'sports-coach-miniapp-build-verify'

function projectSkill(): CatalogSkill {
  return {
    name: SKILL,
    description: '验证小程序构建',
    invocation: { modelInvocable: true, userInvocable: true },
    provider: 'filesystem',
    writable: false,
    source: 'project-dsh',
    workspace: PROJECT,
    workspaceTitle: 'sports-coach',
  }
}

function catalog(): CatalogResponse {
  return {
    ok: true,
    pluginVersion: '0.5.2-test',
    complete: true,
    skills: [projectSkill()],
    disabled: [],
    diagnostics: [],
    announcement: { skills: 1, chars: 10, approxTokens: 4, descriptionMaxLength: 400, truncated: 0 },
    workspaces: [{ path: PROJECT, title: 'sports-coach' }],
    currentWorkspace: PROJECT,
  }
}

function detail(): SkillDetail {
  return {
    name: SKILL,
    description: '验证小程序构建',
    invocation: { modelInvocable: true, userInvocable: true },
    provider: 'filesystem',
    source: 'project-dsh',
    path: PROJECT + '\\.dsh\\skills\\' + SKILL + '\\SKILL.md',
    content: '# 构建验证',
  }
}

function makeApi(): unknown {
  return {
    catalog: vi.fn(async () => catalog()),
    permanentStats: vi.fn(async () => ({ ok: true, stats: [], skipped: 0, note: '' })),
    groups: vi.fn(async () => ({ ok: true, groups: [] })),
    sources: vi.fn(async () => ({ ok: true, sources: [], trash: [] })),
    config: vi.fn(async () => ({ ok: true, pluginVersion: '0.5.2-test', config: {}, saved: {}, githubTokenSet: false })),
    updateCheck: vi.fn(async () => ({ ok: true, updateAvailable: false })),
    skill: vi.fn(async () => detail()),
  }
}

let root: Root | undefined
let container: HTMLDivElement | undefined

/** 挂载 → 切工作区 → 点那一行，返回容器。 */
async function openDetail(): Promise<HTMLDivElement> {
  const api = makeApi()
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container as HTMLDivElement)
    root.render(<SkillHubPanel api={api as never} mode='sidebar' />)
  })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })

  const tabs = [...(container as HTMLDivElement).querySelectorAll('button[role="tab"]')]
  const workspaceTab = tabs.find((b) => (b.textContent ?? '').includes('工作区'))
  expect(workspaceTab, 'workspace tab must exist').toBeDefined()
  await act(async () => { (workspaceTab as HTMLButtonElement).click() })
  await act(async () => { await Promise.resolve() })

  const buttons = [...(container as HTMLDivElement).querySelectorAll('button')]
  const rowButton = buttons.find((b) => (b.textContent ?? '').includes(SKILL))
  expect(rowButton, 'the project skill row must be rendered').toBeDefined()
  await act(async () => { (rowButton as HTMLButtonElement).click() })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
  return container as HTMLDivElement
}

afterEach(async () => {
  state.shouldThrow = false
  if (root !== undefined) await act(async () => { root?.unmount() })
  container?.remove()
  root = undefined
  container = undefined
  vi.restoreAllMocks()
})

describe('详情分支在错误边界内', () => {
  it('shows an error card with a detail scope instead of a blank panel', async () => {
    state.shouldThrow = true
    const orig = console.error
    console.error = () => {}
    const el = await openDetail()
    console.error = orig

    const markup = el.innerHTML
    // 1. 不白屏：错误卡片在，且带 alert 语义。
    expect(markup).toContain('role="alert"')
    // 2. scope 标识能看出是哪条技能炸的。
    expect(markup).toContain('detail:' + SKILL)
    // 3. 错误摘要是原文，便于排查。
    expect(markup).toContain('boom inside SkillDetailView')
    // 4. 遮罩仍在（边界在 overlay 里面、modal 外面）。
    expect(markup).toContain('aria-modal')
  })

  it('retry exits the broken detail and returns to the list', async () => {
    state.shouldThrow = true
    const orig = console.error
    console.error = () => {}
    const el = await openDetail()
    console.error = orig

    // 重试前：卡片在，列表行被详情盖住（overlay 状态）。
    expect(el.innerHTML).toContain('role="alert"')

    // 点「重试」：语义是退出详情回列表，不是重新加载 catalog 卡在坏详情里。
    const buttons = [...el.querySelectorAll('button')]
    const retry = buttons.find((b) => (b.textContent ?? '').trim() === '重试')
    expect(retry, 'retry button must exist').toBeDefined()
    await act(async () => { (retry as HTMLButtonElement).click() })
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })

    const after = el.innerHTML
    // 详情已关闭（不再有 dialog），回到列表，列表行还在。
    expect(after).not.toContain('aria-modal')
    expect(after).not.toContain('role="alert"')
    expect(after).toContain(SKILL)
    // 标题栏也在（列表视图的根）。
    expect(after).toContain('技能书架')
  })
})
