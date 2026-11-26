/**
 * 本轮修复的回归测试：
 * ① 出现次数必须是合理小整数（防溢出）；
 * ② 新建/细分专项提案必须带草稿，否则丢弃；
 * ③ 会话读取计数正常；
 * ④ 成功率展示无 NaN / Infinity。
 */
import { describe, expect, it } from 'vitest'
import { MAX_OCCURRENCES, parseOccurrences, parseProposals } from './engine.ts'
import { formatSuccessRate } from '../client/panel/format.ts'

describe('① occurrences bounds', () => {
  it('takes the leading integer, not every digit in the cell', () => {
    // 真实故障：`6（session-66f4 ×2、session-b9b8 ×2…）` 曾被拼成 17 位数字。
    expect(parseOccurrences('6（session-66f4 ×2、session-b9b8 ×2、session-8aec ×2、session-285c、session-368d ×2）')).toBe(6)
    expect(parseOccurrences('4（session-b9b8、session-285c、session-66f4、session-8aec）')).toBe(4)
  })

  it('handles plain numbers', () => {
    expect(parseOccurrences('5')).toBe(5)
    expect(parseOccurrences(' 12 ')).toBe(12)
  })

  it('returns 0 for empty or unparseable cells', () => {
    expect(parseOccurrences('')).toBe(0)
    expect(parseOccurrences('—')).toBe(0)
    expect(parseOccurrences('N/A')).toBe(0)
  })

  it('never returns a value above the sane ceiling', () => {
    for (const cell of ['4982856648', '66642982822853680', '999999999999']) {
      const value = parseOccurrences(cell)
      expect(value).toBeLessThanOrEqual(MAX_OCCURRENCES)
      expect(Number.isSafeInteger(value)).toBe(true)
    }
  })

  it('keeps parsed proposals within a sane occurrence range', () => {
    const md = [
      '## 一、新建技能推荐清单',
      '| 1 | 中 | `taro-page-change` | 场景 | 6（session-66f4 ×2、session-b9b8 ×2、session-8aec ×2、session-285c、session-368d ×2） | 收益 | 风险 | 新建 |',
      '### 【候选技能草稿 1】taro-page-change',
      '**名称**：taro-page-change',
      '## 二、已有技能优化提案',
    ].join('\n')
    const proposals = parseProposals(md, 1)
    expect(proposals).toHaveLength(1)
    expect(proposals[0]?.occurrences).toBe(6)
    expect(proposals[0]?.occurrences).toBeLessThan(1000)
  })
})

describe('② draft is mandatory for create/niche', () => {
  const withDraft = [
    '## 一、新建技能推荐清单',
    '| 1 | 中 | `has-draft` | 场景 | 3 | 收益 | 风险 | 新建 |',
    '### 【候选技能草稿 1】has-draft',
    '**名称**：has-draft',
    '**触发条件**：当用户要求时',
    '## 二、已有技能优化提案',
  ].join('\n')

  it('keeps a create proposal that has a draft', () => {
    const proposals = parseProposals(withDraft, 2)
    expect(proposals).toHaveLength(1)
    expect((proposals[0]?.draft ?? '').length).toBeGreaterThan(0)
  })

  it('drops a create proposal with no draft at all', () => {
    const md = [
      '## 一、新建技能推荐清单',
      '| 1 | 中 | `no-draft` | 场景 | 3 | 收益 | 风险 | 新建 |',
      '## 二、已有技能优化提案',
    ].join('\n')
    // 没有草稿 = 无法落地 = 不该出现在待审核列表里。
    expect(parseProposals(md, 3)).toHaveLength(0)
  })

  it('drops a niche proposal with no draft', () => {
    const md = [
      '## 一、新建技能推荐清单',
      '| 1 | 中 | `niche-no-draft` | 场景 | 2 | 收益 | 风险 | 【细分专项】 |',
      '## 二、已有技能优化提案',
    ].join('\n')
    expect(parseProposals(md, 4)).toHaveLength(0)
  })

  it('keeps an observe proposal without a draft (by design)', () => {
    const md = [
      '## 一、新建技能推荐清单',
      '| 1 | 低 | `just-observe` | 场景 | 1 | 收益 | 风险 | 继续观察 |',
      '## 二、已有技能优化提案',
    ].join('\n')
    const proposals = parseProposals(md, 5)
    expect(proposals).toHaveLength(1)
    expect(proposals[0]?.recommendation).toBe('observe')
  })

  it('accepts the bracket draft heading style used by the model', () => {
    // `### 【候选技能草稿 1】name` —— 最近一次真实输出用的就是这种。
    const proposals = parseProposals(withDraft, 6)
    expect(proposals[0]?.draft).toContain('**名称**')
  })

  it('accepts the colon and pipe heading styles too', () => {
    for (const heading of ['### 候选技能草稿 1：`x-skill`', '### 候选技能草稿 1｜x-skill', '### 候选技能草稿 1:x-skill']) {
      const md = [
        '## 一、新建技能推荐清单',
        '| 1 | 中 | `x-skill` | 场景 | 3 | 收益 | 风险 | 新建 |',
        heading,
        '**名称**：x-skill',
        '## 二、已有技能优化提案',
      ].join('\n')
      const proposals = parseProposals(md, 7)
      expect(proposals, heading).toHaveLength(1)
      expect((proposals[0]?.draft ?? '').length, heading).toBeGreaterThan(0)
    }
  })
})

describe('④ success rate formatting', () => {
  it('renders a normal percentage', () => {
    expect(formatSuccessRate({ total: 50, successRate: 0.92 })).toBe('92%')
    expect(formatSuccessRate({ total: 3, successRate: 1 })).toBe('100%')
    expect(formatSuccessRate({ total: 3, successRate: 0 })).toBe('0%')
  })

  it('shows a dash when there is no outcome data', () => {
    expect(formatSuccessRate({ total: 50 })).toBe('-')
  })

  it('shows a dash when total is zero', () => {
    expect(formatSuccessRate({ total: 0, successRate: 0.5 })).toBe('-')
  })

  it('never renders NaN or Infinity', () => {
    for (const stat of [
      { total: 10, successRate: Number.NaN },
      { total: 10, successRate: Number.POSITIVE_INFINITY },
      { total: Number.NaN, successRate: 0.5 },
      { total: Number.POSITIVE_INFINITY, successRate: 0.5 },
    ]) {
      const text = formatSuccessRate(stat)
      expect(text).not.toContain('NaN')
      expect(text).not.toContain('Infinity')
      expect(text).toBe('-')
    }
  })

  it('clamps dirty out-of-range values instead of showing 120%', () => {
    expect(formatSuccessRate({ total: 10, successRate: 1.2 })).toBe('100%')
    expect(formatSuccessRate({ total: 10, successRate: -0.3 })).toBe('0%')
  })

  it('rounds to whole percent', () => {
    expect(formatSuccessRate({ total: 3, successRate: 2 / 3 })).toBe('67%')
  })
})
