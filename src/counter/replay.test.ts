import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLedger } from './ledger.ts'
import { createSkillCallHandler, type SessionLikeEvent } from './recorder.ts'
import { aggregate } from './aggregate.ts'

/**
 * 回放一段真实会话日志里的事件（2026-11-24 本机 session.v4.jsonl 摘录），
 * 确认 recorder 在真实数据上恰好统计出 15 次技能调用 —— 不多也不少。
 */
describe('recorder against a real session replay', () => {
  const events = JSON.parse(readFileSync(new URL('./replay.fixture.json', import.meta.url), 'utf8')) as SessionLikeEvent[]

  it('finds exactly the 15 skill calls that actually happened', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'replay-'))
    const file = join(dir, 'usage-ledger.jsonl')
    const on = createSkillCallHandler(file)
    for (const event of events) await on(event)
    const { entries, skipped } = await readLedger(file)
    expect(skipped).toBe(0)
    expect(entries).toHaveLength(15)
    const rows = aggregate(entries, Date.now())
    // 真实调用分布：dsh-doc 最多，另有几个各一次。
    expect(rows.get('dsh-doc')?.total).toBe(4)
    expect(rows.get('writing-for-agents')?.total).toBe(2)
    expect(rows.get('personalized-pages')?.total).toBe(2)
    expect(rows.get('brainstorming')?.total).toBe(2)
    expect(rows.get('reuse-first')?.total).toBe(2)
    expect(rows.get('writing-plans')?.total).toBe(1)
    expect(rows.get('subagent-driven-development')?.total).toBe(1)
    expect(rows.get('diagnose-windows-sandbox-acl')?.total).toBe(1)
    expect([...rows.keys()].sort()).toEqual([
      'brainstorming', 'diagnose-windows-sandbox-acl', 'dsh-doc',
      'personalized-pages', 'reuse-first', 'subagent-driven-development',
      'writing-for-agents', 'writing-plans',
    ])
  })
})
