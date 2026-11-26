/**
 * 四维联合评估：统计维度 + 驳回去重。
 *
 * 这一层回答「现有技能活得怎么样」：高调用高成功率该拆分沉淀，高调用低成功率
 * 该修不该拆，长期 0 调用该回收，已在回收站的跳过。再加驳回去重，防止同场景
 * 同理由的提案反复推送。
 */
import { describe, expect, it } from 'vitest'
import { applyMetricRules, attachMetrics, judgeByMetrics, METRIC_THRESHOLDS, type SkillUsageRow, type TrashRow } from './metrics.ts'
import { dedupeAgainstRejections, jaccard, tokenize } from './dedup.ts'
import type { EvolutionProposal } from '../protocol/evolution.ts'

const NOW = 1_800_000_000_000

const proposal = (name: string, overrides: Partial<EvolutionProposal> = {}): EvolutionProposal => ({
  id: 'p-' + name,
  kind: 'new-skill',
  skillName: name,
  createdAt: NOW,
  status: 'pending',
  recommendation: 'create',
  ...overrides,
})

describe('judgeByMetrics', () => {
  it('flags a skill that was never called as stale', () => {
    const judged = judgeByMetrics({ name: 'x', total: 0, week: 0 }, undefined, NOW)
    expect(judged.verdict).toBe('stale')
    expect(judged.reason).toContain('建议移入回收站')
  })

  it('flags a long-unused skill as stale even with historical calls', () => {
    const judged = judgeByMetrics({ name: 'x', total: 50, week: 0, lastUsed: NOW - 60 * 86_400_000 }, undefined, NOW)
    expect(judged.verdict).toBe('stale')
  })

  it('flags high calls + high success as worth splitting', () => {
    const judged = judgeByMetrics({ name: 'x', total: 50, week: 10, successRate: 0.95, lastUsed: NOW }, undefined, NOW)
    expect(judged.verdict).toBe('high-ok')
    expect(judged.reason).toContain('拆分细分专项')
  })

  it('flags high calls + low success as worth fixing', () => {
    const judged = judgeByMetrics({ name: 'x', total: 50, week: 10, successRate: 0.4, lastUsed: NOW }, undefined, NOW)
    expect(judged.verdict).toBe('high-fail')
    expect(judged.reason).toContain('优化重构')
  })

  it('skips a trashed skill', () => {
    const trash: TrashRow = { name: 'x', movedAt: NOW - 1000 }
    const judged = judgeByMetrics({ name: 'x', total: 5, week: 0, lastUsed: NOW - 2000 }, trash, NOW)
    expect(judged.verdict).toBe('in-trash')
  })

  it('suggests recovery when a trashed skill is called again', () => {
    const trash: TrashRow = { name: 'x', movedAt: NOW - 10_000 }
    const judged = judgeByMetrics({ name: 'x', total: 5, week: 2, lastUsed: NOW }, trash, NOW)
    expect(judged.verdict).toBe('trash-recover')
    expect(judged.reason).toContain('恢复')
  })

  it('does not treat an unknown success rate as 0%', () => {
    // 没有成功率样本时不该落到 high-fail。
    const judged = judgeByMetrics({ name: 'x', total: 100, week: 5, lastUsed: NOW }, undefined, NOW)
    expect(judged.verdict).toBe('normal')
  })

  it('respects the configured thresholds', () => {
    const justBelow = judgeByMetrics({ name: 'x', total: METRIC_THRESHOLDS.highCalls - 1, week: 5, successRate: 0.99, lastUsed: NOW }, undefined, NOW)
    expect(justBelow.verdict).toBe('normal')
    const atThreshold = judgeByMetrics({ name: 'x', total: METRIC_THRESHOLDS.highCalls, week: 5, successRate: 0.99, lastUsed: NOW }, undefined, NOW)
    expect(atThreshold.verdict).toBe('high-ok')
  })
})

