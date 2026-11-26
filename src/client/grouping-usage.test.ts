/** Usage ranking: permanent ledger totals win, ties keep input order. */
import { describe, expect, it } from 'vitest'
import { sortByUsage, usageTotal } from './grouping.ts'

const row = (name: string) => ({ name })

describe('sortByUsage', () => {
  it('orders skills by total calls, highest first', () => {
    const uses = new Map([
      ['alpha', { count: 3 }],
      ['beta', { count: 9 }],
      ['gamma', { count: 1 }],
    ])
    expect(sortByUsage([row('alpha'), row('beta'), row('gamma')], uses).map((s) => s.name)).toEqual(['beta', 'alpha', 'gamma'])
  })

  it('prefers the permanent ledger total over the log count', () => {
    // alpha's log says 99, but its ledger says 1; beta's ledger says 40.
    const uses = new Map([
      ['alpha', { count: 99, permanent: { total: 1 } }],
      ['beta', { count: 1, permanent: { total: 40 } }],
    ])
    expect(sortByUsage([row('alpha'), row('beta')], uses).map((s) => s.name)).toEqual(['beta', 'alpha'])
  })

  it('sorts never-called skills last and keeps their input order', () => {
    const uses = new Map([['beta', { count: 2 }]])
    const sorted = sortByUsage([row('zulu'), row('alpha'), row('beta')], uses)
    expect(sorted.map((s) => s.name)).toEqual(['beta', 'zulu', 'alpha'])
  })
})

describe('usageTotal', () => {
  it('is zero when a skill has no stat', () => {
    expect(usageTotal(undefined)).toBe(0)
  })
  it('falls back to the log count without a permanent record', () => {
    expect(usageTotal({ count: 7 })).toBe(7)
  })
})