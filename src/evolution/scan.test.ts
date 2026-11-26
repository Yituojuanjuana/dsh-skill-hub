/**
 * 全量技能主动扫描。
 *
 * 与轨迹分析互补：轨迹看「用户用出什么问题」，扫描看「技能本身写得怎样」。
 * 这里锁住 6 个评估维度、过滤条件、上限、以及产出的提案字段完整性。
 */
import { describe, expect, it } from 'vitest'
import { MAX_SCAN_PROPOSALS, MIN_SCAN_DIMENSIONS, scanAll, scanSkill, toOptimizeProposal, type ScannableSkill } from './scan.ts'
import { validateProposal } from './pipeline.ts'

/** 一个「写得很好」的技能：应该几乎不命中维度。 */
const GOOD: ScannableSkill = {
  name: 'good-skill',
  description: 'Use when the user asks for X; produces a fixed report format.',
  body: [
    '## 何时使用',
    '当用户要求 X 时。',
    '**不适用**：Y 场景、Z 场景。',
    '',
    '## 步骤',
    '1. 第一步',
    '2. 第二步',
    '3. 第三步',
    '4. 第四步',
    '',
    '异常处理：任一步失败则回滚并报告。',
    '',
    '## 输出格式',
    '- 固定三段式报告',
    '',
    '## 测试用例',
    '1. 正向：典型场景',
    '2. 边界异常：不相关场景不应触发',
  ].join('\n'),
}

/** 一个「写得很糟」的技能：应命中多个维度。 */
const BAD: ScannableSkill = {
  name: 'bad-skill',
  description: '处理事情',
  body: [
    '读取 E:\\work\\project\\file.ts 的第 42 行，再改 /Users/me/app.ts。',
    '然后随便输出点什么。',
  ].join('\n'),
}

describe('scanSkill dimensions', () => {
  it('finds few problems in a well-written skill', () => {
    expect(scanSkill(GOOD).length).toBeLessThan(MIN_SCAN_DIMENSIONS)
  })

  it('finds many problems in a poorly written skill', () => {
    const hits = scanSkill(BAD)
    expect(hits.length).toBeGreaterThanOrEqual(MIN_SCAN_DIMENSIONS)
    const ids = hits.map((hit) => hit.id)
    expect(ids).toContain('vague-trigger')
    expect(ids).toContain('incomplete-steps')
    expect(ids).toContain('unstructured-output')
    expect(ids).toContain('no-tests')
  })

  it('detects a missing "do not use" clause separately', () => {
    const skill: ScannableSkill = {
      name: 'x',
      description: 'Use when the user asks for X.',
      body: ['## 触发条件', '用户要求 X 时', '## 步骤', '1. a', '2. b', '3. c', '## 输出格式', '固定', '## 测试用例', '正向'].join('\n'),
    }
    const ids = scanSkill(skill).map((hit) => hit.id)
    // 有触发条件但没有「不适用」，仍算触发模糊。
    expect(ids).toContain('vague-trigger')
  })

  it('detects hardcoded paths as poor reusability', () => {
    const hits = scanSkill(BAD)
    const reusability = hits.find((hit) => hit.id === 'poor-reusability')
    expect(reusability?.evidence).toContain('E:\\')
  })

  it('detects a short description as a mismatch', () => {
    const hits = scanSkill(BAD)
    expect(hits.some((hit) => hit.id === 'description-mismatch')).toBe(true)
  })

  it('every hit carries a pain description and evidence', () => {
    for (const hit of scanSkill(BAD)) {
      expect(hit.pain.length).toBeGreaterThan(10)
      expect(typeof hit.evidence).toBe('string')
    }
  })
})

describe('scanAll filtering', () => {
  const many = (count: number): ScannableSkill[] => Array.from({ length: count }, (_, index) => ({
    ...BAD,
    name: `bad-${String(index)}`,
  }))

  it('skips skills in the trash', () => {
    const findings = scanAll([BAD], { trashed: new Set(['bad-skill']) })
    expect(findings).toHaveLength(0)
  })

  it('skips skills optimized within the last 7 days', () => {
    const now = 1_800_000_000_000
    const findings = scanAll([{ ...BAD, optimizedAt: now - 2 * 86_400_000 }], { now })
    expect(findings).toHaveLength(0)
  })

  it('does not skip a skill optimized long ago', () => {
    const now = 1_800_000_000_000
    const findings = scanAll([{ ...BAD, optimizedAt: now - 30 * 86_400_000 }], { now })
    expect(findings).toHaveLength(1)
  })

  it('caps the result at the configured limit', () => {
    const findings = scanAll(many(20), { limit: MAX_SCAN_PROPOSALS })
    expect(findings).toHaveLength(MAX_SCAN_PROPOSALS)
  })

  it('sorts by dimension count desc', () => {
    const findings = scanAll([GOOD, BAD])
    // GOOD 命中不足 2 项会被过滤，只剩 BAD。
    expect(findings).toHaveLength(1)
    expect(findings[0]?.skill.name).toBe('bad-skill')
  })

  it('drops skills below the dimension threshold', () => {
    const findings = scanAll([GOOD])
    expect(findings).toHaveLength(0)
  })
})

describe('toOptimizeProposal', () => {
  const findings = scanAll([BAD], { limit: 1 })
  const proposal = toOptimizeProposal(findings[0]!, 1000)

  it('marks the source as scan', () => {
    expect(proposal.source).toBe('scan')
    expect(proposal.discoveredBy).toBe('scan')
    expect(proposal.kind).toBe('optimize')
  })

  it('carries all five mandatory fields', () => {
    expect((proposal.painPoints ?? '').length).toBeGreaterThan(20)
    expect((proposal.newSource ?? '').length).toBeGreaterThan(20)
    expect((proposal.testCases ?? '').length).toBeGreaterThan(20)
    expect((proposal.riskAssessment ?? '').length).toBeGreaterThan(10)
    expect((proposal.draft ?? '').length).toBeGreaterThan(20)
  })

  it('passes the pipeline field validation', () => {
    // 这一条最关键：扫描产出的提案必须能通过管线校验，否则会被丢弃。
    expect(validateProposal(proposal)).toBeUndefined()
  })

  it('keeps the original body inside the new source', () => {
    expect(proposal.newSource).toContain('E:\\work\\project\\file.ts')
  })

  it('lists each hit in the pain summary', () => {
    for (const hit of findings[0]!.hits) {
      // painPoints 里写的是人类可读的痛点描述（含证据），不是维度 id。
      expect(proposal.painPoints).toContain(hit.pain)
    }
  })

  it('includes positive and boundary test cases', () => {
    expect(proposal.testCases).toContain('正向')
    expect(proposal.testCases).toContain('边界异常')
  })
})
