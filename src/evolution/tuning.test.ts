/**
 * 自适应参数校准：确定性规则的单测。
 *
 * 每条规则都必须有样本不足 / 夹紧 / 防抖 / 锁定这几种边界覆盖，因为它们
 * 正是「误调」最可能出现的地方。
 */
import { describe, expect, it } from 'vitest'
import {
  bucketOf,
  belowValueGate,
  clampParam,
  computeTuning,
  defaultParams,
  defaultTuning,
  MAX_DECISIONS,
  MAX_STEP_RATIO,
  MIN_DECISIONS_BETWEEN_ADJUST,
  MIN_SAMPLE,
  maxStep,
  TUNABLE_BOUNDS,
  TUNING_DEFAULTS,
  type EvolutionDecision,
  type ReasonBucket,
  type TuningParams,
  type TuningState,
} from './tuning.ts'

/** 造一条裁决。 */
function decision(
  kind: EvolutionDecision['kind'],
  action: EvolutionDecision['action'],
  reasonBucket: ReasonBucket = 'freeform',
  at = 0,
): EvolutionDecision {
  return { id: `d${String(at)}-${kind}-${action}`, kind, skillName: 'x', action, reason: '', reasonBucket, at }
}

/** 造 n 条同形裁决。 */
function repeat(
  n: number,
  kind: EvolutionDecision['kind'],
  action: EvolutionDecision['action'],
  bucket: ReasonBucket = 'freeform',
): EvolutionDecision[] {
  return Array.from({ length: n }, (_, i) => decision(kind, action, bucket, i))
}

/** 未锁定的默认状态。 */
function fresh(overrides: Partial<TuningState> = {}): TuningState {
  return { ...defaultTuning(), ...overrides }
}

describe('bucketOf', () => {
  it('maps the new-skill quick reasons', () => {
    expect(bucketOf('new-skill', '场景太细碎，复用性差')).toBe('tooNarrow')
    expect(bucketOf('new-skill', '已有通用技能可覆盖')).toBe('covered')
    expect(bucketOf('new-skill', '流程不稳定，规则难固化')).toBe('unstable')
  })

  it('maps the optimize quick reasons', () => {
    expect(bucketOf('optimize', '优先级低，暂不处理')).toBe('lowPriority')
    expect(bucketOf('optimize', '改动风险大，维持现状')).toBe('risky')
    expect(bucketOf('optimize', '现有功能已满足需求')).toBe('sufficient')
  })

  it('maps the reclaim quick reasons', () => {
    expect(bucketOf('reclaim', '暂不回收')).toBe('keep')
    expect(bucketOf('reclaim', '后续观察使用')).toBe('observe')
    expect(bucketOf('reclaim', '仍有实际使用价值')).toBe('stillUseful')
  })

  it('sends free text to freeform', () => {
    expect(bucketOf('new-skill', '我觉得这个以后可能有用吧')).toBe('freeform')
    expect(bucketOf('optimize', '')).toBe('freeform')
  })
})

describe('computeTuning — 最小样本', () => {
  it('does nothing below MIN_SAMPLE', () => {
    const decisions = repeat(MIN_SAMPLE - 1, 'new-skill', 'rejected', 'tooNarrow')
    const out = computeTuning({ decisions, current: fresh() })
    expect(out.applied).toEqual([])
    expect(out.params).toEqual(defaultParams())
  })

  it('acts at exactly MIN_SAMPLE', () => {
    const decisions = repeat(MIN_SAMPLE, 'new-skill', 'rejected', 'tooNarrow')
    const out = computeTuning({ decisions, current: fresh() })
    expect(out.applied.length).toBeGreaterThan(0)
  })

  it('counts per kind, not globally', () => {
    // 4 条 new-skill + 4 条 optimize = 8 全局，但每类都不到 8。
    const decisions = [
      ...repeat(4, 'new-skill', 'rejected', 'tooNarrow'),
      ...repeat(4, 'optimize', 'rejected', 'risky'),
    ]
    const out = computeTuning({ decisions, current: fresh() })
    expect(out.applied).toEqual([])
  })
})

