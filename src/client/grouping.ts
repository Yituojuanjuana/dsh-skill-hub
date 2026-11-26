/**
 * Pure grouping helpers for the skill-hub panel (no React/DOM deps, so the
 * merge/classify/filter logic stays unit-testable).
 *
 * A skill's enabled state is global (the file is renamed once), so a group's
 * switch state is derived from its members' actual states: all members enabled
 * → 'on', all disabled → 'off', otherwise 'mixed'. The panel derives groups
 * from three axes — usage rank, discovery location, and an automatic role
 * classification — none of which is stored on disk.
 */

import type { CatalogSkill } from '../protocol.ts'
import { isProjectSource } from '../protocol.ts'

export { isProjectSource }

/** Grouped switch state derived from member enablement. */
export type GroupSwitchState = 'on' | 'off' | 'mixed'

/** The derived switch view of one group. */
export interface GroupSwitchView {
  state: GroupSwitchState
  /** Writable members currently enabled. */
  enabled: string[]
  /** Writable members currently disabled. */
  disabled: string[]
}

/**
 * Derive a group switch view from its member names and the set of currently
 * enabled skill names (catalog.skills). Members not in the enabled set count
 * as disabled (catalog.disabled or absent read-only rows).
 */
export function groupSwitchView(members: readonly string[], enabledNames: ReadonlySet<string>): GroupSwitchView {
  const enabled: string[] = []
  const disabled: string[] = []
  for (const name of members) {
    if (enabledNames.has(name)) enabled.push(name)
    else disabled.push(name)
  }
  const state: GroupSwitchState = disabled.length === 0 ? 'on' : enabled.length === 0 ? 'off' : 'mixed'
  return { state, enabled, disabled }
}


/**
 * Members of a group that are currently enabled AND also belong to at least
 * one other group — the set a "close" action must ask about.
 */
export function conflictsOnClose(
  members: readonly string[],
  enabledNames: ReadonlySet<string>,
  otherGroups: ReadonlyArray<{ members: readonly string[] }>,
): string[] {
  return members.filter((name) => {
    if (!enabledNames.has(name)) return false
    return otherGroups.some((group) => group.members.includes(name))
  })
}

/** Origin-repo filter value: skills with no source record (private skills). */
export const PRIVATE_SOURCE = 'private'

/**
 * Apply the origin filter ('all' or a specific origin repo; skills without a
 * source record count as PRIVATE_SOURCE). The origins map is the store's
 * skillName → repo derivation, so filtering follows the tracked source
 * records instead of the filesystem root a skill happens to live under.
 * 项目级技能（有 workspace 归属）永远不算「个人」。
 */
export function filterBySource(skills: readonly CatalogSkill[], source: string, origins: Readonly<Record<string, string>>): CatalogSkill[] {
  if (source === 'all') return [...skills]
  return skills.filter((skill) => {
    if (isProjectSource(skill.source)) return false
    return (origins[skill.name] ?? PRIVATE_SOURCE) === source
  })
}

/**
 * 「已装 N 个」的判据：只数 catalog 里真实存在的技能名。
 *
 * `source.skills` 是导入时写下的名字清单；技能文件被 hub 之外的方式删掉
 * （git 切分支、手工清理、外部工具）之后名字会留着，直接数它会让市场行
 * 显示「已装 3 个」而下面只有 1 行。
 *
 * `catalogLoaded=false` 时退回清单长度：冷启动那一瞬间宁可先显示旧值，
 * 也不要在用户眼皮底下把「已装 3 个」闪成 0。
 */
export function countInstalled(record: { skills: readonly string[] } | undefined, installed: ReadonlySet<string>, catalogLoaded: boolean): number {
  if (record === undefined) return 0
  if (!catalogLoaded) return record.skills.length
  return record.skills.filter((name) => installed.has(name)).length
}

// 停用技能已在 `catalog.skills` 里带 `modelOverride` 呈现；sidecar 的
// `disabled[]` 退为纯台账（占名、恢复归属、详情反推），不再作为第二种技能行
// 渲染。因此不再需要 dropShadowedDisabled / visibleDisabledRecords 这条链路。

/** Status filter values shared by the list shell and the row components. */
export type SkillStatusFilter = 'all' | 'enabled' | 'disabled'
/** Invocation filter values (who may trigger the skill). */
export type InvocationFilter = 'all' | 'model' | 'user'

/**
 * Free-text + invocation filtering. Deliberately view-independent: every view
 * applies it, including the role cards, because typing in the search box is an
 * explicit, momentary narrowing.
 */
