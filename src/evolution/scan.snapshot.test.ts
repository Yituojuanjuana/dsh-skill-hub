import { describe, expect, it } from 'vitest'
import { descriptionSnapshot, toOptimizeProposal, toReclaimProposal, type ScannableSkill } from './scan.ts'

describe('技能描述快照', () => {
  it('折叠空白并去掉首尾空格', () => {
    expect(descriptionSnapshot('  第一行\n  第二行  ')).toBe('第一行 第二行')
    expect(descriptionSnapshot('   ')).toBeUndefined()
    expect(descriptionSnapshot(undefined)).toBeUndefined()
  })

  it('超过 160 字按词边界截断，且带省略号', () => {
    const withSpaces = Array.from({ length: 40 }, (_, i) => 'word' + i).join(' ')
    const snap = descriptionSnapshot(withSpaces)
    expect(snap).toBeDefined()
    expect(snap!.length).toBeLessThanOrEqual(161)
    expect(snap!.endsWith('…')).toBe(true)
    // 词边界收尾：省略号直接接在最后一个完整词后面（无尾空格）。
    const body = snap!.slice(0, -1)
    expect(withSpaces.startsWith(body)).toBe(true)
    expect(body.endsWith(' ')).toBe(false)
  })

  it('没有空格时硬切到 160 字', () => {
    const noSpaces = '字'.repeat(200)
    const snap = descriptionSnapshot(noSpaces)
    expect(snap).toBe('字'.repeat(160) + '…')
  })

  it('生成优化/回收提案时写入快照字段', () => {
    const skill: ScannableSkill = {
      name: 'demo',
      description: '用中文写的一段技能描述，帮助理解。',
      body: '## 用法\n\n做点事。',
    }
    const optimize = toOptimizeProposal({ skill, score: 1, hits: [{ dimension: 'coverage', pain: '痛点', evidence: '证据' }] } as never, 1)
    const reclaim = toReclaimProposal(skill, 1)
    expect(optimize.skillSummary).toBe(skill.description)
    expect(optimize.skillSummaryZh).toBe(skill.description)
    expect(reclaim.skillSummary).toBe(skill.description)
    expect(reclaim.skillSummaryZh).toBe(skill.description)
  })

  it('无中文描述不写 skillSummaryZh；无描述整组字段都不写', () => {
    const english = toReclaimProposal({ name: 'demo', description: 'Plain English skill.', body: '' }, 1)
    expect(english.skillSummary).toBe('Plain English skill.')
    expect(english.skillSummaryZh).toBeUndefined()
    const empty = toReclaimProposal({ name: 'demo', description: '', body: '' }, 1)
    expect(empty.skillSummary).toBeUndefined()
    expect(empty.skillSummaryZh).toBeUndefined()
  })
})
