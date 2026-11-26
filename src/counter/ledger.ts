import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { LedgerEntry } from './aggregate.ts'
export interface LedgerRead { entries: LedgerEntry[]; skipped: number }
export async function readLedger(file: string): Promise<LedgerRead> {
  let text: string
  try { text = await readFile(file, 'utf8') } catch { return { entries: [], skipped: 0 } }
  const entries: LedgerEntry[] = []
  let skipped = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const v = JSON.parse(line) as LedgerEntry
      if (typeof v.name === 'string' && v.name && Number.isFinite(v.ts)) entries.push(v)
      else skipped += 1
    } catch { skipped += 1 }
  }
  return { entries, skipped }
}
export async function appendEntry(file: string, entry: LedgerEntry): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, JSON.stringify(entry) + '\n', 'utf8')
}
