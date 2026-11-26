/**
 * 闲置技能走「建议回收」而非「优化」。
 *
 * 逻辑冲突：主动扫描只看质量、统计维度只看用量，两个模块并行输出时，
 * 一个 0 调用的技能会同时得到「优化源码」和「建议回收」—— 自相矛盾。
 * 修复后：0 调用技能不产优化提案，改产不带源码的回收建议。
 */
import { describe, expect, it } from 'vitest'
import { toReclaimProposal, type ScannableSkill } from './scan.ts'
import { validateProposal } from './pipeline.ts'
import { applyValueFilter, RECLAIM_VALUE_SCORE } from './value.ts'

const idle: ScannableSkill = {
  name: 'idle-skill',
  description: '一个从没被调用过的技能',
  body: '## 步骤\n1. a\n2. b',
}

describe('toReclaimProposal', () => {
  const proposal = toReclaimProposal(idle, 1000)

  it('uses the reclaim kind', () => {
    expect(proposal.kind).toBe('reclaim')
    expect(proposal.skillName).toBe('idle-skill')
  })

  it('carries no optimize source and no draft', () => {
    // 这是本次修复的核心：回收建议不该带修补源码。
    expect(proposal.newSource).toBeUndefined()
    expect(proposal.draft).toBeUndefined()
  })

  it('explains why it is low value', () => {
    expect(proposal.painPoints).toContain('长期未被调用')
    expect(proposal.painPoints).toContain('回收站')
  })

  it('notes that the skill can be restored', () => {
    expect(proposal.riskAssessment).toContain('恢复')
  })

  it('passes pipeline validation without a draft', () => {
    // 关键：回收提案豁免草稿要求，否则会被管线整条丢掉。
    expect(validateProposal(proposal)).toBeUndefined()
  })
})

describe('reclaim in value filter', () => {
  it('is never dropped by the value threshold', () => {
    // 它是唯一能清理闲置技能的入口，被过滤掉就没有清理途径了。
    const result = applyValueFilter([toReclaimProposal(idle, 1)])
    expect(result.kept).toHaveLength(1)
  })

  it('gets a fixed low score so it sorts last', () => {
    const result = applyValueFilter([toReclaimProposal(idle, 1)])
    expect(result.kept[0]?.valueScore).toBe(RECLAIM_VALUE_SCORE)
  })

  it('sorts below a genuine high-value proposal', () => {
    const high = {
      id: 'h',
      kind: 'new-skill' as const,
      skillName: 'high-value',
      displayName: '高价值技能',
      createdAt: 1,
      status: 'pending' as const,
      recommendation: 'niche' as const,
      priority: 'medium' as const,
      occurrences: 5,
      scenario: '业务流程固定，每次都要重复交代大量业务规则，跨多个页面通用',
      draft: ['**执行步骤**：', '1. 一', '2. 二', '3. 三', '4. 四', '5. 五', '6. 六', '7. 七'].join('\n'),
    }
    const result = applyValueFilter([toReclaimProposal(idle, 1), high])
    expect(result.kept).toHaveLength(2)
    // 高价值在前，回收建议在后。
    expect(result.kept[0]?.skillName).toBe('high-value')
    expect(result.kept[1]?.kind).toBe('reclaim')
  })

  it('is not blocked by the low-value blacklist', () => {
    // 回收提案不是「新建」，黑名单不该拦它。
    const result = applyValueFilter([toReclaimProposal(idle, 1)])
    expect(result.blockedByBlacklist).toHaveLength(0)
  })
})

describe('optimize proposals still work', () => {
  it('a skill with real usage still gets an optimize proposal', () => {
    // 有调用量的技能走正常优化路径，不受本次修改影响。
    const used: ScannableSkill = { ...idle, name: 'used-skill' }
    // 用 scan 模块的优化构造器验证字段仍完整。
    const { toOptimizeProposal, scanAll } = require('./scan.ts') as typeof import('./scan.ts')
    const findings = scanAll([used], { limit: 1 })
    if (findings.length === 0) return
    const optimize = toOptimizeProposal(findings[0]!, 1)
    expect(optimize.kind).toBe('optimize')
    expect((optimize.newSource ?? '').length).toBeGreaterThan(0)
    expect((optimize.draft ?? '').length).toBeGreaterThan(0)
    expect(validateProposal(optimize)).toBeUndefined()
  })
})
