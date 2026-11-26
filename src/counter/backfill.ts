/**
 * 一次性历史回填：把已有会话日志里的技能调用补进永久账本。
 *
 * 为什么需要：账本从插件安装那一刻才开始记，之前的历史调用不在里面，
 * 面板一打开是空的。这里扫描 ~/.dsh/sessions 下的会话日志，按与 recorder
 * 完全相同的口径（tool/ptc-dispatch、tool/call、user/message 三条路径）提取
 * 技能名，再追加进账本。
 *
 * 幂等性：账本条目以 (name, ts) 去重，ts 取自会话事件的 time（与 recorder 一致）。
 * 因此重复运行不会重复计数，也能安全地和实时记录的条目共存。
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decompressZstdFrames } from './zstd-frames.ts'
import type { LedgerEntry } from './aggregate.ts'

export interface BackfillResult {
  /** 扫描的会话日志文件数。 */
  files: number
  /** 从日志里读到的技能调用总数（去重前）。 */
  found: number
  /** 实际新写入账本的条目数。 */
  appended: number
  /** 因账本里已有同 (name, ts) 而跳过的条目数。 */
  skipped: number
  /** 解压或解析失败的文件数。 */
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

/** 读一个日志文件里的全部技能调用。 */
export async function readSkillCallsFromLog(file: string): Promise<LedgerEntry[]> {
  let raw: Buffer
  try { raw = await readFile(file) } catch { return [] }
  let text: string
  try {
    text = file.endsWith('.zstd') ? decompressZstdFrames(raw).toString('utf8') : raw.toString('utf8')
  } catch { return [] }
  const out: LedgerEntry[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let event: unknown
    try { event = JSON.parse(line) } catch { continue }
    const name = skillNameFromLogEvent(event)
    if (!name) continue
    const ts = Number((event as { time?: unknown }).time)
    if (!Number.isFinite(ts) || ts <= 0) continue
    out.push({ name, ts })
  }
  return out
}

export function ledgerKey(entry: LedgerEntry): string { return entry.name + '\u0000' + entry.ts }

/**
 * 扫描全部会话日志，把账本里还没有的技能调用补进去。
 * @param sessionsRoot 会话日志根目录，通常是 ~/.dsh/sessions
 * @param append 写入函数（注入以便测试）
 * @param existing 账本里已有的条目
 */
export async function backfillFromSessionLogs(
  sessionsRoot: string,
  existing: readonly LedgerEntry[],
  append: (entry: LedgerEntry) => Promise<void>,
): Promise<BackfillResult> {
  const seen = new Set(existing.map(ledgerKey))
  const files = await listSessionLogs(sessionsRoot)
  const result: BackfillResult = { files: files.length, found: 0, appended: 0, skipped: 0 }
  // 按时间排序写入，账本读起来是时间顺序。
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
    if (seen.has(key)) { result.skipped += 1; continue }
    seen.add(key)
    await append(entry)
    result.appended += 1
  }
  return result
}
