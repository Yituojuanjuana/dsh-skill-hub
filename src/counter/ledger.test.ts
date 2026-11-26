import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendEntry, readLedger } from './ledger.ts'

describe('ledger', () => {
  it('appends one JSON line and skips corrupt lines on read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ledger-'))
    const file = join(dir, 'usage-ledger.jsonl')
    await writeFile(file, '{"name":"a","ts":1}\nNOT JSON\n{"name":"b","ts":2}\n')
    const before = await readLedger(file)
    expect(before.entries).toEqual([{ name:'a', ts:1 }, { name:'b', ts:2 }])
    expect(before.skipped).toBe(1)
    await appendEntry(file, { name: 'a', ts: 3 })
    const after = await readLedger(file)
    expect(after.entries.map(e=>e.ts)).toEqual([1,2,3])
    expect((await readFile(file,'utf8')).trimEnd().split('\n')).toHaveLength(4)
  })

  it('tolerates a missing file and creates parent directories on append', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ledger-missing-'))
    const file = join(dir, 'nested', 'usage-ledger.jsonl')
    expect(await readLedger(file)).toEqual({ entries: [], skipped: 0 })
    await appendEntry(file, { name: 'alpha', ts: 42 })
    expect(await readLedger(file)).toEqual({ entries: [{ name: 'alpha', ts: 42 }], skipped: 0 })
  })
})
