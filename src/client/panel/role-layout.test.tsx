// @vitest-environment jsdom
/**
 * 回归：角色视图的筛选说明行不能撑高面板。
 *
 * 现场：`.filterNote` 曾是 `.filterBar`（横向 flex-wrap）的子节点，写
 * `flex-basis: 100%` 表示「占满一整行」。后来它被移到 `.panel` 的**直接子级**，
 * 而 `.panel` 是 `flex-direction: column` —— 主轴变成垂直，`flex-basis: 100%`
 * 于是表示「高度占满整个面板」，再叠加 `.panelWide > * { flex-shrink: 0 }`
 * 就成了一段不可收缩的满屏空白，把筛选条和下面的分组列表顶开半屏。
 *
 * 本测试守两件事：
 *  1. CSS 里 `.filterNote` 不再出现 `flex-basis: 100%`（用 auto，不参与伸缩）；
 *  2. 角色视图里，`filterNote` 到第一个分组之间没有其它可见块级节点。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SkillHubPanel } from './SkillHubPanel.tsx'

const cssText = readFileSync(join(process.cwd(), 'src', 'client', 'panel', 'panel.module.css'), 'utf8')

/** 取某个 class 的声明块正文（只取第一条匹配）。 */
function cssBlock(name: string): string {
  const m = new RegExp('\\.' + name + '\\s*\\{([^}]*)\\}').exec(cssText)
  return m ? m[1].replace(/\s+/g, ' ') : ''
}

let root: ReturnType<typeof createRoot> | undefined
let container: HTMLDivElement | undefined
afterEach(() => { act(() => root?.unmount()); container?.remove() })

function makeApi() {
  const skills = Array.from({ length: 81 }, (_, i) => ({
    name: `skill-${i}`,
    description: i % 3 === 0 ? 'design css typography' : i % 3 === 1 ? 'documentation writing markdown' : 'plugin config setup',
    invocation: { modelInvocable: true, userInvocable: true },
    provider: 'filesystem', writable: true, source: 'user-dsh', toggleable: true,
  }))
  return {
    catalog: vi.fn(async () => ({ ok: true, pluginVersion: 'x', complete: true, skills, disabled: [], diagnostics: [],
      announcement: { skills: skills.length, chars: 0, approxTokens: 0, descriptionMaxLength: 400, truncated: 0 },
      workspaces: [], currentWorkspace: '' })),
    permanentStats: vi.fn(async () => ({ ok: true, stats: [], skipped: 0, note: '' })),
    groups: vi.fn(async () => ({ ok: true, groups: [] })),
    sources: vi.fn(async () => ({ ok: true, sources: [], trash: [] })),
    config: vi.fn(async () => ({ ok: true, pluginVersion: 'x', config: {}, saved: {}, githubTokenSet: false })),
    updateCheck: vi.fn(async () => ({ ok: true, updateAvailable: false })),
    checkSources: vi.fn(async () => ({ ok: true, results: [] })),
    checkUpdate: vi.fn(async () => ({ ok: true, updateAvailable: false })),
    checkMarket: vi.fn(async () => ({ ok: true })),
    fetchEvolution: vi.fn(async () => ({ ok: true, enabled: false, markdown: '', ranAt: 0, proposals: [], runs: [], rejections: [], running: false, elapsedMs: 0 })),
  }
}

describe('角色视图：筛选说明行不撑高面板', () => {
  it('.filterNote 不再用 flex-basis: 100%（column 容器里那等于满屏高度）', () => {
    const block = cssBlock('filterNote')
    expect(block).not.toContain('flex-basis: 100%')
    // 显式 auto：既不撑高也不参与伸缩。
    expect(block).toMatch(/flex:\s*0\s+0\s+auto/)
  })

  it('filterNote 到第一个分组之间没有其它可见块级节点', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => { root!.render(createElement(SkillHubPanel, { api: makeApi() as never, mode: 'sidebar' })) })
    for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve() })

    const cat = [...container.querySelectorAll('select')].find((s) => s.getAttribute('aria-label') === '分类')
    expect(cat).toBeDefined()
    await act(async () => { (cat as HTMLSelectElement).value = 'scene'; cat!.dispatchEvent(new Event('change', { bubbles: true })) })
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve() })

    const panel = container.querySelector('[class*="panel"]')!
    const kids = [...panel.children]
    const noteIndex = kids.findIndex((el) => /filterNote/.test(el.className))
    const firstSection = kids.findIndex((el) => el.tagName === 'SECTION')
    expect(noteIndex).toBeGreaterThanOrEqual(0)
    expect(firstSection).toBeGreaterThan(noteIndex)

    // 中间允许有计数行（有文字），但不允许出现空的块级占位。
    const between = kids.slice(noteIndex + 1, firstSection)
    for (const el of between) {
      const text = (el.textContent ?? '').trim()
      // 计数行必须带文字；空节点一律不允许出现在这两者之间。
      expect(text.length, `unexpected empty block between filterNote and first group: ${el.tagName}.${el.className}`).toBeGreaterThan(0)
    }
  })
})
