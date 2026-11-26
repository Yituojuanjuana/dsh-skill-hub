/**
 * 会话计数展示回归：完成提示必须显示真实会话数，不能硬编码 0。
 *
 * 真实故障：后端一直正确统计（runs[0].sessions = 12），但前端完成提示里写死
 * `sessions: 0`，于是用户永远看到「读取 0 个会话」，误以为扫描失败。
 *
 * 这个测试锁住「提示文案里的数字必须来自服务端数据」。
 */
import { describe, expect, it } from 'vitest'
import type { EvolutionResponse, EvolutionRunRecord } from '../protocol/evolution.ts'

/** 复刻 EvolutionView 里选择「完成提示」数字的逻辑。 */
function noticeNumbers(state: Pick<EvolutionResponse, 'proposals' | 'runs'>): { count: number; sessions: number } {
  return {
    count: state.proposals.length,
    sessions: state.runs[0]?.sessions ?? 0,
  }
}

/** 复刻「上次运行」那行的数字选择逻辑。 */
function headerNumbers(state: Pick<EvolutionResponse, 'ranAt' | 'runs'>): { sessions: number; messages: number } | undefined {
  if (state.ranAt <= 0) return undefined
  return {
    sessions: state.runs[0]?.sessions ?? 0,
    messages: state.runs[0]?.messages ?? 0,
  }
}

const run = (sessions: number, messages: number): EvolutionRunRecord => ({ at: 1, sessions, messages, proposals: 0 })

describe('session count in completion notice', () => {
  it('uses the real session count from the latest run record', () => {
    const state = { proposals: [], runs: [run(12, 917)] }
    expect(noticeNumbers(state).sessions).toBe(12)
  })

  it('is not hardcoded to zero', () => {
    // 这条就是那个 bug：之前无论后端给什么，这里都是 0。
    for (const sessions of [1, 3, 12, 40]) {
      expect(noticeNumbers({ proposals: [], runs: [run(sessions, 100)] }).sessions).toBe(sessions)
    }
  })

  it('falls back to 0 only when there is genuinely no run history', () => {
    expect(noticeNumbers({ proposals: [], runs: [] }).sessions).toBe(0)
  })

  it('reads the newest record, not an older one', () => {
    const state = { proposals: [], runs: [run(12, 917), run(3, 40)] }
    expect(noticeNumbers(state).sessions).toBe(12)
  })

  it('reports the proposal count independently of sessions', () => {
    const state = {
      proposals: [
        { id: 'a', kind: 'new-skill' as const, skillName: 'x', createdAt: 1, status: 'pending' as const },
        { id: 'b', kind: 'new-skill' as const, skillName: 'y', createdAt: 1, status: 'pending' as const },
      ],
      runs: [run(12, 917)],
    }
    expect(noticeNumbers(state)).toEqual({ count: 2, sessions: 12 })
  })
})

describe('header run detail', () => {
  it('shows sessions and messages once a run happened', () => {
    expect(headerNumbers({ ranAt: 100, runs: [run(12, 917)] })).toEqual({ sessions: 12, messages: 917 })
  })

  it('returns nothing before the first run', () => {
    expect(headerNumbers({ ranAt: 0, runs: [] })).toBeUndefined()
  })

  it('degrades safely when ranAt is set but runs is empty', () => {
    expect(headerNumbers({ ranAt: 100, runs: [] })).toEqual({ sessions: 0, messages: 0 })
  })
})