describe('computeTuning — 规则 1：new-skill 太细碎/已覆盖 ≥60%', () => {
  it('raises the value gate and lowers the scan cap', () => {
    const decisions = [
      ...repeat(5, 'new-skill', 'rejected', 'tooNarrow'),
      ...repeat(3, 'new-skill', 'rejected', 'covered'),
    ]
    const out = computeTuning({ decisions, current: fresh() })
    expect(out.params.minValueScore).toBeGreaterThan(TUNING_DEFAULTS.minValueScore)
    expect(out.params.maxScanProposals).toBeLessThan(TUNING_DEFAULTS.maxScanProposals)
    expect(out.applied).toContain('minValueScore')
    expect(out.applied).toContain('maxScanProposals')
  })

  it('never exceeds the 20% step in one pass', () => {
    const decisions = repeat(20, 'new-skill', 'rejected', 'tooNarrow')
    const out = computeTuning({ decisions, current: fresh() })
    const delta = out.params.minValueScore - TUNING_DEFAULTS.minValueScore
    expect(delta).toBeLessThanOrEqual(maxStep('minValueScore'))
    expect(delta / TUNING_DEFAULTS.minValueScore).toBeLessThanOrEqual(MAX_STEP_RATIO)
  })

  it('clamps at the upper bound', () => {
    // 反复施加，最终必须停在 TUNABLE_BOUNDS.max。
    // 每轮都要有新裁决进来，否则防抖（3 条）会挡住后续调整 —— 这正是
    // 期望行为：参数只能随真实裁决前进，不能靠空转刷上去。
    let state = fresh()
    const decisions = repeat(20, 'new-skill', 'rejected', 'tooNarrow')
    for (let round = 0; round < 20; round++) {
      // 每轮追加 3 条新裁决，越过防抖门槛。
      for (let i = 0; i < MIN_DECISIONS_BETWEEN_ADJUST; i++) {
        decisions.push(decision('new-skill', 'rejected', 'tooNarrow', 1000 + round * 10 + i))
      }
      const out = computeTuning({ decisions, current: state })
      state = { ...state, params: out.params, adjustedAt: out.adjustedAt }
    }
    expect(state.params.minValueScore).toBe(TUNABLE_BOUNDS.minValueScore.max)
  })
})

describe('computeTuning — 规则 2：new-skill 采纳 ≥70% 反向回调', () => {
  it('relaxes the gate back toward the default', () => {
    const decisions = repeat(8, 'new-skill', 'accepted')
    const out = computeTuning({ decisions, current: fresh() })
    expect(out.params.minValueScore).toBeLessThanOrEqual(TUNING_DEFAULTS.minValueScore)
    expect(out.applied).toContain('minValueScore')
  })

  it('clamps at the lower bound (55), never to zero', () => {
    let state = fresh()
    const decisions = repeat(20, 'new-skill', 'accepted')
    for (let round = 0; round < 20; round++) {
      for (let i = 0; i < MIN_DECISIONS_BETWEEN_ADJUST; i++) {
        decisions.push(decision('new-skill', 'accepted', 'freeform', 2000 + round * 10 + i))
      }
      const out = computeTuning({ decisions, current: state })
      state = { ...state, params: out.params, adjustedAt: out.adjustedAt }
    }
    expect(state.params.minValueScore).toBe(TUNABLE_BOUNDS.minValueScore.min)
    // 防死亡螺旋：任何参数都不许到 0。
    expect(state.params.minValueScore).toBeGreaterThan(0)
    expect(state.params.maxScanProposals).toBeGreaterThanOrEqual(1)
  })
})

describe('computeTuning — 规则 3：optimize risky ≥50%', () => {
  it('widens the recent-optimize window and lowers the scan cap', () => {
    const decisions = repeat(8, 'optimize', 'rejected', 'risky')
    const out = computeTuning({ decisions, current: fresh() })
    expect(out.params.recentOptimizeDays).toBeGreaterThan(TUNING_DEFAULTS.recentOptimizeDays)
    expect(out.params.maxScanProposals).toBeLessThan(TUNING_DEFAULTS.maxScanProposals)
  })
})

describe('computeTuning — 规则 4：deferred ≥50% 只降频不收紧', () => {
  it('raises minUserMessages and lowers maxSessions', () => {
    const decisions = repeat(8, 'new-skill', 'deferred', 'lowPriority')
    const out = computeTuning({ decisions, current: fresh() })
    expect(out.params.minUserMessages).toBeGreaterThan(TUNING_DEFAULTS.minUserMessages)
    expect(out.params.maxSessions).toBeLessThan(TUNING_DEFAULTS.maxSessions)
  })

  it('NEVER raises the value gate on deferred', () => {
    const decisions = repeat(20, 'new-skill', 'deferred')
    const out = computeTuning({ decisions, current: fresh() })
    // 这是最典型的误调：暂缓是「时机不对」，不是「提案错」。
    expect(out.params.minValueScore).toBe(TUNING_DEFAULTS.minValueScore)
    expect(out.applied).not.toContain('minValueScore')
  })
})

describe('computeTuning — 规则 5：reclaim 仍有用 ≥70%', () => {
  it('makes reclaim advice more conservative', () => {
    const decisions = [
      ...repeat(4, 'reclaim', 'rejected', 'stillUseful'),
      ...repeat(4, 'reclaim', 'rejected', 'keep'),
    ]
    const out = computeTuning({ decisions, current: fresh() })
    expect(out.params.staleDays).toBeGreaterThan(TUNING_DEFAULTS.staleDays)
    expect(out.params.staleDays).toBeLessThanOrEqual(TUNABLE_BOUNDS.staleDays.max)
  })
})

