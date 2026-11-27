// @vitest-environment jsdom
/**
 * 调用开关文字按钮：点一下 → 调 setInvocation → 失败回滚到点击前的值。
 * 用 createRoot + act（不是 renderToString），才能跑 onClick 和 state 更新。
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CatalogSkill } from '../../protocol.ts'
import { SkillRowImpl, type SkillRowProps } from './SkillRow.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const skill: CatalogSkill = {
  name: 'alpha',
  description: 'd',
  invocation: { modelInvocable: true, userInvocable: false },
  provider: 'test',
  writable: false,
  source: 'user-dsh',
}

function props(setInvocation: SkillRowProps['setInvocation']): SkillRowProps {
  return {
    skill,
    uses: new Map(),
    permanentUses: new Map(),
    hubConfig: null,
    busyNames: new Set(),
    editMode: false,
    tagBusy: false,
    duplicateNames: new Set(),
    setInvocation,
    toggle: async () => {},
    openDetail: async () => {},
    requestDeleteSkill: () => {},
    requestTrashSkill: () => {},
  }
}

let container: HTMLDivElement
let root: Root
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function mount(p: SkillRowProps): HTMLElement[] {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => { root.render(createElement(SkillRowImpl, p)) })
  return Array.from(container.querySelectorAll('button'))
}

describe('SkillRow invocation chips', () => {
  it('两个文字按钮都在，点击各自翻转并调 setInvocation', async () => {
    const fn = vi.fn(async () => true)
    const buttons = mount(props(fn))
    const model = buttons.find((b) => b.textContent === '模型可调用')!
    const user = buttons.find((b) => b.textContent === '用户可调用')!
    expect(model).toBeDefined()
    expect(user).toBeDefined()
    expect(model.getAttribute('aria-pressed')).toBe('true')
    expect(user.getAttribute('aria-pressed')).toBe('false')
    await act(async () => { model.click() })
    expect(fn).toHaveBeenCalledWith(skill, { modelInvocable: false })
    await act(async () => { user.click() })
    expect(fn).toHaveBeenCalledWith(skill, { userInvocable: true })
  })

  it('setInvocation 返回 false 时回滚到点击前的状态', async () => {
    const fn = vi.fn(async () => false)
    const buttons = mount(props(fn))
    const model = buttons.find((b) => b.textContent === '模型可调用')!
    await act(async () => { model.click() })
    // 乐观期间变为关，失败后回到开
    expect(model.getAttribute('aria-pressed')).toBe('true')
    expect(fn).toHaveBeenCalledOnce()
  })
})
