import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeUsageHandler } from './usage.ts'

describe('usage route', () => {
  it('returns today/week/total per skill and skipped count', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usage-route-'))
    const file = join(dir, 'usage-ledger.jsonl')
    const now = new Date(2026, 10, 24, 12, 0, 0).getTime()
    await writeFile(file, [
      JSON.stringify({ name: 'alpha', ts: now - 3600_000 }),
      JSON.stringify({ name: 'alpha', ts: now - 20 * 24 * 3600_000 }),
      'BAD LINE',
    ].join('\n'))
    const handler = makeUsageHandler(file, () => now)
    const res: { status?: number; body?: unknown } = {}
    const fakeRes = { writeHead: (s: number) => { res.status = s }, end: (b: string) => { res.body = JSON.parse(b) }, setHeader: () => {} } as any
    await handler({ req: {} as any, res: fakeRes, url: new URL('http://localhost/'), body: {} })
    expect(res.status).toBe(200)
    expect((res.body as any).ok).toBe(true)
    expect((res.body as any).skipped).toBe(1)
    expect((res.body as any).stats.find((r: any) => r.name === 'alpha')).toMatchObject({ today: 1, week: 1, total: 2 })
  })
})
