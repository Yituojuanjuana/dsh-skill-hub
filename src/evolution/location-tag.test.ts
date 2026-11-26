/**
 * 进化卡片的归属目录标签。
 *
 * 与通用页「按目录」视图共用同一套分类映射，保证两处显示一致。
 * 新建类技能尚未落地 → 「待落地」；优化/回收 → 真实目录。
 */
import { describe, expect, it } from 'vitest'
import { locationLabel, sourceLabel } from '../client/panel/source-label.ts'

/** 复刻卡片的标签选择逻辑。 */
function locationTag(proposal: { kind: string; skillSource?: string }): string {
  if (proposal.kind === 'new-skill') return '待落地'
  return locationLabel(proposal.skillSource ?? '') || '未知目录'
}

describe('location labels match the general page', () => {
  it('maps the well-known roots to the same labels', () => {
    expect(locationLabel('user-dsh')).toBe('DSH')
    expect(locationLabel('user-agents')).toBe('公共 Agent')
    expect(locationLabel('bundled')).toBe('官方')
    expect(locationLabel('project-dsh')).toBe('项目 DSH')
    expect(locationLabel('project-agents')).toBe('项目 Agent')
  })

  it('maps external agent roots to their product name', () => {
    // agent-trae-cn 这类在通用页显示为产品名，进化卡片必须一致。
    expect(locationLabel('agent-trae-cn').toLowerCase()).toContain('trae')
  })

  it('falls back to the raw source for unknown roots', () => {
    expect(locationLabel('some-unknown-root')).toBe('some-unknown-root')
  })
})

describe('locationTag by proposal kind', () => {
  it('shows 待落地 for a new-skill proposal', () => {
    expect(locationTag({ kind: 'new-skill', skillSource: 'user-dsh' })).toBe('待落地')
  })

  it('shows the real location for an optimize proposal', () => {
    expect(locationTag({ kind: 'optimize', skillSource: 'user-dsh' })).toBe('DSH')
    expect(locationTag({ kind: 'optimize', skillSource: 'agent-trae-cn' }).toLowerCase()).toContain('trae')
  })

  it('shows the real location for a reclaim proposal', () => {
    expect(locationTag({ kind: 'reclaim', skillSource: 'user-agents' })).toBe('公共 Agent')
  })

  it('degrades safely when the source is missing', () => {
    // 老提案没有 skillSource：不该渲染成 undefined / 空白。
    const label = locationTag({ kind: 'optimize' })
    expect(typeof label).toBe('string')
    expect(label).not.toBe('undefined')
    expect(label.length).toBeGreaterThan(0)
  })
})

describe('sourceLabel stays independent', () => {
  it('still resolves agent ids', () => {
    expect(sourceLabel('agent-openclaw')).toBe('OpenClaw')
  })
})
