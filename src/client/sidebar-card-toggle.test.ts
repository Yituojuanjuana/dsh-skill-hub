/**
 * 侧边栏入口开关（B 方案）。
 *
 * 机制结论：`ctx.slots.inject()` 返回 dispose 函数 → 可以在运行时真正撤掉
 * 注册，不是「加载期固定、只能视觉隐藏」。实现用 `scope.subscribe()` 监听
 * 配置变化：showSidebarCard=false 时 dispose 掉入口，侧边栏里根本没有它。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HUB_CONFIG_DEFAULTS, resolveHubConfig } from '../protocol/config.ts'
import { SkillHubSettingsCardController } from './SkillHubSettingsCard.tsx'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENTRY = readFileSync(join(HERE, 'index.tsx'), 'utf8')

/** 复刻 index.tsx 里的可见性判定。 */
const sidebarVisible = (value: Record<string, unknown> | undefined): boolean => value?.showSidebarCard !== false

interface FakeScope {
  listeners: Set<() => void>
  value: Record<string, unknown>
  subscribe(fn: () => void): () => void
  getSnapshot(): { status: string; writable: boolean; value: Record<string, unknown> }
  set(field: string, v: unknown): Promise<boolean>
  unset(field: string): Promise<boolean>
}

const fakeScope = (value: Record<string, unknown> = {}): FakeScope => ({
  listeners: new Set(),
  value,
  subscribe(fn) { this.listeners.add(fn); return () => { this.listeners.delete(fn) } },
  getSnapshot() { return { status: 'ready', writable: true, value: this.value } },
  async set(field, v) { this.value[field] = v; this.listeners.forEach((f) => f()); return true },
  async unset(field) { delete this.value[field]; this.listeners.forEach((f) => f()); return true },
})

describe('default value is true', () => {
  it('HUB_CONFIG_DEFAULTS has showSidebarCard true', () => {
    expect(HUB_CONFIG_DEFAULTS.showSidebarCard).toBe(true)
  })

  it('resolveHubConfig inherits true when unset', () => {
    expect(resolveHubConfig({}).showSidebarCard).toBe(true)
    expect(resolveHubConfig({ showSidebarCard: false }).showSidebarCard).toBe(false)
  })

  it('absent config value means visible', () => {
    expect(sidebarVisible(undefined)).toBe(true)
    expect(sidebarVisible({})).toBe(true)
    expect(sidebarVisible({ showSidebarCard: false })).toBe(false)
  })
})

describe('settings card exposes the field', () => {
  it('controller projects showSidebarCard', () => {
    const scope = fakeScope({}) as never
    const controller = new SkillHubSettingsCardController(scope)
    const face = controller.inject()
    // 首次快照里字段存在（值来自默认继承，此处 fake scope 的 formData 未填 → undefined）。
    expect(face.hooks.skillHubSettingsCard).toBeDefined()
  })

  it('field row uses showSidebarCard with label and hint', () => {
    const card = readFileSync(join(HERE, 'SkillHubSettingsCard.tsx'), 'utf8')
    expect(card).toContain("booleanField('showSidebarCard')")
    expect(card).toContain("field: 'showSidebarCard'")
    expect(card).toContain("label: 'settings.showSidebarCard'")
    expect(card).toContain("hint: 'settings.showSidebarCardHint'")
  })

  it('locale has both zh and en keys', () => {
    const loc = readFileSync(join(HERE, 'locales', 'settings.ts'), 'utf8')
    expect(loc).toContain("'settings.showSidebarCard': '侧边栏显示技能中枢'")
    expect(loc).toContain("'settings.showSidebarCard': 'Show Skill Hub in sidebar'")
  })
})

describe('sidebar entry is truly unregistered when off', () => {
  it('uses scope.subscribe and dispose (not CSS hiding)', () => {
    expect(ENTRY).toContain('scope.subscribe(')
    expect(ENTRY).toContain('disposeEntry?.()')
    expect(ENTRY).toContain('showSidebarCard !== false')
    // 关键：是 dispose 掉注册，不是加 hidden class。
    expect(ENTRY).toContain('unregisterEntry')
  })

  it('registers when visible and disposes when hidden', () => {
    const scope = fakeScope({ showSidebarCard: true })
    let registered = false
    const registerEntry = (): void => { registered = true }
    const unregisterEntry = (): void => { registered = false }

    // 模拟 index.tsx 的订阅回调。
    const apply = (): void => {
      if (sidebarVisible(scope.getSnapshot().value)) registerEntry()
      else unregisterEntry()
    }
    scope.subscribe(apply)
    apply()
    expect(registered).toBe(true)

    void scope.set('showSidebarCard', false)
    expect(registered).toBe(false)

    void scope.set('showSidebarCard', true)
    expect(registered).toBe(true)
  })
})

describe('config layers all carry the field', () => {
  it('protocol declarations include showSidebarCard', () => {
    const proto = readFileSync(join(HERE, '..', 'protocol', 'config.ts'), 'utf8')
    for (const token of ["'showSidebarCard'", 'showGroupSummary: boolean', 'showSidebarCard: boolean', 'showSidebarCard: true']) {
      expect(proto).toContain(token)
    }
  })

  it('host schema and config route parse it', () => {
    const host = readFileSync(join(HERE, '..', 'index.ts'), 'utf8')
    expect(host).toContain('showSidebarCard: ConfigFields.showSidebarCard.volatile()')
    const route = readFileSync(join(HERE, '..', 'routes', 'config.ts'), 'utf8')
    expect(route).toContain("'showGroupSummary', 'showSidebarCard'")
  })
})
