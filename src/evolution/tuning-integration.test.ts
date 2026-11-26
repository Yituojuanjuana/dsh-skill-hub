/**
 * 集成：自适应参数真的改变了提案过滤结果。
 *
 * 单测 `tuning.test.ts` 只验证「算出来的数字对不对」；这里验证「算出来的数字
 * 有没有被管线用上」—— 两者之间断链是最隐蔽的失败模式（参数变了但没人读）。
 */
import { describe, expect, it } from 'vitest'
import { runPipeline } from './pipeline.ts'
import { scoreProposal, applyValueFilter } from './value.ts'
import { computeTuning, defaultTuning, MIN_DECISIONS_BETWEEN_ADJUST, TUNING_DEFAULTS, type EvolutionDecision } from './tuning.ts'
import type { EvolutionProposal } from '../protocol/evolution.ts'

/** 造一条价值分大致落在 65 的提案（业务味中等、步骤 4 步）。 */
function midValueProposal(name: string): EvolutionProposal {
  return {
    id: 'p-' + name,
    kind: 'new-skill',
    skillName: name,
    displayName: name,
    createdAt: 1,
    status: 'pending',
    recommendation: 'create',
    priority: 'medium',
    occurrences: 4,
    // 这条 scenario 让分数正好落在 65（跨页面 +15，4 步不触发加分也不触发减分）。
    scenario: '跨多个页面',
    draft: ['**执行步骤**：', '1. 一', '2. 二', '3. 三', '4. 四'].join('\n'),
  }
}

/** 造 n 条 new-skill 驳回裁决（tooNarrow），用于把门槛推上去。 */
function narrowRejections(n: number): EvolutionDecision[] {
  return Array.from({ length: n }, (_, i) => ({
    id: 'd' + String(i),
    kind: 'new-skill' as const,
    skillName: 'x',
    action: 'rejected' as const,
    reason: '场景太细碎，复用性差',
    reasonBucket: 'tooNarrow' as const,
    at: i,
  }))
}

/** 反复校准，直到门槛越过某值或轮数用尽。 */
function tuneUntil(target: number): { minValueScore: number } {
  const decisions = narrowRejections(20)
  let state = defaultTuning()
  for (let round = 0; round < 30; round++) {
    for (let i = 0; i < MIN_DECISIONS_BETWEEN_ADJUST; i++) {
      decisions.push({
        id: 'e' + String(round) + '-' + String(i),
        kind: 'new-skill',
        skillName: 'x',
        action: 'rejected',
        reason: '场景太细碎，复用性差',
        reasonBucket: 'tooNarrow',
        at: 1000 + round * 10 + i,
      })
    }
    const out = computeTuning({ decisions, current: state })
    state = { ...state, params: out.params, adjustedAt: out.adjustedAt }
    if (state.params.minValueScore >= target) break
  }
  return { minValueScore: state.params.minValueScore }
}

describe('集成：门槛被校准抬高后，中价值提案确实被过滤', () => {
  it('a score-65 proposal disappears once the gate reaches 68', () => {
    const proposal = midValueProposal('mid-value-skill')
    const base = scoreProposal(proposal)
    // 前置条件：这条提案的分数必须落在「默认通过、抬高后被拦」的区间。
    expect(base.score).toBeGreaterThanOrEqual(TUNING_DEFAULTS.minValueScore)
    expect(base.score).toBeLessThan(68)

    // 默认门槛下保留。
    const before = applyValueFilter([proposal])
    expect(before.kept.map((p) => p.skillName)).toContain('mid-value-skill')

    // 校准把门槛推到 68 后丢弃。
    const tuned = tuneUntil(68)
    expect(tuned.minValueScore).toBeGreaterThanOrEqual(68)
    const after = applyValueFilter([proposal], tuned.minValueScore)
    expect(after.kept).toHaveLength(0)
    expect(after.belowThreshold.map((item) => item.skillName)).toContain('mid-value-skill')
  })

  it('pipeline honours the tuned gate end to end', () => {
    // 走完整管线：给一段只含一条中价值提案的模型输出。
    const markdown = [
      '# 技能进化提案汇总',
      '## 一、新建技能推荐清单',
      '序号｜优先级｜技能名称｜适用场景｜出现次数｜收益｜潜在风险｜建议',
      '1｜中｜mid-value-skill｜跨多个页面｜4｜省事｜无｜新建',
      '> 【候选技能草稿】',
      '名称：mid-value-skill',
      '描述：跨多个页面',
      '触发条件：用户要求时',
      '执行步骤：',
      '1. 一',
      '2. 二',
      '3. 三',
      '4. 四',
      '## 二、已有技能优化提案',
    ].join('\n')

    const sources = { usage: [], trash: [], rejections: [] }
    const withDefault = runPipeline(markdown, sources, 1)
    expect(withDefault.proposals.map((p) => p.skillName)).toContain('mid-value-skill')

    const tuned = tuneUntil(68)
    const withTuned = runPipeline(markdown, sources, 1, [], { minValueScore: tuned.minValueScore })
    expect(withTuned.proposals.map((p) => p.skillName)).not.toContain('mid-value-skill')
    expect(withTuned.droppedLowValue.map((item) => item.skillName)).toContain('mid-value-skill')
  })
})

describe('集成：校准不会碰落地路径', () => {
  it('computeTuning never returns proposals or file paths', () => {
    const out = computeTuning({ decisions: narrowRejections(20), current: defaultTuning() })
    // 输出只有参数、改动清单、统计、防抖水位 —— 没有任何提案或路径字段。
    expect(Object.keys(out).sort()).toEqual(['adjustedAt', 'applied', 'basis', 'params'])
    const serialized = JSON.stringify(out)
    expect(serialized).not.toContain('skills/')
    expect(serialized).not.toContain('SKILL.md')
    expect(serialized).not.toContain('applyProposal')
  })
})