describe('attachMetrics', () => {
  it('attaches usage, success rate and trash state to each proposal', () => {
    const usage = new Map<string, SkillUsageRow>([
      ['alpha', { name: 'alpha', total: 42, week: 7, successRate: 0.93, lastUsed: NOW }],
    ])
    const trash = new Map<string, TrashRow>([['beta', { name: 'beta', movedAt: NOW - 5000, note: '长期无人使用' }]])
    const out = attachMetrics([proposal('alpha'), proposal('beta')], usage, trash, NOW)

    expect(out[0]?.metrics?.totalCalls).toBe(42)
    expect(out[0]?.metrics?.weekCalls).toBe(7)
    expect(out[0]?.metrics?.successRate).toBe(0.93)
    expect(out[0]?.metrics?.reason).toContain('拆分细分专项')

    expect(out[1]?.metrics?.inTrash).toBe(true)
    expect(out[1]?.metrics?.trashedAt).toBe(NOW - 5000)
    expect(out[1]?.metrics?.trashNote).toBe('长期无人使用')
    expect(out[1]?.metrics?.reason).toContain('回收站')
  })

  it('leaves metrics empty-ish for an unknown skill', () => {
    const out = attachMetrics([proposal('unknown')], new Map(), new Map(), NOW)
    expect(out[0]?.metrics?.totalCalls).toBeUndefined()
    expect(out[0]?.metrics?.inTrash).toBeUndefined()
    expect(out[0]?.metrics?.reason).toBeDefined()
  })
})

describe('applyMetricRules', () => {
  it('drops proposals for skills already in the trash', () => {
    const usage = new Map<string, SkillUsageRow>()
    const trash = new Map<string, TrashRow>([['gone', { name: 'gone', movedAt: NOW - 1000 }]])
    const attached = attachMetrics([proposal('gone')], usage, trash, NOW)
    const out = applyMetricRules(attached, NOW)
    expect(out).toHaveLength(0)
  })

  it('does NOT downgrade a new-skill proposal for a never-used skill', () => {
    // 逻辑冲突修复：新建提案指向的技能还没落地，0 调用是必然的。
    // 不能因此把它降级成 observe，更不能建议「移入回收站」。
    const usage = new Map<string, SkillUsageRow>([['dead', { name: 'dead', total: 0, week: 0 }]])
    const attached = attachMetrics([proposal('dead')], usage, new Map(), NOW)
    const out = applyMetricRules(attached, NOW)
    expect(out).toHaveLength(1)
    expect(out[0]?.recommendation).toBe('create')
    expect(out[0]?.metrics?.reason).toContain('尚未落地')
    expect(out[0]?.metrics?.reason).not.toContain('移入回收站')
  })

  it('still advises trashing an existing skill that was never used', () => {
    // 已有技能的优化提案保留原逻辑：0 调用 = 低价值 = 建议回收。
    const usage = new Map<string, SkillUsageRow>([['dead', { name: 'dead', total: 0, week: 0 }]])
    const attached = attachMetrics([proposal('dead', { kind: 'optimize' })], usage, new Map(), NOW)
    const out = applyMetricRules(attached, NOW)
    expect(out).toHaveLength(1)
    expect(out[0]?.metrics?.reason).toContain('建议移入回收站')
  })

  it('keeps proposals for healthy skills untouched', () => {
    const usage = new Map<string, SkillUsageRow>([['ok', { name: 'ok', total: 30, week: 5, successRate: 0.95, lastUsed: NOW }]])
    const attached = attachMetrics([proposal('ok')], usage, new Map(), NOW)
    const out = applyMetricRules(attached, NOW)
    expect(out).toHaveLength(1)
    expect(out[0]?.recommendation).toBe('create')
  })
})

