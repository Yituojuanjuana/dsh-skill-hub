/** skills.sh 结果排序：两档语义不同（截断 vs 全量），且都要稳定。 */
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
})
