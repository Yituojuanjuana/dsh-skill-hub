import { describe, it, expect } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLedger } from './ledger.ts'
import { createSkillCallHandler } from './recorder.ts'
import { aggregate } from './aggregate.ts'

/** 用真实会话日志里的事件形状，端到端验证「调用技能 → ledger → 日/周/总」。 */
describe('e2e: a real skill call becomes day/week/total counts', () => {
  it('records a PTC-dispatched skill call and aggregates it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'e2e-'))
    const file = join(dir, 'usage-ledger.jsonl')
    const on = createSkillCallHandler(file)
    const now = Date.now()
    // 形状取自 session.v4.jsonl 的 tool/ptc-dispatch。
    await on({
      type: 'tool/ptc-dispatch',
      time: now,
      data: { rootCallId: 'r1', parentCallId: 'r1', subCallId: 'r1:ptc:1', name: 'skill', arguments: { name: 'writing-for-agents' }, isError: false },
    })
    const { entries } = await readLedger(file)
    expect(entries).toHaveLength(1)
    expect(entries[0].name).toBe('writing-for-agents')
    const stats = aggregate(entries, now)
    // ptc-dispatch 自带 isError:false → 账本这次带 ok:true，成功率可判定。
    expect(stats.get('writing-for-agents')).toEqual({ today: 1, week: 1, total: 1, lastUsed: now, successRate: 1 })
  })

  it('accumulates repeated calls to the same skill', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'e2e-multi-'))
    const file = join(dir, 'usage-ledger.jsonl')
    const on = createSkillCallHandler(file)
    const now = Date.now()
    for (let i = 0; i < 3; i++) {
      await on({ type: 'tool/ptc-dispatch', time: now + i, data: { name: 'skill', arguments: { name: 'dsh-doc' } } })
    }
    const { entries } = await readLedger(file)
    expect(entries).toHaveLength(3)
    expect(aggregate(entries, now).get('dsh-doc')).toMatchObject({ today: 3, week: 3, total: 3 })
  })
})
