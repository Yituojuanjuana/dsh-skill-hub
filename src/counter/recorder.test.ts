import { describe, it, expect } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLedger } from './ledger.ts'
import { createSkillCallHandler } from './recorder.ts'

describe('recorder', () => {
  /** 真实会话日志里的形状：PTC 派发的 arguments 已经是对象。 */
  function ptcDispatch(name: string, args: unknown) {
    return {
      type: 'tool/ptc-dispatch',
      time: 1000,
      data: { rootCallId: 'r1', parentCallId: 'r1', subCallId: 'r1:ptc:1', name, arguments: args, isError: false },
    }
  }

  it('records a skill invoked through PTC dispatch, where run_code calls land', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rec-'))
    const file = join(dir, 'usage-ledger.jsonl')
    const onCall = createSkillCallHandler(file)
    await onCall(ptcDispatch('skill', { name: 'alpha' }))
    const { entries } = await readLedger(file)
    expect(entries).toEqual([{ name: 'alpha', ts: 1000 }])
  })

  it('records a direct skill tool call and a user slash invocation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rec-direct-'))
    const file = join(dir, 'usage-ledger.jsonl')
    const onCall = createSkillCallHandler(file)
    await onCall({ type: 'tool/call', time: 1000, data: { name: 'skill', arguments: JSON.stringify({ name: 'beta' }) } })
    await onCall({ type: 'user/message', time: 2000, data: { source: { kind: 'skill-invocation', name: 'gamma' } } })
    const { entries } = await readLedger(file)
    expect(entries).toEqual([{ name: 'beta', ts: 1000 }, { name: 'gamma', ts: 2000 }])
  })

  it('ignores non-skill tools on both dispatch and direct paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rec-other-'))
    const file = join(dir, 'usage-ledger.jsonl')
    const onCall = createSkillCallHandler(file)
    await onCall(ptcDispatch('read', { file_path: 'x' }))
    await onCall({ type: 'tool/call', time: 1000, data: { name: 'bash', arguments: '{}' } })
    const { entries } = await readLedger(file)
    expect(entries).toEqual([])
  })

  it('does not double count the paired dispatch-start event', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rec-pair-'))
    const file = join(dir, 'usage-ledger.jsonl')
    const onCall = createSkillCallHandler(file)
    const start = ptcDispatch('skill', { name: 'alpha' })
    await onCall({ ...start, type: 'tool/ptc-dispatch-start' })
    await onCall(start)
    const { entries } = await readLedger(file)
    expect(entries).toHaveLength(1)
  })

  it('skips a skill call whose arguments carry no name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rec-noname-'))
    const file = join(dir, 'usage-ledger.jsonl')
    const onCall = createSkillCallHandler(file)
    await onCall(ptcDispatch('skill', {}))
    await onCall({ type: 'tool/call', time: 1000, data: { name: 'skill', arguments: '{"na' } })
    const { entries } = await readLedger(file)
    expect(entries).toEqual([])
  })
})
