/** 驳回记录的 kind 必须持久化，否则重启后类型隔离失效。 */
import { describe, expect, it } from 'vitest'
import { hydrateEvolutionFile } from './store.ts'

describe('rejection kind hydration', () => {
  it('keeps a valid kind', () => {
    const file = hydrateEvolutionFile({
      version: 1,
      markdown: '', ranAt: 0, proposals: [], runs: [],
      rejections: [
        { id: 'a', skillName: 'x', reason: 'r', at: 1, kind: 'optimize' },
        { id: 'b', skillName: 'y', reason: 'r', at: 2, kind: 'reclaim' },
        { id: 'c', skillName: 'z', reason: 'r', at: 3, kind: 'new-skill' },
      ],
    })
    expect(file.rejections.map((r) => r.kind)).toEqual(['optimize', 'reclaim', 'new-skill'])
  })

  it('drops an unknown kind but keeps the record', () => {
    const file = hydrateEvolutionFile({
      version: 1, markdown: '', ranAt: 0, proposals: [], runs: [],
      rejections: [{ id: 'a', skillName: 'x', reason: 'r', at: 1, kind: 'bogus' }],
    })
    expect(file.rejections).toHaveLength(1)
    expect(file.rejections[0]?.kind).toBeUndefined()
  })

  it('handles legacy records without kind', () => {
    const file = hydrateEvolutionFile({
      version: 1, markdown: '', ranAt: 0, proposals: [], runs: [],
      rejections: [{ id: 'a', skillName: 'x', reason: 'r', at: 1 }],
    })
    expect(file.rejections[0]?.kind).toBeUndefined()
  })
})