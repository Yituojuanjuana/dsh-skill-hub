/**
 * Root path of the skill-shelf API family. The host also registers this as its
 * 404 catch-all prefix, so a mistyped path answers with a plain 404 naming the
 * path instead of falling through to the SPA fallback (which answers 401 and
 * reads like an auth problem).
 */
export const SKILL_HUB_API_ROOT = '/api/skill-shelf'

/**
 * 写接口的 CSRF 标记头。
 *
 * 信任栅栏（Host / Origin / 会话）回答的是「谁在发」，这一层回答的是
 * 「这是不是本插件页面发的」：浏览器不允许表单提交、`<img>`、`sendBeacon`
 * 和简单跨源 fetch 携带自定义头，所以别的站点构造出来的 POST 到不了处理器。
 * 同源请求不触发 CORS 预检，因此不增加一次往返；跨源时预检会先撞上围栏
 * 直接失败，也不会漏过来。
 *
 * 只对 POST 生效 —— GET 不改状态，加上它只会让只读接口更难调。
 */
export const SKILL_HUB_WRITE_HEADER = 'x-dsh-skill-shelf'
export const SKILL_HUB_WRITE_VALUE = '1'

/**
 * Browser-facing base paths of the skill-shelf API family.
 *
 * Naming rule: a path's segments mirror its scope. Market sources own the
 * `/market/source/*` subtree — add, delete, ref, versions, check, sync — so
 * the update check and the sync that acts on its result sit side by side.
 */
export const SKILL_HUB_API = {
  catalog: '/api/skill-shelf/catalog',
  skill: '/api/skill-shelf/skill',
  skillDelete: '/api/skill-shelf/skill/delete',
  toggle: '/api/skill-shelf/toggle',
  toggleBatch: '/api/skill-shelf/toggle-batch',
  create: '/api/skill-shelf/create',
  config: '/api/skill-shelf/config',
  market: '/api/skill-shelf/market',
  marketSource: '/api/skill-shelf/market/source',
  marketSourceDelete: '/api/skill-shelf/market/source/delete',
  marketSourceRef: '/api/skill-shelf/market/source/ref',
  marketCheck: '/api/skill-shelf/market/source/check',
  marketSync: '/api/skill-shelf/market/source/sync',
  repo: '/api/skill-shelf/repo',
  repoImport: '/api/skill-shelf/repo/import',
  repoImportProgress: '/api/skill-shelf/repo/import/progress',
  repoImportCancel: '/api/skill-shelf/repo/import/cancel',
  update: '/api/skill-shelf/update',
  updateApply: '/api/skill-shelf/update/apply',
  groups: '/api/skill-shelf/groups',
  tag: '/api/skill-shelf/tag',
  tagDelete: '/api/skill-shelf/tag/delete',
  tagMembers: '/api/skill-shelf/tag/members',
  tagReorder: '/api/skill-shelf/tag/reorder',
  collectionReorder: '/api/skill-shelf/collections/reorder',
  sourceGroupReorder: '/api/skill-shelf/source-groups/reorder',
  sources: '/api/skill-shelf/sources',
  sourceCheck: '/api/skill-shelf/sources/check',
  sourceSync: '/api/skill-shelf/sources/sync',
  sourceDelete: '/api/skill-shelf/sources/delete',
  sourceRestore: '/api/skill-shelf/sources/restore',
  sourceTrashClear: '/api/skill-shelf/sources/trash/clear',
  diagnosticFix: '/api/skill-shelf/diagnostic/fix',
  marketSourceVersions: '/api/skill-shelf/market/source/versions',
  marketStats: '/api/skill-shelf/market/stats',
  marketSkillsSh: '/api/skill-shelf/market/skills-sh',
  marketSkillsShInstall: '/api/skill-shelf/market/skills-sh/install',
  marketSkillsShDetail: '/api/skill-shelf/market/skills-sh/detail',
  foreign: '/api/skill-shelf/foreign',
  foreignImport: '/api/skill-shelf/foreign/import',
  importZip: '/api/skill-shelf/import/zip',
  permanentStats: '/api/skill-shelf/permanent-stats',
  evolution: '/api/skill-shelf/evolution',
  evolutionRun: '/api/skill-shelf/evolution/run',
  evolutionDecide: '/api/skill-shelf/evolution/decide',
  evolutionClear: '/api/skill-shelf/evolution/clear',
  evolutionReparse: '/api/skill-shelf/evolution/reparse',
  evolutionTuning: '/api/skill-shelf/evolution/tuning',
} as const

/**
 * Standalone alias for the permanent-stats path (also available as
 * `SKILL_HUB_API.permanentStats`). Kept as a named export because that is the
 * name the client half imports for its fetch call.
 */
export const SKILL_USAGE_API = '/api/skill-shelf/permanent-stats'

/** Permanent usage counter: one row per skill, bucketed by local day/week. */
export interface PermanentStat {
  name: string
  today: number
  week: number
  total: number
  lastUsed: number
  /**
   * 历史成功率（0~1）。
   *
   * 只在账本里存在带 `ok` 标记的条目时才有值 —— 缺省表示「未知」，
   * 界面显示「-」而不是 0%。进化模块与通用页都用它。
   */
  successRate?: number
}

export interface PermanentStatsResponse {
  ok: true
  stats: PermanentStat[]
  skipped: number
  note: string
}
