/**
 * SkillRow 调用量展示：账本（日/周/总）是唯一来源。
 *
 * 会话日志统计已移除——行上只允许出现一套调用量，避免两个数字互相矛盾。
 * 这里同时锁定「没有账本记录时不留任何调用量痕迹」。
 */
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CatalogSkill } from '../../protocol.ts'
import { SkillRowImpl, type SkillRowProps } from './SkillRow.tsx'

const skill: CatalogSkill = {
  name: 'alpha',
  description: 'd',
  invocation: { modelInvocable: true, userInvocable: false },
  provider: 'test',
  writable: false,
  source: 'user-dsh',
}

const baseProps: SkillRowProps = {
  skill,
  uses: new Map([['alpha', { count: 9, lastUsed: 1 }]]),
  permanentUses: new Map([['alpha', { name: 'alpha', today: 2, week: 5, total: 9, lastUsed: 1 }]]),
  hubConfig: null,
  busyNames: new Set(),
  editMode: false,
  tagBusy: false,
  duplicateNames: new Set(),
  setInvocation: async () => true,
  toggle: async () => {},
  openDetail: async () => {},
  requestDeleteSkill: () => {},
  requestTrashSkill: () => {},
}

describe('SkillRow usage stats', () => {
  it('renders the ledger day/week/total counters', () => {
    const html = renderToString(createElement(SkillRowImpl, baseProps))
    expect(html).toContain('日 2')
    expect(html).toContain('周 5')
    expect(html).toContain('总 9')
  })

  it('renders no usage counter when there is no ledger record', () => {
    const html = renderToString(createElement(SkillRowImpl, { ...baseProps, uses: new Map(), permanentUses: new Map() }))
    expect(html).not.toContain('日 2')
    expect(html).not.toContain('总 9')
  })

  it('hides the counters when showUseCount is off', () => {
    const html = renderToString(createElement(SkillRowImpl, {
      ...baseProps,
      hubConfig: { enabled: true, announceToAgent: true, showUseCount: false, showUseTime: true, showGroupSummary: true },
    }))
    expect(html).not.toContain('总 9')
  })
})