describe('computeTuning — 规则 6：covered ≥70% 让 dedup 更积极', () => {
  it('lowers the reason similarity threshold', () => {
    const decisions = repeat(8, 'new-skill', 'rejected', 'covered')
    const out = computeTuning({ decisions, current: fresh() })
    expect(out.params.reasonSimilarityThreshold).toBeLessThan(TUNING_DEFAULTS.reasonSimilarityThreshold)
    expect(out.params.reasonSimilarityThreshold).toBeGreaterThanOrEqual(TUNABLE_BOUNDS.reasonSimilarityThreshold.min)
  })
})

describe('computeTuning — locked 跳过', () => {
  it('skips a locked parameter entirely', () => {
    const decisions = repeat(20, 'new-skill', 'rejected', 'tooNarrow')
    const out = computeTuning({ decisions, current: fresh({ locked: ['minValueScore'] }) })
    expect(out.params.minValueScore).toBe(TUNING_DEFAULTS.minValueScore)
    expect(out.applied).not.toContain('minValueScore')
    // 未锁定的仍然照常调整。
    expect(out.applied).toContain('maxScanProposals')
  })
})

describe('computeTuning — freeform 不驱动参数', () => {
  it('counts freeform in basis but adjusts nothing', () => {
    const decisions = repeat(20, 'new-skill', 'rejected', 'freeform')
    const out = computeTuning({ decisions, current: fresh() })
    expect(out.applied).toEqual([])
    expect(out.basis.buckets.freeform).toBe(20)
  })
})

describe('computeTuning — 防抖', () => {
  it('does not re-adjust within MIN_DECISIONS_BETWEEN_ADJUST decisions', () => {
    const decisions = repeat(20, 'new-skill', 'rejected', 'tooNarrow')
    const first = computeTuning({ decisions, current: fresh() })
    expect(first.applied).toContain('minValueScore')

    // 紧接着再加 1 条（不足 3 条）：同一参数不应再动。
    const state: TuningState = { ...fresh(), params: first.params, adjustedAt: first.adjustedAt }
    const second = computeTuning({
      decisions: [...decisions, decision('new-skill', 'rejected', 'tooNarrow', 99)],
      current: state,
    })
    expect(second.params.minValueScore).toBe(first.params.minValueScore)
  })

  it('re-adjusts once enough new decisions arrived', () => {
    const decisions = repeat(20, 'new-skill', 'rejected', 'tooNarrow')
    const first = computeTuning({ decisions, current: fresh() })
    const state: TuningState = { ...fresh(), params: first.params, adjustedAt: first.adjustedAt }

    const grown = [...decisions]
    for (let i = 0; i < MIN_DECISIONS_BETWEEN_ADJUST; i++) {
      grown.push(decision('new-skill', 'rejected', 'tooNarrow', 100 + i))
    }
    const second = computeTuning({ decisions: grown, current: state })
    expect(second.params.minValueScore).toBeGreaterThan(first.params.minValueScore)
  })
})

describe('clampParam / bounds', () => {
  it('clamps every key to its declared bounds', () => {
    for (const key of Object.keys(TUNING_DEFAULTS) as Array<keyof typeof TUNING_DEFAULTS>) {
      expect(clampParam(key, -999)).toBe(TUNABLE_BOUNDS[key].min)
      expect(clampParam(key, 999)).toBe(TUNABLE_BOUNDS[key].max)
    }
  })

  it('keeps every bound above zero (no death spiral)', () => {
    for (const key of Object.keys(TUNABLE_BOUNDS) as Array<keyof typeof TUNABLE_BOUNDS>) {
      expect(TUNABLE_BOUNDS[key].min).toBeGreaterThan(0)
    }
  })
})

describe('集成：门槛调到 68 后，价值 65 的提案被过滤', () => {
  it('belowValueGate reflects the tuned threshold', () => {
    const decisions = repeat(20, 'new-skill', 'rejected', 'tooNarrow')
    // 多轮推进到 ≥68
    let state = fresh()
    let params = state.params as TuningParams
    for (let round = 0; round < 10; round++) {
      const out = computeTuning({ decisions, current: { ...state, params } })
      params = out.params
      state = { ...state, adjustedAt: out.adjustedAt }
      if (params.minValueScore >= 68) break
    }
    expect(params.minValueScore).toBeGreaterThanOrEqual(68)
    // 65 分的提案不再出现；高于门槛的仍然通过。
    expect(belowValueGate(65, params)).toBe(true)
    expect(belowValueGate(params.minValueScore, params)).toBe(false)
  })
})

describe('MAX_DECISIONS', () => {
  it('is the documented cap', () => {
    expect(MAX_DECISIONS).toBe(300)
  })
})
