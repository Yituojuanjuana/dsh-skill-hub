import { describe, expect, it } from 'vitest'
import { hydrateMigratedState, migrateStore } from './migrate.ts'

describe('firstSeenAt 旧状态降级', () => {
  it('旧文件没有 firstSeenAt → 空 map，安装时间回落 birthtime', () => {
    const migrated = migrateStore({ version: 4, disabled: [] })
    const state = hydrateMigratedState(migrated!)
    expect(state.firstSeenAt).toEqual({})
  })

  it('有 firstSeenAt → 只保留合法条目', () => {
    const migrated = migrateStore({
      version: 4,
      disabled: [],
      firstSeenAt: { '/a/SKILL.md': 1234, '/bad': -1, '/nope': 'x', '': 99 },
    })
    const state = hydrateMigratedState(migrated!)
    expect(state.firstSeenAt).toEqual({ '/a/SKILL.md': 1234 })
  })

  it('坏字段形状不因升级清空其它状态', () => {
    const migrated = migrateStore({ version: 4, disabled: [], firstSeenAt: 'garbage' })
    const state = hydrateMigratedState(migrated!)
    expect(state.firstSeenAt).toEqual({})
    expect(state.entries).toBeInstanceOf(Map)
  })
})
