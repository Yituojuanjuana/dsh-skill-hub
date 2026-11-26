/**
 * 驳回弹窗按提案类型独立适配。
 *
 * 三类提案的驳回语义互不相同，文案不能串用：
 * - 新建推荐 / 细分专项 → 「这个提案不该做」
 * - 优化提案           → 「现在不改」（技能确实有问题，只是不值得动）
 * - 建议回收           → 「不回收，保留该技能」
 */
import { describe, expect, it } from 'vitest'
import { REJECT_CONFIG_NEW, REJECT_CONFIG_OPTIMIZE, REJECT_CONFIG_RECLAIM, rejectConfigFor } from '../client/panel/EvolutionView.tsx'
import { dedupeAgainstRejections } from './dedup.ts'
import { toReclaimProposal } from './scan.ts'
import type { EvolutionProposal, EvolutionRejection } from '../protocol/evolution.ts'

describe('reject config selection', () => {
  it('routes new-skill to the new config', () => {
    expect(rejectConfigFor('new-skill')).toBe(REJECT_CONFIG_NEW)
  })

  it('routes optimize to its own config', () => {
    expect(rejectConfigFor('optimize')).toBe(REJECT_CONFIG_OPTIMIZE)
  })

  it('routes reclaim to the keep-oriented config', () => {
    expect(rejectConfigFor('reclaim')).toBe(REJECT_CONFIG_RECLAIM)
  })

  it('the three configs are all distinct', () => {
    const keys = [REJECT_CONFIG_NEW.defaultKey, REJECT_CONFIG_OPTIMIZE.defaultKey, REJECT_CONFIG_RECLAIM.defaultKey]
    expect(new Set(keys).size).toBe(3)
  })

  it('no quick reason is shared across configs', () => {
    const all = [
      ...REJECT_CONFIG_NEW.quickKeys,
      ...REJECT_CONFIG_OPTIMIZE.quickKeys,
      ...REJECT_CONFIG_RECLAIM.quickKeys,
    ]
    expect(new Set(all).size).toBe(all.length)
  })
})

describe('each config carries exactly three reasons', () => {
  it('new-skill config', () => {
    expect(REJECT_CONFIG_NEW.quickKeys).toEqual([
      'evolution.quickReasonNarrow',
      'evolution.quickReasonCovered',
      'evolution.quickReasonUnstable',
    ])
  })

  it('optimize config', () => {
    expect(REJECT_CONFIG_OPTIMIZE.quickKeys).toEqual([
      'evolution.quickReasonLowPriority',
      'evolution.quickReasonRisky',
      'evolution.quickReasonSufficient',
    ])
  })

  it('reclaim config', () => {
    expect(REJECT_CONFIG_RECLAIM.quickKeys).toEqual([
      'evolution.quickReasonKeep',
      'evolution.quickReasonObserve',
      'evolution.quickReasonStillUseful',
    ])
  })

  it('every config has a non-empty default key', () => {
    for (const config of [REJECT_CONFIG_NEW, REJECT_CONFIG_OPTIMIZE, REJECT_CONFIG_RECLAIM]) {
      expect(config.defaultKey.length).toBeGreaterThan(0)
    }
  })
})

describe('rejection history dedupes per proposal', () => {
  const idle = { name: 'idle-skill', description: '从未被调用', body: '## 步骤\n1. a' }
  const rejection = (skillName: string, reason: string, kind?: 'new-skill' | 'optimize' | 'reclaim'): EvolutionRejection => ({ id: 'r1', skillName, reason, at: 0, ...kind === undefined ? {} : { kind } })

  it('drops a reclaim proposal rejected with a keep reason', () => {
    const proposal = toReclaimProposal(idle, 1)
    const result = dedupeAgainstRejections([proposal], [rejection('idle-skill', '暂不回收，保留该技能', 'reclaim')])
    expect(result.kept).toHaveLength(0)
  })

  it('drops a reclaim proposal rejected with a quick reason', () => {
    const proposal = toReclaimProposal(idle, 1)
    const result = dedupeAgainstRejections([proposal], [rejection('idle-skill', '仍有实际使用价值', 'reclaim')])
    expect(result.kept).toHaveLength(0)
  })

  it('keeps a reclaim proposal for a different skill', () => {
    const proposal = toReclaimProposal(idle, 1)
    const result = dedupeAgainstRejections([proposal], [rejection('other-skill', '暂不回收，保留该技能', 'reclaim')])
    expect(result.kept).toHaveLength(1)
  })

  it('drops an optimize proposal rejected with an optimize reason', () => {
    const proposal: EvolutionProposal = {
      id: 'o1',
      kind: 'optimize',
      skillName: 'some-skill',
      displayName: 'some-skill',
      createdAt: 1,
      status: 'pending',
      changeType: 'modify',
      painPoints: '触发条件模糊，容易误调用',
      newSource: '---\nname: some-skill\n---\n正文',
      testCases: '正向 / 边界异常',
      riskAssessment: '低',
      draft: '---\nname: some-skill\n---\n正文',
    }
    const result = dedupeAgainstRejections([proposal], [rejection('some-skill', '当前版本可用，暂不优化', 'optimize')])
    expect(result.kept).toHaveLength(0)
  })

  it('keeps an optimize proposal when only an unrelated reason was given', () => {
    const proposal: EvolutionProposal = {
      id: 'o2',
      kind: 'optimize',
      skillName: 'some-skill',
      displayName: 'some-skill',
      createdAt: 1,
      status: 'pending',
      changeType: 'modify',
      painPoints: '触发条件模糊，容易误调用',
      newSource: 'x',
      testCases: 'y',
      riskAssessment: 'z',
      draft: 'x',
    }
    // 驳回理由是「场景太细碎」—— 那是新建类的语义，不该拦优化提案。
    const result = dedupeAgainstRejections([proposal], [rejection('some-skill', '场景太细碎，复用性差', 'new-skill')])
    expect(result.kept).toHaveLength(1)
  })

  it('is a no-op with empty history', () => {
    const proposal = toReclaimProposal(idle, 1)
    expect(dedupeAgainstRejections([proposal], []).kept).toHaveLength(1)
  })
})
