// @vitest-environment jsdom
/**
 * 回归：首屏不得出现「整块空白」。
 *
 * 现场故障：从侧栏入口进入「技能书架」→「通用」页整页空白；切一次 tab 再
 * 切回来就恢复正常。
 *
 * 根因（两条叠加）：
 * 1. `loading` 是单向闩（`useCatalogFlow.ts` 的 `loadingRef` 只从 true 变一次
 *    false）。首次 `load()` 失败后 `loading=false` 而 `catalog` 仍是 null。
 * 2. 面板只按 `loading` 决定是否画骨架；正文区要求 `catalog !== null`。
 *    两者都不满足时，标题栏和筛选行之外没有任何内容 —— 就是那块空白。
 *
 * 修法：骨架条件改为 `loading || catalog === null`，并在首次失败时复位
 * `loading`。本测试钉住「侧栏入口首屏」这条路径：catalog 未就绪时必须有
 * 可见的加载占位，而不是空 DOM。
 */
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CatalogResponse, CatalogSkill } from '../../../protocol.ts'
import type { SkillHubApi } from '../../api.ts'
import { useCatalogFlow } from './useCatalogFlow.ts'
import type { FlowNotices } from './shared.ts'

;(globalThis as { IS_SHARE?: boolean }).IS_SHARE = undefined
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function skill(name: string): CatalogSkill {
  return {
    name,
    description: name + ' description',
    invocation: { modelInvocable: true, userInvocable: true },
    provider: 'filesystem',
    writable: true,
    source: 'user-dsh',
  }
}

function catalog(skills: CatalogSkill[] = [skill('alpha')]): CatalogResponse {
  return {
    ok: true,
    pluginVersion: '0.0.0-test',
    complete: true,
    skills,
    disabled: [],
    diagnostics: [],
    announcement: { skills: skills.length, chars: 0, approxTokens: 0, descriptionMaxLength: 400, truncated: 0 },
  }
}

function notices(): FlowNotices & { errors: string[] } {
  const errors: string[] = []
  return {
    errors,
    fail: (message: string) => { errors.push(message) },
    clearFail: () => { errors.length = 0 },
    succeed: () => {},
    setTagBusy: () => {},
    setBatchBusy: () => {},
  }
}

interface Paint { loading: boolean; catalog: CatalogResponse | null }

/**
 * 复刻面板的挂载路径：hook 挂载后**立即触发一次 load()**（与
 * `useSkillHub` 的 mount effect 一致），然后暴露决定首屏画什么的两个字段。
 */
function mountPanelLike(api: SkillHubApi, shared: FlowNotices): {
  read: () => Paint
  unmount: () => void
} {
  let latest: Paint = { loading: true, catalog: null }
  const container = document.createElement('div')
  document.body.appendChild(container)

  function Probe(): null {
    const flow = useCatalogFlow(api, new Map(), shared, () => {})
    latest = { loading: flow.loading, catalog: flow.catalog }
    const { load } = flow
    useEffect(() => { void load() }, [load])
    return null
  }

  const root: Root = createRoot(container)
  act(() => { root.render(<Probe />) })

  return {
    read: () => latest,
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

const flush = async (): Promise<void> => {
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

describe('侧栏入口首屏不会空白', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('首屏请求未返回时 loading=true、catalog=null（画骨架，不是空 DOM）', async () => {
    const api = { catalog: vi.fn(() => new Promise<CatalogResponse>(() => {})) } as unknown as SkillHubApi
    const paint = mountPanelLike(api, notices())
    await flush()

    const first = paint.read()
    expect(first.catalog).toBeNull()
    expect(first.loading).toBe(true)
    paint.unmount()
  })

  it('首次加载失败后 loading 复位为 true，不会停在空白态', async () => {
    const api = {
      catalog: vi.fn(() => Promise.reject(new Error('network down'))),
    } as unknown as SkillHubApi
    const shared = notices()
    const paint = mountPanelLike(api, shared)
    await flush()

    const after = paint.read()
    expect(after.catalog).toBeNull()
    // 核心回归：失败不能把 loading 永久钉成 false，否则正文整块空白。
    expect(after.loading).toBe(true)
    // 失败原因仍要能让用户看到。
    expect(shared.errors.length).toBeGreaterThan(0)
    paint.unmount()
  })

  it('加载成功后 loading=false、catalog 就绪（正常路径不被破坏）', async () => {
    const api = { catalog: vi.fn(() => Promise.resolve(catalog())) } as unknown as SkillHubApi
    const paint = mountPanelLike(api, notices())
    await flush()

    const done = paint.read()
    expect(done.catalog).not.toBeNull()
    expect(done.loading).toBe(false)
    expect(done.catalog?.skills.map((s) => s.name)).toEqual(['alpha'])
    paint.unmount()
  })
})