export function filterSkillsByQuery(
  skills: readonly CatalogSkill[],
  query: string,
  invocation: InvocationFilter,
): CatalogSkill[] {
  const normalized = query.trim().toLocaleLowerCase()
  return skills.filter((skill) => {
    if (invocation === 'model' && !skill.invocation.modelInvocable) return false
    if (invocation === 'user' && !skill.invocation.userInvocable) return false
    if (normalized.length === 0) return true
    return skill.name.toLocaleLowerCase().includes(normalized)
      || skill.description.toLocaleLowerCase().includes(normalized)
      || skill.displayName?.toLocaleLowerCase().includes(normalized)
      || skill.shortDescription?.toLocaleLowerCase().includes(normalized)
  })
}

/**
 * The status filter belongs to list views only. Role cards skip it: a role is a
 * roster the user curated by hand, so hiding paused members — or losing the
 * whole card once every member is filtered out — reads as data loss.
 */
export function filterSkillsByStatus(skills: readonly CatalogSkill[], status: SkillStatusFilter): CatalogSkill[] {
  if (status === 'all') return [...skills]
  return skills.filter((skill) => {
    // Project and external read-only skills are never moved into the disabled
    // sidecar; their switch is an invocation override. Keep every toggleable
    // override row for the "disabled" view, not only project ones.
    if (status === 'disabled') return skill.toggleable === true && skill.modelOverride === true
    return skill.modelOverride !== true
  })
}

/* ------------------------------------------------------- automatic roles */

/**
 * Role ids the hub derives automatically. This is a presentation axis only:
 * nothing is written to disk, so a role can never drift out of sync with the
 * catalog. Manual tags (SkillTag) stay a separate, user-curated axis.
 */
export type RoleId = 'design' | 'dev' | 'doc' | 'media' | 'data' | 'research' | 'ops' | 'office' | 'other'

/**
 * A keyword with its evidence weight. 4 = the word almost names the role,
 * 2 = supporting evidence, 1 = a hint that must not decide anything alone.
 */
type RoleKeyword = readonly [text: string, weight: number]

/**
 * Keyword rules per role, earlier rules winning ties. Generic words that show up
 * in nearly every SKILL.md (`skill`, `agent`, `web`, `tool`) are deliberately
 * absent: they would pull unrelated skills into whichever rule listed them.
 */
const ROLE_RULES: ReadonlyArray<{ id: RoleId; keywords: readonly RoleKeyword[] }> = [
  { id: 'office', keywords: [['office', 4], ['docx', 4], ['xlsx', 4], ['pptx', 4], ['powerpoint', 4], ['ppt', 4], ['spreadsheet', 4], ['excel', 4], ['word', 3], ['pdf', 3], ['办公', 4]] },
  { id: 'design', keywords: [['design', 4], ['figma', 4], ['css', 4], ['typography', 4], ['brand', 4], ['layout', 3], ['visual', 3], ['interface', 3], ['ui', 2], ['ux', 3], ['landing', 3], ['token', 3], ['taste', 4], ['设计', 3], ['界面', 4], ['排版', 3], ['配色', 3]] },
  { id: 'dev', keywords: [['react', 4], ['vue', 4], ['typescript', 4], ['javascript', 4], ['tdd', 4], ['refactor', 4], ['debug', 4], ['bug', 4], ['lint', 4], ['commit', 4], ['git', 4], ['api', 3], ['code', 2], ['test', 3], ['build', 2], ['开发', 4], ['代码', 4], ['测试', 4], ['调试', 4], ['重构', 4]] },
  { id: 'media', keywords: [['image', 4], ['video', 4], ['photo', 4], ['poster', 4], ['cover', 4], ['animation', 4], ['motion', 4], ['remotion', 4], ['canvas', 3], ['art', 4], ['audio', 4], ['p5', 3], ['card', 2], ['图片', 4], ['视频', 4], ['卡片', 3], ['封面', 4], ['海报', 4], ['动画', 4]] },
  { id: 'data', keywords: [['data', 2], ['csv', 4], ['sql', 4], ['chart', 4], ['analytics', 4], ['analysis', 2], ['statistic', 4], ['metric', 4], ['query', 3], ['数据', 3], ['表格', 3], ['图表', 4], ['统计', 4]] },
  { id: 'research', keywords: [['search', 4], ['research', 4], ['discover', 3], ['crawl', 4], ['scrape', 4], ['github', 4], ['browse', 3], ['搜索', 4], ['研究', 4], ['检索', 4]] },
  { id: 'doc', keywords: [['document', 4], ['documentation', 4], ['writing', 4], ['write', 3], ['article', 4], ['blog', 4], ['markdown', 4], ['notion', 4], ['readme', 4], ['glossary', 4], ['adr', 4], ['spec', 2], ['doc', 4], ['文档', 4], ['文章', 4], ['笔记', 4], ['写作', 4]] },
  { id: 'ops', keywords: [['sandbox', 4], ['acl', 4], ['disk', 4], ['cleanup', 4], ['uninstall', 4], ['install', 4], ['plugin', 4], ['config', 4], ['setup', 4], ['deploy', 4], ['hook', 3], ['memory', 4], ['permission', 4], ['cli', 3], ['系统', 4], ['安装', 4], ['配置', 4], ['清理', 4], ['权限', 4]] },
]

