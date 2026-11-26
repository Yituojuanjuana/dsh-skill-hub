import { describe, it, expect } from 'vitest'
import { aggregate } from './aggregate.ts'

describe('aggregate', () => {
  it('buckets today/week/total by local time with a Monday week start', () => {
    const now = new Date(2026, 10, 24, 12, 0, 0).getTime() // Tue 2026-11-24 Asia/Shanghai
    const entries = [
      { name: 'alpha', ts: now - 1 * 3600_000 },            // today
      { name: 'alpha', ts: now - 24 * 3600_000 },           // yesterday, this week
      { name: 'alpha', ts: now - 20 * 24 * 3600_000 },      // 20 days ago, total only
      { name: 'beta', ts: now - 3 * 3600_000 },
    ]
    const rows = aggregate(entries, now)
    expect(rows.get('alpha')).toEqual({ today: 1, week: 2, total: 3, lastUsed: now - 3600_000 })
    expect(rows.get('beta')).toEqual({ today: 1, week: 1, total: 1, lastUsed: now - 3 * 3600_000 })
  })

  it('does not count a previous-Sunday timestamp as this week', () => {
    // Anchor at a known Monday 00:00 local time: the week starts exactly here.
    const monday = new Date(2026, 10, 23, 0, 0, 0).getTime() // Mon 2026-11-23
    const now = new Date(2026, 10, 23, 12, 0, 0).getTime()   // Mon noon
    const justBeforeMonday = monday - 1 // Sun 2026-11-22 23:59:59.999
    const entries = [
      { name: 'alpha', ts: justBeforeMonday },
      { name: 'alpha', ts: monday },
      { name: 'alpha', ts: now - 3600_000 },
    ]
    const rows = aggregate(entries, now)
    // previous Sunday is neither today nor this week, but still counts toward total.
    // Monday 00:00 and Monday 11:00 both belong to today and to this week.
    expect(rows.get('alpha')).toEqual({ today: 2, week: 2, total: 3, lastUsed: now - 3600_000 })
  })
})
