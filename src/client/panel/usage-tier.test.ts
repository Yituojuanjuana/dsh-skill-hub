/** 按调用量分档：验证分档边界与空档裁剪。 */
import { describe, expect, it } from 'vitest'
import type { CatalogSkill, PermanentStat } from '../../protocol.ts'
import { groupByUsage } from './UsageView.tsx'

const skill = (name: string): CatalogSkill => ({
  name,
  description: 'd',
  source: 'user-dsh',
  provider: 'skill-hub',
  invocation: { modelInvocable: true, userInvocable: true },
  writable: true,
})

const stat = (name: string, total: number): PermanentStat => ({ name, today: 0, week: 0, total, lastUsed: 0 })

describe('groupByUsage', () => {
  it('buckets skills by total call count', () => {
    const skills = [skill('a'), skill('b'), skill('c'), skill('d')]
    const stats = new Map([
      ['a', stat('a', 15)],
      ['b', stat('b', 5)],
      ['c', stat('c', 1)],
    ])
    const tiers = groupByUsage(skills, stats)
    const byId = new Map(tiers.map((tier) => [tier.id, tier.skills.map((item) => item.name)]))
    expect(byId.get('frequent')).toEqual(['a'])
    expect(byId.get('regular')).toEqual(['b'])
    expect(byId.get('occasional')).toEqual(['c'])
    expect(byId.get('never')).toEqual(['d'])
  })

  it('drops empty tiers so the list has no blank cards', () => {
    const tiers = groupByUsage([skill('only')], new Map())
    expect(tiers.map((tier) => tier.id)).toEqual(['never'])
  })

  it('treats a missing ledger row as never-called', () => {
    const tiers = groupByUsage([skill('unused')], new Map())
    expect(tiers[0]?.skills.map((item) => item.name)).toEqual(['unused'])
  })
})
