/**
 * 一次性历史回填：把已有会话日志里的技能调用补进永久账本。
 *
 * 口径与 recorder 一致（tool/ptc-dispatch、tool/call + tool/result、user/message）：
 * - ptc-dispatch 自带 isError → 直接带 ok；
 * - tool/call 用 callId 与 tool/result.message.toolCallId 配对 → 补 ok；
 * - /技能名 无结果事件 → 保持未知。
 *
 * 幂等：账本条目以 (name, ts) 去重。重复运行不重复计数；「同键已存在但缺 ok、
 * 日志里能判定成败」时，允许覆盖为带 ok 的版本（aggregate 也按同键去重），
 * 不会让总调用翻倍。
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decompressZstdFrames } from './zstd-frames.ts'
import type { LedgerEntry } from './aggregate.ts'
import { callIdOf, ptcOk, resultCallId, resultOk } from './outcome.ts'

export interface BackfillResult {
  files: number
  found: number
  appended: number
  skipped: number
  /** 同键已存在但缺 ok、本次补上成败的条目数。 */
  upgraded: number
}

/** 递归找出会话日志文件（session.v*.jsonl / .zstd）。 */
async function listSessionLogs(root: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 3) return
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { await walk(full, depth + 1); continue }
      if (/^session\.v\d+\.jsonl(\.zstd)?$/.test(entry.name)) out.push(full)
    }
  }
  await walk(root, 0)
  return out
}

/** 从一条会话事件里取技能名，口径与 recorder 保持一致。 */
export function skillNameFromLogEvent(event: unknown): string | null {
  if (typeof event !== 'object' || event === null) return null
  const e = event as { type?: string; data?: Record<string, unknown> }
  const d = e.data ?? {}
  const pick = (raw: unknown): string | null => {
    let parsed: unknown = raw
    if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw) } catch { return null }
    }
    const name = (parsed as { name?: unknown } | null)?.name
    return typeof name === 'string' && name.trim() ? name.trim() : null
  }
  if (e.type === 'tool/ptc-dispatch') return d.name === 'skill' ? pick(d.arguments) : null
  if (e.type === 'tool/call') return d.name === 'skill' ? pick(d.arguments) : null
  if (e.type === 'user/message') {
    const s = d.source as { kind?: string; name?: string } | undefined
    return s?.kind === 'skill-invocation' && typeof s.name === 'string' && s.name.trim() ? s.name.trim() : null
  }
  return null
}

/** 读一个日志文件里的全部技能调用（含成败配对）。 */
export async function readSkillCallsFromLog(file: string): Promise<LedgerEntry[]> {
  let raw: Buffer
  try { raw = await readFile(file) } catch { return [] }
  let text: string
  try {
    text = file.endsWith('.zstd') ? decompressZstdFrames(raw).toString('utf8') : raw.toString('utf8')
  } catch { return [] }
  const events: Array<{ type: string; time: number; data: Record<string, unknown> }> = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line) as { type?: string; time?: number; data?: Record<string, unknown> }
      if (typeof e.type === 'string') events.push({ type: e.type, time: Number(e.time) || 0, data: e.data ?? {} })
    } catch { continue }
  }
  // callId → 该次调用的 (name, ts)，用于 tool/result 配对。
  const byCallId = new Map<string, { name: string; ts: number }>()
  const out: LedgerEntry[] = []
  for (const event of events) {
    const rid = resultCallId(event)
    if (rid !== undefined) {
      const p = byCallId.get(rid)
      const ok = resultOk(event)
      if (p !== undefined && ok !== undefined) out.push({ name: p.name, ts: p.ts, ok })
      continue
    }
    const name = skillNameFromLogEvent(event)
    if (name === null) continue
    const ts = event.time
    if (!Number.isFinite(ts) || ts <= 0) continue
    const ok = ptcOk(event)
    if (ok !== undefined) { out.push({ name, ts, ok }); continue }
    out.push({ name, ts })
    const cid = callIdOf(event)
    if (cid !== undefined) byCallId.set(cid, { name, ts })
  }
  return out
}

export function ledgerKey(entry: LedgerEntry): string { return entry.name + '\0' + entry.ts }

/** 扫描全部会话日志，把账本里还没有的技能调用补进去。 */
export async function backfillFromSessionLogs(
  sessionsRoot: string,
  existing: readonly LedgerEntry[],
  append: (entry: LedgerEntry) => Promise<void>,
): Promise<BackfillResult> {
  const byKey = new Map(existing.map((e) => [ledgerKey(e), e]))
  const files = await listSessionLogs(sessionsRoot)
  const result: BackfillResult = { files: files.length, found: 0, appended: 0, skipped: 0, upgraded: 0 }
  const collected: LedgerEntry[] = []
  for (const file of files) {
    for (const entry of await readSkillCallsFromLog(file)) {
      result.found += 1
      collected.push(entry)
    }
  }
  collected.sort((a, b) => a.ts - b.ts)
  for (const entry of collected) {
    const key = ledgerKey(entry)
    const prev = byKey.get(key)
    if (prev === undefined) {
      byKey.set(key, entry)
      await append(entry)
      result.appended += 1
      continue
    }
    // 同键已存在：只有「已有条目缺 ok、新条目带 ok」才覆盖补写（不翻倍）。
    if (typeof prev.ok !== 'boolean' && typeof entry.ok === 'boolean') {
      byKey.set(key, entry)
      await append(entry)
      result.upgraded += 1
    } else {
      result.skipped += 1
    }
  }
  return result
}
