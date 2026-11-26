/**
 * Shared display helpers for the panel views (skill rows, detail view, and
 * dialogs): dot color styling, relative/absolute time text, and commit-SHA
 * shortening. Kept in one place so the views render identically.
 *
 * The invocation-status dot defaults live here (not in the settings card) so
 * both the panel legend and the chat `/` skill menu draw from one source and
 * so this primitives-free module stays unit-testable.
 */

import type { CSSProperties } from 'react'
import { formatRelativeTime } from '../grouping.ts'
import { tt } from '../helpers.ts'

/** Model-invocable dot color default. Single source for the TS side; the
 *  panel's CSS mirrors it via --hub-model (panel.module.css). */
export const DEFAULT_DOT_MODEL_COLOR = '#2f81f7'
/** User-invocable dot color default. Single source for the TS side; the
 *  panel's CSS mirrors it via --hub-user (panel.module.css). */
export const DEFAULT_DOT_USER_COLOR = '#3fb950'

/** Dot inline style from the user-chosen color (undefined keeps the CSS default). */
export function dotStyle(color: string | undefined): CSSProperties | undefined {
  if (color === undefined) return undefined
  return { background: color, borderColor: color }
}

/** Localized relative-time text for a Unix-ms timestamp. */
export function relativeTimeText(ms: number): string {
  const rt = formatRelativeTime(ms)
  return tt(rt.key, rt.value !== undefined ? { value: rt.value } : undefined)
}

/** Localized absolute time for the detail meta (e.g. "2026/8/16 11:00:00"). */
export function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString()
}

/** Short form of a commit SHA for display. */
export function shortSha(sha: string): string {
  return sha.length > 7 ? sha.slice(0, 7) : sha
}

/**
 * 成功率的展示文本。
 *
 * 边界处理是重点：`PermanentStat` 可能没有成功率字段（历史数据没记成败），
 * 也可能总调用为 0。这两种情况都显示「-」，**绝不能**出现 NaN / Infinity /
 * 「0%」误导（0% 意味着「全都失败」，与「没有数据」完全不同）。
 * @param stat - 该技能的统计行。
 * @returns 百分比字符串（如 "92%"），或 "-"。
 */
export function formatSuccessRate(stat: { total: number; successRate?: number }): string {
  const rate = stat.successRate
  if (rate === undefined || !Number.isFinite(rate)) return '-'
  if (!Number.isFinite(stat.total) || stat.total <= 0) return '-'
  // 夹到 0~1：上游若给了 1.2 或 -0.1 这种脏数据也不显示 120% / -10%。
  const clamped = Math.min(1, Math.max(0, rate))
  return String(Math.round(clamped * 100)) + '%'
}