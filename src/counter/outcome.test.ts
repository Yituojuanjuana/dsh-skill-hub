import { describe, it, expect } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLedger } from './ledger.ts'
import { createSkillCallHandler } from './recorder.ts'
import { aggregate } from './aggregate.ts'
import { formatSuccessRate } from '../client/panel/format.ts'

const ptc = (name: string, isError: boolean, time: number, sub = 'sub-1') => ({
  type: 'tool/ptc-dispatch', time,
  data: { subCallId: sub, name: 'skill', arguments: { name }, isError },
})
const call = (name: string, id: string, time: number) => ({
  type: 'tool/call', time, data: { callId: id, name: 'skill', arguments: JSON.stringify({ name }) },
})
const result = (id: string, isError: boolean, time: number) => ({
  type: 'tool/result', time, data: { message: { toolCallId: id, isError } },
})

describe('recorder：成败落盘', () => {
  it('成功 + 失败两条 ptc 调用各带 ok', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'out-'))
    const file = join(dir, 'ledger.jsonl')
    const on = createSkillCallHandler(file)
    await on(ptc('alpha', false, 1000, 'a1'))
    await on(ptc('beta', true, 2000, 'b1'))
    const { entries } = await readLedger(file)
    expect(entries).toEqual([
      { name: 'alpha', ts: 1000, ok: true },
      { name: 'beta', ts: 2000, ok: false },
    ])
    const rows = aggregate(entries, 3000)
    expect(rows.get('alpha')?.successRate).toBe(1)
    expect(rows.get('beta')?.successRate).toBe(0)
  })

  it('用户 /技能名 调用只记调用，不记 ok', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'out-slash-'))
    const file = join(dir, 'ledger.jsonl')
    const on = createSkillCallHandler(file)
    await on({ type: 'user/message', time: 1000, data: { source: { kind: 'skill-invocation', name: 'gamma' } } })
    const { entries } = await readLedger(file)
    expect(entries).toEqual([{ name: 'gamma', ts: 1000 }])
    expect(aggregate(entries, 2000).get('gamma')?.successRate).toBeUndefined()
  })

  it('同一技能并发两次不同结果各自配对，不因按 name 串号', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'out-conc-'))
    const file = join(dir, 'ledger.jsonl')
    const on = createSkillCallHandler(file)
    await on(call('alpha', 'id-1', 1000))
    await on(call('alpha', 'id-2', 1100))
    await on(result('id-2', false, 1200)) // 第二次成功
    await on(result('id-1', true, 1300))  // 第一次失败（乱序返回）
    const { entries } = await readLedger(file)
    // 账本里每次调用有 2 行（调用 + 结果回填），aggregate 按 (name, ts) 去重。
    expect(entries).toHaveLength(4)
    const rows = aggregate(entries, 2000)
    expect(rows.get('alpha')?.total).toBe(2)
    expect(rows.get('alpha')?.successRate).toBe(0.5)
    // 两次结果确实各自配对（一成一败），没有串号成全成或全败。
    expect(entries.filter((e) => e.ok === true)).toHaveLength(1)
    expect(entries.filter((e) => e.ok === false)).toHaveLength(1)
  })

  it('同 (name, ts) 结果回填不翻倍（aggregate 去重）', async () => {
    const now = 5000
    const rows = aggregate([
      { name: 'alpha', ts: 1000 },
      { name: 'alpha', ts: 1000, ok: true },
      { name: 'beta', ts: 2000, ok: false },
    ], now)
    expect(rows.get('alpha')?.total).toBe(1)
    expect(rows.get('alpha')?.successRate).toBe(1)
    expect(rows.get('beta')?.successRate).toBe(0)
  })
})

describe('formatSuccessRate：未知 vs 0%', () => {
  it('未知显示 -（UI 层再换成「未知」），0% 显示 0%', () => {
    expect(formatSuccessRate({ total: 3 })).toBe('-')
    expect(formatSuccessRate({ total: 3, successRate: 0 })).toBe('0%')
    expect(formatSuccessRate({ total: 3, successRate: 0.5 })).toBe('50%')
  })
})