describe('dedup', () => {
  it('tokenizes Chinese into 2-char windows and keeps English words', () => {
    const tokens = tokenize('流程不稳定 taro-weapp')
    expect(tokens.has('流程')).toBe(true)
    expect(tokens.has('不稳')).toBe(true)
    expect(tokens.has('taro')).toBe(true)
  })

  it('jaccard is 0 for empty sets', () => {
    expect(jaccard(new Set(), new Set(['a']))).toBe(0)
  })

  it('drops a proposal whose skill and reason match a past rejection', () => {
    const proposals = [proposal('taro-page-change', { scenario: '业务流程不稳定，无法写固定触发规则' })]
    const rejections = [{ id: 'r1', skillName: 'taro-page-change', reason: '流程不稳定，写不出固定触发规则', at: 0 }]
    const result = dedupeAgainstRejections(proposals, rejections)
    expect(result.kept).toHaveLength(0)
    expect(result.dropped).toHaveLength(1)
    expect(result.dropped[0]?.matchedRejection).toBe('taro-page-change')
  })

  it('keeps a new proposal for the same skill with a different approach', () => {
    // 同一技能，但换了一个思路 —— 必须放行，否则用户永远无法提出第二种解法。
    const proposals = [proposal('taro-page-change', { scenario: '把校验步骤抽成独立脚本，减少人工核对' })]
    const rejections = [{ id: 'r1', skillName: 'taro-page-change', reason: '流程不稳定，写不出固定触发规则', at: 0 }]
    const result = dedupeAgainstRejections(proposals, rejections)
    expect(result.kept).toHaveLength(1)
  })

  it('keeps a proposal for a different skill even with a similar reason', () => {
    const proposals = [proposal('other-skill', { scenario: '流程不稳定，写不出固定触发规则' })]
    const rejections = [{ id: 'r1', skillName: 'taro-page-change', reason: '流程不稳定，写不出固定触发规则', at: 0 }]
    const result = dedupeAgainstRejections(proposals, rejections)
    expect(result.kept).toHaveLength(1)
  })

  it('is a no-op when there is no rejection history', () => {
    const proposals = [proposal('a'), proposal('b')]
    const result = dedupeAgainstRejections(proposals, [])
    expect(result.kept).toHaveLength(2)
    expect(result.dropped).toHaveLength(0)
  })
})

describe('judgeByMetrics by proposal kind', () => {
  it('says "not landed yet" for a new-skill proposal with no calls', () => {
    const judged = judgeByMetrics({ name: 'x', total: 0, week: 0 }, undefined, NOW, 'new-skill')
    expect(judged.verdict).toBe('new-pending')
    expect(judged.reason).toContain('尚未落地')
    expect(judged.reason).toContain('暂无调用记录')
    expect(judged.reason).not.toContain('回收站')
    expect(judged.reason).not.toContain('低价值')
  })

  it('keeps the low-value verdict for an optimize proposal with no calls', () => {
    const judged = judgeByMetrics({ name: 'x', total: 0, week: 0 }, undefined, NOW, 'optimize')
    expect(judged.verdict).toBe('stale')
    expect(judged.reason).toContain('建议移入回收站')
  })

  it('keeps the low-value verdict when kind is omitted (backward compatible)', () => {
    const judged = judgeByMetrics({ name: 'x', total: 0, week: 0 }, undefined, NOW)
    expect(judged.verdict).toBe('stale')
  })

  it('still reports high-ok for a new-skill proposal that somehow has calls', () => {
    // 新建提案但已有同名调用（历史上落地过同名技能）：走正常指标判定。
    const judged = judgeByMetrics({ name: 'x', total: 50, week: 5, successRate: 0.95, lastUsed: NOW }, undefined, NOW, 'new-skill')
    expect(judged.verdict).toBe('high-ok')
  })

  it('still skips a trashed skill regardless of kind', () => {
    const trash = { name: 'x', movedAt: NOW - 1000 }
    expect(judgeByMetrics({ name: 'x', total: 0, week: 0 }, trash, NOW, 'new-skill').verdict).toBe('in-trash')
    expect(judgeByMetrics({ name: 'x', total: 0, week: 0 }, trash, NOW, 'optimize').verdict).toBe('in-trash')
  })

  it('keeps the stats visible even when the reason changes', () => {
    // 要求：统计面板照常展示 0 次，只是理由文案不同。
    const usage = new Map<string, SkillUsageRow>([['fresh', { name: 'fresh', total: 0, week: 0 }]])
    const out = attachMetrics([proposal('fresh')], usage, new Map(), NOW)
    expect(out[0]?.metrics?.totalCalls).toBe(0)
    expect(out[0]?.metrics?.weekCalls).toBe(0)
    expect(out[0]?.metrics?.reason).toContain('尚未落地')
  })
})