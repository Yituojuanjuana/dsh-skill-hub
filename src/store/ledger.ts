/**
 * 停用台账 + 模型调用覆盖。
 *
 * 两者是一件事的两面：`disabled[]` 记「谁被停用了」（供 UI 展示与恢复），
 * `invocationOverrides` 记真值（发现文件绝对路径，provider 据此关掉模型调用）。
 * 所有写入口都必须同时维护这两份，所以它们放在同一个 slice。
 */
import type { DisabledSkill } from '../protocol.ts'
import type { StoreCore } from './core.ts'

export interface SkillLedgerSlice {
  listDisabled(): Promise<DisabledSkill[]>
  getDisabled(name: string): Promise<DisabledSkill | undefined>
  addDisabled(entry: DisabledSkill): Promise<void>
  removeDisabled(name: string): Promise<void>
  listInvocationOverrides(): Promise<string[]>
  addInvocationOverride(discoveryPath: string): Promise<void>
  removeInvocationOverride(discoveryPath: string): Promise<void>
  /** 读取某路径首次被观测到的时间（无记录返回 undefined）。 */
  getFirstSeenAt(path: string): Promise<number | undefined>
  /** 读取全部 firstSeenAt（路径 → 时间戳）。 */
  listFirstSeen(): Promise<Record<string, number>>
  /**
   * 批量登记首次观测时间：已存在的键绝不覆盖，只补新键。
   * 返回是否真的新增了记录（供调用方决定是否落盘）。
   */
  recordFirstSeen(entries: ReadonlyArray<{ path: string; at: number }>): Promise<boolean>
}

export function skillLedgerSlice(core: StoreCore): SkillLedgerSlice {
  const { state } = core
  return {
    async listDisabled(): Promise<DisabledSkill[]> {
      await core.ensureLoaded()
      return [...state.entries.values()].sort((a, b) => a.name.localeCompare(b.name))
    },

    async getDisabled(name: string): Promise<DisabledSkill | undefined> {
      await core.ensureLoaded()
      return state.entries.get(name)
    },

    async addDisabled(entry: DisabledSkill): Promise<void> {
      await core.ensureLoaded()
      state.entries.set(entry.name, entry)
      await core.persist()
    },

    async removeDisabled(name: string): Promise<void> {
      await core.ensureLoaded()
      if (!state.entries.delete(name)) return
      await core.persist()
    },

    /** 模型调用被 hub 关掉的项目技能（发现文件绝对路径）。 */
    async listInvocationOverrides(): Promise<string[]> {
      await core.ensureLoaded()
      return [...state.invocationOverrides]
    },

    async addInvocationOverride(discoveryPath: string): Promise<void> {
      await core.ensureLoaded()
      if (state.invocationOverrides.has(discoveryPath)) return
      state.invocationOverrides.add(discoveryPath)
      await core.persist()
    },

    async removeInvocationOverride(discoveryPath: string): Promise<void> {
      await core.ensureLoaded()
      if (!state.invocationOverrides.delete(discoveryPath)) return
      await core.persist()
    },

    async getFirstSeenAt(path: string): Promise<number | undefined> {
      await core.ensureLoaded()
      return state.firstSeenAt.get(path)
    },

    async listFirstSeen(): Promise<Record<string, number>> {
      await core.ensureLoaded()
      return Object.fromEntries(state.firstSeenAt)
    },

    async recordFirstSeen(entries: ReadonlyArray<{ path: string; at: number }>): Promise<boolean> {
      await core.ensureLoaded()
      let changed = false
      for (const { path, at } of entries) {
        if (path === '' || !Number.isFinite(at) || at <= 0) continue
        if (state.firstSeenAt.has(path)) continue
        state.firstSeenAt.set(path, at)
        changed = true
      }
      if (changed) await core.persist()
      return changed
    },
  }
}
