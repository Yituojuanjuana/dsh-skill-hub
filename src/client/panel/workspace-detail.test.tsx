// @vitest-environment jsdom
/**
 * 回归：工作区页点技能进入详情时，面板不得整块白屏。
 *
 * 真实故障与真实堆栈（诊断时抓到的原文）：
 *
 *   Error: Rendered fewer hooks than expected. This may be caused by an
 *   accidental early return statement.
 *       at renderWithHooks (react-dom.development.js:15562)
 *       at updateFunctionComponent (19617)
 *       at beginWork (19617)
 *   The above error occurred in the <SkillHubPanel> component:
 *       at SkillHubPanel (SkillHubPanel.tsx:45:60)
 *
 * 根因：`SkillHubPanel` 在 `detail !== null` 时提前 return 整个详情弹窗，而
 * 一个 `useMemo`（`scopedSorted`）被放在了那个 early return **之后**。首屏
 * `detail === null` 执行 N 个 hook，点开详情只执行 N-1 个 → React 抛错 →
 * 整棵子树卸载 → 用户看到的就是「面板整块白掉，连标题栏都没了」。
 *
 * 这三条测试分别钉住：正常详情渲染、详情请求失败时的降级、以及错误边界的兜底。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CatalogResponse, CatalogSkill, SkillDetail } from '../../protocol.ts'
import { SkillHubPanel } from './SkillHubPanel.tsx'
import { PanelErrorBoundary } from './PanelErrorBoundary.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PROJECT = 'E:\\67549\\Desktop\\sports-coach'
const SKILL = 'sports-coach-miniapp-build-verify'

/** 一条真实形状的项目级技能（source=project-dsh，带 workspace）。 */
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
    pluginVersion: '0.5.1-test',
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
    content: '# 构建验证\n\n执行 pnpm build。',
  }
}

/** 造一个最小可用的 api 替身。`skill` 可被单条用例覆盖。 */
function makeApi(overrides: { skill?: () => Promise<SkillDetail> } = {}): unknown {
  return {
    catalog: vi.fn(async () => catalog()),
    permanentStats: vi.fn(async () => ({ ok: true, stats: [], skipped: 0, note: '' })),
    groups: vi.fn(async () => ({ ok: true, groups: [] })),
    sources: vi.fn(async () => ({ ok: true, sources: [], trash: [] })),
    config: vi.fn(async () => ({ ok: true, pluginVersion: '0.5.1-test', config: {}, saved: {}, githubTokenSet: false })),
    updateCheck: vi.fn(async () => ({ ok: true, updateAvailable: false })),
    skill: vi.fn(overrides.skill ?? (async () => detail())),
  }
}

let root: Root | undefined
let container: HTMLDivElement | undefined

/** 挂载面板、切到工作区 tab、点第一行技能，返回容器与收集到的 console 错误。 */
async function openWorkspaceDetail(api: unknown): Promise<{ errors: string[]; html: () => string }> {
  const errors: string[] = []
  const orig = console.error
  console.error = (...args: unknown[]) => {
    errors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
    orig(...args)
  }
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

  console.error = orig
  const el = container as HTMLDivElement
  return { errors, html: () => el.innerHTML }
}

afterEach(async () => {
  if (root !== undefined) await act(async () => { root?.unmount() })
  container?.remove()
  root = undefined
  container = undefined
  vi.restoreAllMocks()
})

describe('工作区技能详情（回归：hook 顺序导致的白屏）', () => {
  it('renders the full detail view without throwing', async () => {
    const { errors, html } = await openWorkspaceDetail(makeApi())
    const markup = html()

    // 核心回归：hook 数量前后不一致会打出一大段 console.error 并让整棵树卸载。
    expect(errors.filter((e) => e.includes('Rendered fewer hooks'))).toEqual([])
    expect(errors).toEqual([])

    // 详情确实渲染了：标题、正文、路径、来源四样都在。
    expect(markup).toContain(SKILL)
    expect(markup).toContain('# 构建验证')
    expect(markup).toContain('SKILL.md')
    expect(markup).toContain('project-dsh')

    // 面板没有被整块卸载：仍然是详情弹窗（dialog 存在）。
    expect(markup).toContain('aria-modal')
  })

  it('passes the skill workspace through as the cwd', async () => {
    const api = makeApi() as { skill: { mock: { calls: unknown[][] } } }
    await openWorkspaceDetail(api)
    // 工作区页把 skill.workspace 透传给 openDetail，服务端据此定位项目技能。
    expect(api.skill.mock.calls[0]).toEqual([SKILL, { cwd: PROJECT }])
  })

  it('keeps the list and shows an error banner when the detail request fails', async () => {
    const api = makeApi({ skill: async () => { throw new Error('404 not found') } })
    const { errors, html } = await openWorkspaceDetail(api)
    const markup = html()

    // 失败不应抛到渲染期（那是白屏的来源），也不应有 React 警告。
    expect(errors.filter((e) => e.includes('Rendered fewer hooks'))).toEqual([])

    // 详情没打开：仍是列表视图，且列表里那一行还在。
    expect(markup).not.toContain('aria-modal')
    expect(markup).toContain(SKILL)
    // 错误以顶部横幅呈现，而不是空白。
    expect(markup).toContain('role="alert"')
    expect(markup).toContain('404 not found')
  })
})

describe('PanelErrorBoundary（兜底）', () => {
  it('renders an error card instead of unmounting, and keeps the caller title bar', async () => {
    const orig = console.error
    console.error = () => {}
    const host = document.createElement('div')
    document.body.appendChild(host)
    let localRoot: Root | undefined

    function Explodes(): JSX.Element {
      throw new Error('boom in child')
    }

    await act(async () => {
      localRoot = createRoot(host)
      localRoot.render(
        <div>
          {/* 标题栏在边界外 —— 它必须活下来。 */}
          <h2>技能书架</h2>
          <PanelErrorBoundary scope='general'>
            <Explodes />
          </PanelErrorBoundary>
        </div>,
      )
    })
    console.error = orig

    const markup = host.innerHTML
    // 边界外的标题栏仍在。
    expect(markup).toContain('技能书架')
    // 边界内换成可读卡片，而不是空。
    expect(markup).toContain('role="alert"')
    expect(markup).toContain('boom in child')
    expect(markup).toContain('general')
    // 提供复制与重试两个出口。
    expect(markup).toContain('复制详情')
    expect(markup).toContain('重试')

    await act(async () => { localRoot?.unmount() })
    host.remove()
  })
})
