import { describe, expect, it } from 'vitest'
import { computeTuning, defaultTuning, MIN_SAMPLE, type EvolutionDecision } from './tuning.ts'
import { filterByProbability, fnv1a32 } from './scan.ts'

function decisions(kind: EvolutionDecision['kind'], counts: { accepted?: number; rejected?: number; deferred?: number }): EvolutionDecision[] {
  const out: EvolutionDecision[] = []
  let i = 0
  for (const [action, n] of Object.entries(counts) as Array<[EvolutionDecision['action'], number]>) {
    for (let j = 0; j < n; j++) {
      out.push({ id: `${kind}-${action}-${i++}`, kind, skillName: `skill-${i}`, reason: '', action, reasonBucket: 'freeform', at: i })
    }
  }
  return out
}

describe('computeTuning — 出现概率', () => {
  it('样本不足时不变', () => {
    const out = computeTuning({ decisions: decisions('optimize', { rejected: MIN_SAMPLE - 1 }), current: defaultTuning() })
    expect(out.kindProbability.optimize).toBeUndefined()
  })

  it('驳回多 → 概率下降，暂缓按半票计', () => {
    const out = computeTuning({ decisions: decisions('optimize', { accepted: 1, rejected: 7 }), current: defaultTuning() })
    expect(out.kindProbability.optimize!).toBeLessThan(0.5)
  })

  it('暂缓按半票计：同量暂缓的惩罚小于驳回', () => {
    const deferred = computeTuning({ decisions: decisions('reclaim', { accepted: 4, deferred: 4 }), current: defaultTuning() })
    const rejected = computeTuning({ decisions: decisions('reclaim', { accepted: 4, rejected: 4 }), current: defaultTuning() })
    expect(deferred.kindProbability.reclaim!).toBeGreaterThan(rejected.kindProbability.reclaim!)
    expect(deferred.kindProbability.reclaim!).toBeCloseTo(0.65) // 0.625 量化到 0.05 → 0.65
    expect(rejected.kindProbability.reclaim!).toBe(0.5)
  })

  it('大量采纳 → p=1 且给额外名额，但不改价值门槛', () => {
    const out = computeTuning({ decisions: decisions('optimize', { accepted: 10 }), current: defaultTuning() })
    expect(out.kindProbability.optimize).toBe(1)
    expect(out.extraSlots.optimize).toBe(1)
    expect(out.params.minValueScore).toBe(defaultTuning().params.minValueScore)
  })

  it('下界夹取 0.25', () => {
    const out = computeTuning({ decisions: decisions('reclaim', { rejected: 12 }), current: defaultTuning() })
    expect(out.kindProbability.reclaim).toBe(0.25)
  })

  it('关闭开关 → 概率恒 1，无名额', () => {
    const out = computeTuning({
      decisions: decisions('optimize', { rejected: 12 }),
      current: { ...defaultTuning(), probabilityEnabled: false },
    })
    expect(out.kindProbability.optimize).toBe(1)
    expect(out.extraSlots.optimize).toBeUndefined()
  })

  it('reset 通过 defaultTuning 清空概率', () => {
    expect(defaultTuning().kindProbability).toEqual({})
  })
})

describe('确定性概率过滤', () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ name: `skill-${i}` }))

  it('fnv1a32 稳定：同输入同结果', () => {
    expect(fnv1a32('optimize|skill-0|2026-11-27')).toBe(fnv1a32('optimize|skill-0|2026-11-27'))
  })

  it('同输入同日期过滤结果一致，且 p=1 不过滤', () => {
    const now = new Date(2026, 10, 27, 12).getTime()
    const a = filterByProbability(items, 'optimize', { kindProbability: { optimize: 0.5 }, now })
    const b = filterByProbability(items, 'optimize', { kindProbability: { optimize: 0.5 }, now })
    expect(a.findings.map((x) => x.name)).toEqual(b.findings.map((x) => x.name))
    expect(a.suppressedByProbability).toBeGreaterThan(0)
    const all = filterByProbability(items, 'optimize', { kindProbability: { optimize: 1 }, now })
    expect(all.findings).toHaveLength(items.length)
    expect(all.suppressedByProbability).toBe(0)
  })

  it('跨日期会变化', () => {
    const d1 = new Date(2026, 10, 27, 12).getTime()
    const d2 = new Date(2026, 10, 28, 12).getTime()
    const a = filterByProbability(items, 'reclaim', { kindProbability: { reclaim: 0.5 }, now: d1 })
    const b = filterByProbability(items, 'reclaim', { kindProbability: { reclaim: 0.5 }, now: d2 })
    expect(a.findings.map((x) => x.name)).not.toEqual(b.findings.map((x) => x.name))
  })

  it('开关关闭时不过滤', () => {
    const out = filterByProbability(items, 'optimize', { kindProbability: { optimize: 0.25 }, enabled: false })
    expect(out.findings).toHaveLength(items.length)
    expect(out.suppressedByProbability).toBe(0)
  })
})
