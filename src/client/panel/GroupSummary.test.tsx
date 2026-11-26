/**
 * 分类卡片合计：卡片上的日/周/总必须分别等于该分类下各技能「日」「周」「总」之和。
 */
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { PermanentStat } from '../../protocol.ts'
import { GroupSummary } from './GroupSummary.tsx'

function stat(name: string, today: number, week: number, total: number, lastUsed = 1000): PermanentStat {
  return { name, today, week, total, lastUsed }
}

/** React SSR 在相邻文本节点间插入 `<!-- -->`，断言前先剥掉。 */
function strip(html: string): string {
  return html.replace(/<!-- -->/g, '')
}

describe('GroupSummary', () => {
  it('sums day, week and total independently across every member', () => {
    const permanentUses = new Map([
      ['a', stat('a', 1, 2, 7)],
      ['b', stat('b', 0, 1, 3)],
      ['c', stat('c', 2, 2, 5)],
    ])
    const html = renderToString(createElement(GroupSummary, {
      members: ['a', 'b', 'c'],
      permanentUses,
      hubConfig: null,
    }))
    // 日 1+0+2=3，周 2+1+2=5，总 7+3+5=15 —— 三档各自累加，不是共用同一个数。
    expect(strip(html)).toContain('日 3 · 周 5 · 总 15')
  })

  it('ignores members with no ledger record', () => {
    const permanentUses = new Map([['a', stat('a', 1, 1, 4)]])
    const html = renderToString(createElement(GroupSummary, {
      members: ['a', 'missing'],
      permanentUses,
      hubConfig: null,
    }))
    expect(strip(html)).toContain('日 1 · 周 1 · 总 4')
  })

  it('renders nothing when the group has no calls', () => {
    const html = renderToString(createElement(GroupSummary, {
      members: ['a'],
      permanentUses: new Map([['a', stat('a', 0, 0, 0, 0)]]),
      hubConfig: null,
    }))
    expect(strip(html)).not.toContain('总')
  })

  it('honours the showGroupSummary switch', () => {
    const html = renderToString(createElement(GroupSummary, {
      members: ['a'],
      permanentUses: new Map([['a', stat('a', 1, 1, 9)]]),
      hubConfig: { enabled: true, announceToAgent: true, showUseCount: true, showUseTime: true, showGroupSummary: false },
    }))
    expect(strip(html)).not.toContain('总 9')
  })
})
