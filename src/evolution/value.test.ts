/**
 * 技能价值评分与低价值黑名单。
 *
 * 目标：把「构建后看 dist 在不在」「改个 padding」这类细碎场景挡在待审核之外，
 * 只留下流程固定、复用性强、业务规则多的提案。
 */
import { describe, expect, it } from 'vitest'
import { applyValueFilter, blacklistHit, countSteps, LOW_VALUE_SCORE, MIN_VALUE_SCORE, scoreProposal } from './value.ts'
import type { EvolutionProposal } from '../protocol/evolution.ts'

const draft = (steps: number): string => [
  '**名称**：demo',
  '**触发条件**：用户要求时',
  '**执行步骤**：',
  ...Array.from({ length: steps }, (_, index) => `${String(index + 1)}. 第 ${String(index + 1)} 步操作`),
].join('\n')

const proposal = (overrides: Partial<EvolutionProposal> = {}): EvolutionProposal => ({
  id: 'p1',
  kind: 'new-skill',
  skillName: 'demo-skill',
  displayName: '演示技能',
  createdAt: 1,
  status: 'pending',
  recommendation: 'create',
  priority: 'medium',
  occurrences: 5,
  scenario: '业务流程固定，每次都要重复交代大量业务规范',
  draft: draft(6),
  ...overrides,
})

describe('countSteps', () => {
  it('counts numbered steps', () => {
    expect(countSteps(draft(7))).toBe(7)
    expect(countSteps(draft(3))).toBe(3)
  })

  it('returns 0 for a draft with no steps', () => {
    expect(countSteps('**名称**：x')).toBe(0)
  })
})

describe('blacklist', () => {
  it('blocks a build/dist existence check', () => {
    const hit = blacklistHit(proposal({
      scenario: '构建后确认 dist 产物存在',
      draft: '**触发条件**：改完代码后确认 dist 里有新文件',
      benefit: '验证产物存在',
    }))
    expect(hit?.id).toBe('build-verify')
  })

  it('blocks a single style tweak', () => {
    const hit = blacklistHit(proposal({
      scenario: '微调 padding 和圆角，像素级对齐',
      benefit: '改一下间距',
    }))
    expect(hit?.id).toBe('single-style-tweak')
  })

  it('blocks a one-off debug session', () => {
    const hit = blacklistHit(proposal({
      scenario: '临时排查环境问题，一次性定位',
      benefit: '排查偶发错误',
    }))
    expect(hit?.id).toBe('one-off-debug')
  })

  it('blocks a flow explicitly described as unstable', () => {
    const hit = blacklistHit(proposal({
      scenario: '流程不稳定，每次都不一样',
      benefit: '无固定流程',
    }))
    expect(hit?.id).toBe('unstable-flow')
  })

  it('does NOT block a genuine business skill', () => {
    // 提到业务规则/字段/流程的构建验证不拦 —— 那是真的业务闭环。
    const hit = blacklistHit(proposal({
      scenario: 'sports-coach 游泳馆排课的字段规则校验与产物核验，流程固定',
      benefit: '免去每次重复交代业务规范',
    }))
    expect(hit).toBeUndefined()
  })

  it('never blocks optimize proposals', () => {
    const hit = blacklistHit(proposal({
      kind: 'optimize',
      scenario: '构建后确认 dist 产物存在',
    }))
    expect(hit).toBeUndefined()
  })
})

describe('scoreProposal', () => {
  it('scores a high-value business skill above the threshold', () => {
    const scored = scoreProposal(proposal({
      scenario: '业务流程固定，每次都要重复交代大量专属业务规则，跨多个页面通用',
      draft: draft(7),
      recommendation: 'niche',
    }))
    expect(scored.score).toBeGreaterThanOrEqual(MIN_VALUE_SCORE)
    expect(scored.positives.length).toBeGreaterThan(2)
  })

  it('scores a tiny 2-step task below the threshold', () => {
    const scored = scoreProposal(proposal({
      scenario: '临时试一下，单个页面单次改动',
      draft: draft(2),
    }))
    expect(scored.score).toBeLessThan(MIN_VALUE_SCORE)
    expect(scored.belowThreshold).toBe(true)
  })

  it('marks 60~75 as low value', () => {
    const scored = scoreProposal(proposal({
      scenario: '业务流程固定',
      draft: draft(5),
    }))
    expect(scored.score).toBeGreaterThanOrEqual(MIN_VALUE_SCORE)
    if (scored.score < LOW_VALUE_SCORE) expect(scored.lowValue).toBe(true)
  })

  it('never exceeds 100 or drops below 0', () => {
    const high = scoreProposal(proposal({
      scenario: '业务流程固定 每次都要重复交代大量业务规则 跨多个页面通用',
      draft: draft(10),
      recommendation: 'niche',
    }))
    expect(high.score).toBeLessThanOrEqual(100)
    const low = scoreProposal(proposal({
      scenario: '临时 一次性 单个页面 单次改动 依赖具体文件路径 src/a/b.tsx 第 12 行',
      draft: draft(2),
    }))
    expect(low.score).toBeGreaterThanOrEqual(0)
  })

  it('gives niche proposals a business-specific bonus', () => {
    const base = proposal({ scenario: '业务流程固定', draft: draft(6) })
    const niche = { ...base, recommendation: 'niche' as const }
    expect(scoreProposal(niche).score).toBeGreaterThan(scoreProposal(base).score)
  })
})

describe('applyValueFilter', () => {
  it('drops blacklisted proposals and records the reason', () => {
    const result = applyValueFilter([
      proposal({ skillName: 'dist-check', scenario: '构建后确认 dist 产物存在', benefit: '验证产物' }),
    ])
    expect(result.kept).toHaveLength(0)
    expect(result.blockedByBlacklist[0]?.reason).toContain('构建验证')
  })

  it('drops below-threshold proposals', () => {
    const result = applyValueFilter([
      proposal({ skillName: 'tiny', scenario: '临时试一下单个页面单次改动', draft: draft(2) }),
    ])
    expect(result.kept).toHaveLength(0)
    expect(result.belowThreshold[0]?.score).toBeLessThan(MIN_VALUE_SCORE)
  })

  it('keeps high-value proposals and sorts them by score desc', () => {
    const result = applyValueFilter([
      proposal({ id: 'a', skillName: 'a-skill', scenario: '业务流程固定', draft: draft(5) }),
      proposal({ id: 'b', skillName: 'b-skill', scenario: '业务流程固定 每次都要重复交代大量业务规则 跨多个页面通用', draft: draft(8), recommendation: 'niche' }),
    ])
    expect(result.kept.length).toBeGreaterThanOrEqual(1)
    // 分数降序：第一条的分数不低于第二条。
    for (let index = 1; index < result.kept.length; index += 1) {
      expect((result.kept[index - 1]?.valueScore ?? 0)).toBeGreaterThanOrEqual(result.kept[index]?.valueScore ?? 0)
    }
  })

  it('attaches valueScore to every kept proposal', () => {
    const result = applyValueFilter([proposal({ scenario: '业务流程固定', draft: draft(6) })])
    for (const item of result.kept) expect(typeof item.valueScore).toBe('number')
  })

  it('is a no-op on an empty list', () => {
    const result = applyValueFilter([])
    expect(result.kept).toEqual([])
    expect(result.blockedByBlacklist).toEqual([])
    expect(result.belowThreshold).toEqual([])
  })
})
