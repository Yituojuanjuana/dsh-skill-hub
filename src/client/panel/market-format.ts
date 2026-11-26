/** Market tab number formatting (stars/downloads/bytes/speed). Pure, no deps. */

/** Compact count for stars/downloads (1234 → 1.2k). */
export function formatCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
}

/** Compact byte size for repo preview rows. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

export function formatSpeed(bps?: number): string {
  if (bps === undefined || bps <= 0) return ''
  if (bps < 1024) return bps + ' B/s'
  if (bps < 1024 * 1024) return (bps / 1024).toFixed(1) + ' KB/s'
  return (bps / 1024 / 1024).toFixed(1) + ' MB/s'
}

/** 「安装量」排序档只展示前 20 条：搜索最多回 50 条，一屏铺不完。 */
export const SKILLS_SH_TOP_N = 20

/**
 * 给 skills.sh 的搜索结果排序。
 *
 * 排序是纯展示层的事：不改上游返回的顺序，也不触发重新搜索。两档语义：
 * - `installs`：安装量从高到低，只留前 `SKILLS_SH_TOP_N` 条。安装量缺失的
 *   排最后 —— 没有数据不等于零安装，但按安装量排序时不该让它们占前排。
 * - `az`：按技能名 A-Z，全部保留（这是「我要找某个具体名字」的场景，
 *   砍到 20 条反而会把目标藏起来）。
 */
export function sortSkillsSh<T extends { name: string; installs?: number }>(entries: readonly T[], sort: 'installs' | 'az'): T[] {
  const list = [...entries]
  if (sort === 'az') {
    list.sort((a, b) => a.name.localeCompare(b.name, 'en'))
    return list
  }
  list.sort((a, b) => (b.installs ?? -1) - (a.installs ?? -1))
  return list.slice(0, SKILLS_SH_TOP_N)
}