/**
 * Minimum score before a role claims a skill. Below it the skill stays in
 * `other` — a wrong group is worse than no group, because the heading then lies
 * about its contents.
 */
const MIN_SCORE = 4

/** Name evidence counts double: the name is the author's own one-word summary. */
const NAME_FACTOR = 2

/**
 * Split text into lowercase tokens. ASCII words stay whole; a CJK run is emitted
 * both as one token and as its individual characters, so a two-character keyword
 * such as 排版 still matches inside a longer run such as 把文档排版成网页.
 */
function tokensOf(text: string): Set<string> {
  const tokens = new Set<string>()
  for (const raw of text.toLocaleLowerCase().split(/[^a-z0-9+#.\u3400-\u9fff]+/)) {
    if (raw === '') continue
    tokens.add(raw)
    // Individual characters, so short CJK keywords can match as substrings.
    if (/[\u3400-\u9fff]/.test(raw) && raw.length > 1) {
      for (const char of raw) tokens.add(char)
    }
  }
  return tokens
}

/**
 * Match one keyword against a token set. ASCII keywords of 4+ characters also
 * match as a prefix (`test` finds `testing`, `install` finds `installing`);
 * shorter ones must match a whole token, so `ui` never fires on `build`.
 * CJK keywords match as a plain substring.
 */
function matchesKeyword(tokens: Set<string>, keyword: string): boolean {
  if (!/^[a-z0-9+#.]+$/.test(keyword)) {
    for (const token of tokens) if (token.includes(keyword)) return true
    return false
  }
  if (tokens.has(keyword)) return true
  if (keyword.length < 4) return false
  for (const token of tokens) if (token.startsWith(keyword)) return true
  return false
}

/** Score one rule: name hits weigh double, description hits weigh once. */
function scoreRule(rule: { keywords: readonly RoleKeyword[] }, nameTokens: Set<string>, textTokens: Set<string>): number {
  let score = 0
  for (const [keyword, weight] of rule.keywords) {
    if (matchesKeyword(nameTokens, keyword)) score += weight * NAME_FACTOR
    else if (matchesKeyword(textTokens, keyword)) score += weight
  }
  return score
}

/**
 * Classify one skill into a role from keyword evidence in its name, description
 * and whenToUse. Deterministic and offline: no model call, no disk writes, so
 * the same catalog always renders the same groups.
 */
export function classifyRole(skill: { name: string; description?: string; whenToUse?: string }): RoleId {
  const nameTokens = tokensOf(skill.name)
  const textTokens = tokensOf((skill.description ?? '') + ' ' + (skill.whenToUse ?? ''))
  let best: RoleId = 'other'
  let bestScore = MIN_SCORE - 1
  for (const rule of ROLE_RULES) {
    const score = scoreRule(rule, nameTokens, textTokens)
    // Strictly greater: an earlier rule keeps the win on a tie.
    if (score > bestScore) { best = rule.id; bestScore = score }
  }
  return best
}

/** One auto-derived role with its members. */
export interface RoleGroup {
  id: RoleId
  skills: CatalogSkill[]
}

/**
 * Group skills into auto roles, in rule order, with `other` last. Empty roles
 * are dropped so the panel never renders a heading with nothing under it.
 */
/**
 * 组间排序口径：按**组内首个成员**在传入 skills 序列里的位置排。
 *
 * 调用方传入的是已按 sortKey 排好序的列表（hub.sorted），所以「组内首项」就是
 * 该组里排名最高的技能。组间按各自最高排名的技能比较，等价于「把每组最好
 * 的那一项拎出来比赛」，与用户的排序直觉一致；同名次按组 id 兜底，稳定不跳。
 * @param groups - 已分组的组（成员顺序应保持传入 skills 的顺序）。
 * @param ordered - 与分组同源的、已排序的技能序列，用于查首项名次。
 * @returns 排好组间顺序的新数组（不改入参）。
 */
export function sortGroupsByRank<T extends { id: string; skills: readonly CatalogSkill[] }>(
  groups: readonly T[],
  ordered: readonly CatalogSkill[],
): T[] {
  const rank = new Map<string, number>()
  ordered.forEach((skill, index) => { if (!rank.has(skill.name)) rank.set(skill.name, index) })
  const firstRank = (group: T): number => {
    let best = Number.POSITIVE_INFINITY
    for (const skill of group.skills) best = Math.min(best, rank.get(skill.name) ?? Number.POSITIVE_INFINITY)
    return best
  }
  return [...groups].sort((a, b) => firstRank(a) - firstRank(b) || a.id.localeCompare(b.id))
}

export function groupByRole(skills: readonly CatalogSkill[]): RoleGroup[] {
  const buckets = new Map<RoleId, CatalogSkill[]>()
  for (const skill of skills) {
    if (isProjectSource(skill.source)) continue
    const id = classifyRole(skill)
    const bucket = buckets.get(id)
    if (bucket === undefined) buckets.set(id, [skill])
    else bucket.push(skill)
  }
  const order: RoleId[] = [...ROLE_RULES.map((rule) => rule.id), 'other']
  const groups: RoleGroup[] = []
  for (const id of order) {
    const members = buckets.get(id)
    if (members !== undefined && members.length > 0) groups.push({ id, skills: members })
  }
  return groups
}

/** One discovery root (where the skill files live) with its members. */
export interface LocationGroup {
  /** Discovery source id: `user-dsh`, `user-agents`, `agent-codex`, … */
  id: string
  skills: CatalogSkill[]
}

/** Local roots come first — they are the ones the hub can actually write. */
const LOCAL_LOCATIONS = ['user-dsh', 'user-agents']

function locationRank(id: string): number {
  const index = LOCAL_LOCATIONS.indexOf(id)
  return index === -1 ? LOCAL_LOCATIONS.length : index
}

/**
 * Group skills by the discovery root that produced them (`CatalogSkill.source`).
 * This is the "location" axis, orthogonal to the upstream origin (`origins`)
 * and to roles. Project skills are left out on purpose: the workspace tab
 * already groups them, and a project root is really its workspace path.
 */
export function groupByLocation(skills: readonly CatalogSkill[]): LocationGroup[] {
  const buckets = new Map<string, CatalogSkill[]>()
  for (const skill of skills) {
    if (isProjectSource(skill.source)) continue
    const bucket = buckets.get(skill.source)
    if (bucket === undefined) buckets.set(skill.source, [skill])
    else bucket.push(skill)
  }
  return [...buckets.entries()]
    .map(([id, members]) => ({ id, skills: members }))
    .sort((a, b) => locationRank(a.id) - locationRank(b.id) || a.id.localeCompare(b.id))
}

/**
 * Total calls for one skill, used by the usage view's ranking.
 * The permanent ledger wins over the session-log counter because the ledger
 * survives session deletion; the log count is only a fallback.
 */
export function usageTotal(stat: { count: number; permanent?: { total: number } } | undefined): number {
  if (stat === undefined) return 0
  return stat.permanent?.total ?? stat.count
}

/** Skills ordered by total calls, highest first. Ties keep the input order. */
export function sortByUsage<T extends { name: string }>(
  skills: readonly T[],
  uses: ReadonlyMap<string, { count: number; permanent?: { total: number } }>,
): T[] {
  return [...skills].sort((a, b) => usageTotal(uses.get(b.name)) - usageTotal(uses.get(a.name)))
}

/** Catalog sort keys offered by the filter bar. */
export type SortKey = 'name' | 'added' | 'uses'

/**
 * Sort a skill list in place-safe copy order: name ascending, added
 * descending (newest first, unknown addedAt last), or uses descending
 * (most-called first). Unknown values always trail.
 */
export function sortSkills(skills: readonly CatalogSkill[], key: SortKey, getUses?: (name: string) => number | undefined): CatalogSkill[] {
  const list = [...skills]
  if (key === 'name') {
    list.sort((a, b) => a.name.localeCompare(b.name))
  } else if (key === 'added') {
    list.sort((a, b) => (b.addedAt ?? -Infinity) - (a.addedAt ?? -Infinity))
  } else if (key === 'uses') {
    list.sort((a, b) => (getUses?.(b.name) ?? 0) - (getUses?.(a.name) ?? 0))
  }
  return list
}

/** Localized relative-time tuple; the caller resolves it via tt(). */
export interface RelativeTime {
  key: 'time.justNow' | 'time.minutesAgo' | 'time.hoursAgo' | 'time.daysAgo' | 'time.weeksAgo'
  value?: number
}

/** Format an epoch-ms timestamp as a short relative time bucket. */
export function formatRelativeTime(ms: number, now = Date.now()): RelativeTime {
  const diff = Math.max(0, now - ms)
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return { key: 'time.justNow' }
  if (minutes < 60) return { key: 'time.minutesAgo', value: minutes }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return { key: 'time.hoursAgo', value: hours }
  const days = Math.floor(hours / 24)
  if (days < 7) return { key: 'time.daysAgo', value: days }
  return { key: 'time.weeksAgo', value: Math.floor(days / 7) }
}
