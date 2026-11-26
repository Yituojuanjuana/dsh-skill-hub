/**
 * 旧 evolution.json（无 `decisions` / `tuning`）必须能降级读。
 *
 * 这是升级路径上最容易静默坏掉的地方：读不到就抛错，会让整个进化页打不开；
 * 读成空但把参数也清掉，会让用户调过的阈值一夜回到默认。
 */
import { describe, expect, it } from 'vitest'
import { hydrateEvolutionFile } from './store.ts'
import { defaultParams, TUNING_DEFAULTS, TUNABLE_BOUNDS } from './tuning.ts'

/** 一份升级前的老文件：只有 version / markdown / proposals / runs / rejections。 */
function legacyFile(): Record<string, unknown> {
  return {
    version: 1,
    markdown: '# 旧提案文本',
    ranAt: 1700000000000,
    proposals: [
      {
        id: 'p1',
        kind: 'new-skill',
        skillName: 'old-skill',
        createdAt: 1700000000000,
        status: 'pending',
      },
    ],
    runs: [],
    rejections: [
      { id: 'r1', skillName: 'old-skill', reason: '太细碎', at: 1700000000000, kind: 'new-skill' },
    ],
  }
}

describe('hydrateEvolutionFile — 旧文件降级', () => {
  it('fills decisions with an empty array when absent', () => {
    const file = hydrateEvolutionFile(legacyFile())
    expect(file.decisions).toEqual([])
  })

  it('falls back to default tuning when absent', () => {
    const file = hydrateEvolutionFile(legacyFile())
    expect(file.tuning).toBeDefined()
    expect(file.tuning?.params).toEqual(defaultParams())
    expect(file.tuning?.locked).toEqual([])
    expect(file.tuning?.updatedAt).toBe(0)
  })

  it('keeps the legacy fields untouched', () => {
    const file = hydrateEvolutionFile(legacyFile())
    expect(file.markdown).toBe('# 旧提案文本')
    expect(file.proposals).toHaveLength(1)
    expect(file.rejections).toHaveLength(1)
  })

  it('survives a completely empty object', () => {
    const file = hydrateEvolutionFile({})
    expect(file.decisions).toEqual([])
    expect(file.tuning?.params).toEqual(defaultParams())
  })

  it('survives garbage tuning without throwing', () => {
    const file = hydrateEvolutionFile({ ...legacyFile(), tuning: 'not-an-object' })
    expect(file.tuning?.params).toEqual(defaultParams())
  })
})

describe('hydrateEvolutionFile — 已有 tuning 的读回', () => {
  it('preserves tuned values', () => {
    const file = hydrateEvolutionFile({
      ...legacyFile(),
      tuning: {
        params: { minValueScore: 68, maxScanProposals: 4 },
        updatedAt: 1700000001000,
        basis: { total: 20, accepted: 2, rejected: 9, deferred: 9, buckets: { tooNarrow: 5 } },
        applied: ['minValueScore'],
        adjustedAt: { minValueScore: 20 },
        locked: ['staleDays'],
      },
    })
    expect(file.tuning?.params.minValueScore).toBe(68)
    expect(file.tuning?.params.maxScanProposals).toBe(4)
    // 未提供的键回落默认值。
    expect(file.tuning?.params.recentOptimizeDays).toBe(TUNING_DEFAULTS.recentOptimizeDays)
    expect(file.tuning?.locked).toEqual(['staleDays'])
    expect(file.tuning?.basis.rejected).toBe(9)
  })

  it('clamps out-of-range values instead of trusting the disk', () => {
    const file = hydrateEvolutionFile({
      ...legacyFile(),
      tuning: { params: { minValueScore: 999, maxScanProposals: -5 } },
    })
    expect(file.tuning?.params.minValueScore).toBe(TUNABLE_BOUNDS.minValueScore.max)
    expect(file.tuning?.params.maxScanProposals).toBe(TUNABLE_BOUNDS.maxScanProposals.min)
  })

  it('drops unknown locked keys', () => {
    const file = hydrateEvolutionFile({
      ...legacyFile(),
      tuning: { locked: ['minValueScore', 'notAParam'] },
    })
    expect(file.tuning?.locked).toEqual(['minValueScore'])
  })
})

describe('hydrateEvolutionFile — decisions 校验', () => {
  it('keeps well-formed decisions', () => {
    const file = hydrateEvolutionFile({
      ...legacyFile(),
      decisions: [
        { id: 'd1', kind: 'optimize', skillName: 'a', action: 'accepted', reason: '', reasonBucket: 'freeform', at: 1 },
        { id: 'd2', kind: 'reclaim', skillName: 'b', action: 'deferred', reason: '观察', reasonBucket: 'observe', at: 2 },
      ],
    })
    expect(file.decisions).toHaveLength(2)
    expect(file.decisions?.[1]?.action).toBe('deferred')
  })

  it('drops malformed decisions', () => {
    const file = hydrateEvolutionFile({
      ...legacyFile(),
      decisions: [
        { id: 'ok', kind: 'new-skill', skillName: 'a', action: 'rejected', reason: '', reasonBucket: 'tooNarrow', at: 1 },
        { id: 'bad-kind', kind: 'bogus', skillName: 'b', action: 'rejected', reason: '', reasonBucket: 'x', at: 2 },
        { id: 'bad-action', kind: 'optimize', skillName: 'c', action: 'nope', reason: '', reasonBucket: 'x', at: 3 },
        { skillName: 'no-id', kind: 'optimize', action: 'accepted', reason: '', reasonBucket: 'x', at: 4 },
        'not-an-object',
      ],
    })
    expect(file.decisions).toHaveLength(1)
    expect(file.decisions?.[0]?.id).toBe('ok')
  })

  it('defaults a missing reasonBucket to freeform', () => {
    const file = hydrateEvolutionFile({
      ...legacyFile(),
      decisions: [{ id: 'd1', kind: 'optimize', skillName: 'a', action: 'rejected', reason: 'x', at: 1 }],
    })
    expect(file.decisions?.[0]?.reasonBucket).toBe('freeform')
  })
})
