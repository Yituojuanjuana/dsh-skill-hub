/** skills.sh 结果排序：三档语义不同（截断 / 全量同序 / 全量按名），且都要稳定。 */
import { describe, expect, it } from 'vitest'
import { SKILLS_SH_TOP_N, sortSkillsSh } from './market-format.ts'

interface Entry { name: string; installs?: number }

function entry(name: string, installs?: number): Entry {
  return installs === undefined ? { name } : { name, installs }
}

describe('sortSkillsSh', () => {
  it('sorts by installs high to low and keeps only the top 20', () => {
    const many = Array.from({ length: 30 }, (_, index) => entry('s' + String(index), index))
    const sorted = sortSkillsSh(many, 'installs')
    expect(sorted).toHaveLength(SKILLS_SH_TOP_N)
    expect(sorted[0]).toEqual(entry('s29', 29))
    expect(sorted[SKILLS_SH_TOP_N - 1]).toEqual(entry('s10', 10))
  })

  it('puts entries without installs last instead of treating them as zero', () => {
    const sorted = sortSkillsSh([entry('none'), entry('two', 2), entry('zero', 0)], 'installs')
    expect(sorted.map((item) => item.name)).toEqual(['two', 'zero', 'none'])
  })

  it('sorts A-Z by name and keeps every result', () => {
    const many = Array.from({ length: 30 }, (_, index) => entry('s' + String(index), 30 - index))
    const sorted = sortSkillsSh(many, 'az')
    expect(sorted).toHaveLength(30)
    expect(sorted[0]?.name).toBe('s0')
    expect(sorted[29]?.name).toBe('s9')
  })

  it('does not mutate the input array', () => {
    const input = [entry('b', 1), entry('a', 2)]
    sortSkillsSh(input, 'az')
    expect(input.map((item) => item.name)).toEqual(['b', 'a'])
  })

  // ---- 「全部」：与 installs 同一排序，但不截断 --------------------------------

  it('all keeps every result (25 in, 25 out) instead of truncating', () => {
    const many = Array.from({ length: 25 }, (_, index) => entry('s' + String(index), index))
    const sorted = sortSkillsSh(many, 'all')
    expect(sorted).toHaveLength(25)
  })

  it('all is still sorted by installs descending, not left in input order', () => {
    // 故意给一个乱序输入：若实现退化成「不排序」，这里会失败。
    const shuffled = [entry('low', 1), entry('high', 99), entry('mid', 50)]
    const sorted = sortSkillsSh(shuffled, 'all')
    expect(sorted.map((item) => item.name)).toEqual(['high', 'mid', 'low'])
  })

  it('all puts entries without installs last', () => {
    const sorted = sortSkillsSh([entry('none'), entry('two', 2), entry('none2'), entry('zero', 0)], 'all')
    expect(sorted.map((item) => item.name)).toEqual(['two', 'zero', 'none', 'none2'])
  })

  it('all and installs agree on the first N entries', () => {
    // 同一排序口径、只差截断：前 N 条必须完全一致。
    const many = Array.from({ length: 30 }, (_, index) => entry('s' + String(index), index))
    const top = sortSkillsSh(many, 'installs')
    const all = sortSkillsSh(many, 'all')
    expect(all.slice(0, SKILLS_SH_TOP_N).map((item) => item.name)).toEqual(top.map((item) => item.name))
  })
})
