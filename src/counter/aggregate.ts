export interface LedgerEntry {
  name: string
  ts: number
  /**
   * 这次调用是否成功（可选）。
   *
   * 账本默认只记「调用了一次」；某些来源（工具结果可判定成败时）会带上它。
   * 缺省视为「未知」而不是「失败」—— 否则所有历史数据都会被算成 0% 成功率。
   */
  ok?: boolean
}
export interface UsageRow {
  today: number
  week: number
  total: number
  lastUsed: number
  /**
   * 历史成功率（0~1）。
   *
   * 只有在账本里存在**至少一条**带 `ok` 标记的条目时才有值；否则省略，
   * 让上层区分「成功率未知」与「成功率 0%」。
   */
  successRate?: number
}
const DAY = 24 * 3600_000
function startOfLocalDay(ts: number): number { const d = new Date(ts); d.setHours(0,0,0,0); return d.getTime() }
export function aggregate(entries: readonly LedgerEntry[], now: number): Map<string, UsageRow> {
  const todayStart = startOfLocalDay(now)
  const d = new Date(todayStart)
  const dow = d.getDay() // 0=Sun
  const weekStart = todayStart - ((dow + 6) % 7) * DAY // Monday 00:00
  const rows = new Map<string, UsageRow>()
  // (name, ts) 去重：结果回填会追加一条同键但带 ok 的记录，后者覆盖前者，
  // 总调用次数不翻倍。同键时带 ok 的版本胜出（无论顺序）。
  const dedup = new Map<string, LedgerEntry>()
  for (const e of entries) {
    if (typeof e?.name !== 'string' || !e.name || !Number.isFinite(e.ts)) continue
    const key = e.name + '\0' + e.ts
    const prev = dedup.get(key)
    if (prev === undefined || (typeof e.ok === 'boolean' && typeof prev.ok !== 'boolean')) dedup.set(key, e)
  }
  // 成功率单独累计：只有带 `ok` 标记的条目才计入分母，避免历史无标记数据
  // 把成功率稀释成 0。
  const known = new Map<string, { ok: number; total: number }>()
  for (const e of dedup.values()) {
    if (typeof e?.name !== 'string' || !e.name || !Number.isFinite(e.ts)) continue
    let row = rows.get(e.name)
    if (!row) { row = { today:0, week:0, total:0, lastUsed:0 }; rows.set(e.name, row) }
    row.total += 1
    if (e.ts >= weekStart) row.week += 1
    if (e.ts >= todayStart) row.today += 1
    if (e.ts > row.lastUsed) row.lastUsed = e.ts
    if (typeof e.ok === 'boolean') {
      const stat = known.get(e.name) ?? { ok: 0, total: 0 }
      stat.total += 1
      if (e.ok) stat.ok += 1
      known.set(e.name, stat)
    }
  }
  // 回填成功率：没有已知样本的技能保持 undefined（未知，不是 0%）。
  for (const [name, stat] of known) {
    const row = rows.get(name)
    if (row !== undefined && stat.total > 0) row.successRate = stat.ok / stat.total
  }
  return rows
}
