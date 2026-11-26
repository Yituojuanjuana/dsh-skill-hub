import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backfillFromSessionLogs, readSkillCallsFromLog, skillNameFromLogEvent, ledgerKey } from './backfill.ts'
import type { LedgerEntry } from './aggregate.ts'

describe('history backfill', () => {
  function dispatch(name: string, arg: unknown, time: number) {
    return JSON.stringify({ type: 'tool/ptc-dispatch', time, data: { name, arguments: arg } })
  }

  it('extracts skill names from all three real event paths', () => {
    expect(skillNameFromLogEvent({ type: 'tool/ptc-dispatch', data: { name: 'skill', arguments: { name: 'alpha' } } })).toBe('alpha')
    expect(skillNameFromLogEvent({ type: 'tool/call', data: { name: 'skill', arguments: '{"name":"beta"}' } })).toBe('beta')
    expect(skillNameFromLogEvent({ type: 'user/message', data: { source: { kind: 'skill-invocation', name: 'gamma' } } })).toBe('gamma')
  })

  it('ignores non-skill tools and malformed events', () => {
    expect(skillNameFromLogEvent({ type: 'tool/ptc-dispatch', data: { name: 'read', arguments: { file_path: 'x' } } })).toBeNull()
    expect(skillNameFromLogEvent({ type: 'tool/call', data: { name: 'bash', arguments: '{}' } })).toBeNull()
    expect(skillNameFromLogEvent({ type: 'user/message', data: { source: { kind: 'user' } } })).toBeNull()
    expect(skillNameFromLogEvent(null)).toBeNull()
    expect(skillNameFromLogEvent({ type: 'tool/call', data: { name: 'skill', arguments: '{"na' } })).toBeNull()
  })

  it('reads calls out of a log file and skips junk lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bf-read-'))
    const file = join(dir, 'session.v4.jsonl')
    await writeFile(file, [
      dispatch('skill', { name: 'alpha' }, 1000),
      'not json at all',
      dispatch('read', { file_path: 'x' }, 1500),
      dispatch('skill', { name: 'beta' }, 2000),
      '',
    ].join('\n'), 'utf8')
    const calls = await readSkillCallsFromLog(file)
    expect(calls).toEqual([{ name: 'alpha', ts: 1000 }, { name: 'beta', ts: 2000 }])
  })

  it('appends historical calls and skips ones already in the ledger', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bf-'))
    const sessions = join(dir, 'sessions', 'proj', 'session-1')
    await mkdir(sessions, { recursive: true })
    await writeFile(join(sessions, 'session.v4.jsonl'), [
      dispatch('skill', { name: 'alpha' }, 1000),
      dispatch('skill', { name: 'beta' }, 2000),
    ].join('\n'), 'utf8')
    const appended: LedgerEntry[] = []
    const append = async (e: LedgerEntry) => { appended.push(e) }
    // alpha@1000 已在账本里（例如刚被实时 recorder 记过）。
    const existing: LedgerEntry[] = [{ name: 'alpha', ts: 1000 }]
    const result = await backfillFromSessionLogs(join(dir, 'sessions'), existing, append)
    expect(result.found).toBe(2)
    expect(result.appended).toBe(1)
    expect(result.skipped).toBe(1)
    expect(appended).toEqual([{ name: 'beta', ts: 2000 }])
  })

  it('is idempotent across repeated runs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bf-idem-'))
    const sessions = join(dir, 'sessions', 'p', 's')
    await mkdir(sessions, { recursive: true })
    await writeFile(join(sessions, 'session.v4.jsonl'), dispatch('skill', { name: 'alpha' }, 1000), 'utf8')
    const ledger: LedgerEntry[] = []
    const append = async (e: LedgerEntry) => { ledger.push(e) }
    const first = await backfillFromSessionLogs(join(dir, 'sessions'), ledger, append)
    expect(first.appended).toBe(1)
    const second = await backfillFromSessionLogs(join(dir, 'sessions'), ledger, append)
    expect(second.appended).toBe(0)
    expect(second.skipped).toBe(1)
    expect(ledger).toHaveLength(1)
  })

  it('returns zeroes when the sessions root does not exist', async () => {
    const result = await backfillFromSessionLogs(join(tmpdir(), 'definitely-missing-dir-xyz'), [], async () => {})
    expect(result).toEqual({ files: 0, found: 0, appended: 0, skipped: 0 })
  })

  it('keys entries by name and timestamp together', () => {
    expect(ledgerKey({ name: 'a', ts: 1 })).not.toBe(ledgerKey({ name: 'a', ts: 2 }))
    expect(ledgerKey({ name: 'a', ts: 1 })).not.toBe(ledgerKey({ name: 'b', ts: 1 }))
  })
})
