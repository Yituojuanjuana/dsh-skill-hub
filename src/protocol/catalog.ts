/** User-level roots the hub may write to (matches dsh-skill-filesystem ranks 400/500). */
export type WritableRoot = 'user-dsh' | 'user-agents'

/** Invocation policy resolved by the registry, re-spelled for the wire. */
export interface HubInvocation {
  /** Whether model-facing catalogs may load this skill. */
  modelInvocable: boolean
  /** Whether human-facing command catalogs may load this skill. */
  userInvocable: boolean
}

/** One enabled skill row in the catalog. */
export interface CatalogSkill {
  name: string
  description: string
  whenToUse?: string
  invocation: HubInvocation
  provider: string
  /** Whether the hub may toggle this skill by renaming files (user-level filesystem skills only). */
  writable: boolean
  /**
   * Whether the hub may toggle this skill without touching its files
   * (an invocation override flips `modelInvocable`). This covers project
   * skills and read-only external providers; `writable` implies toggling too.
   */
  toggleable?: boolean
  /** The hub has switched this skill's model invocation off (invocation override; `/name` still works). */
  modelOverride?: boolean
  /** 技能来源标识（user-dsh/user-agents/project-dsh/project-agents/...）。 */
  source: string
  /**
   * 前端能否修改该技能的调用权限（写 SKILL.md frontmatter）。
   *
   * 服务端按「路径是否落在任一已知技能根内 + 文件是否可写」算，与路由的
   * invocation 写入判据同源 —— 避免「按钮能点但后端 403」。
   * 旧数据缺字段时前端按 true 处理（保持旧行为）。
   */
  invocationWritable?: boolean
  /** SKILL.md creation time (epoch ms); used for "added" sorting. Absent when unknown. */
  addedAt?: number
  /** SKILL.md last-modified time (epoch ms); used for "updated" display. Absent when unknown. */
  updatedAt?: number
  /** 项目技能的所属工作区路径（仅 project-dsh/project-agents 来源携带）。 */
  workspace?: string
  /** 工作区显示标题（来自 workspace.json；无则回退为路径）。 */
  workspaceTitle?: string
  /** UI metadata from agents/openai.yaml (mirrors codex SkillInterface). */
  displayName?: string
  shortDescription?: string
  brandColor?: string
  iconSmall?: string
  iconLarge?: string
  defaultPrompt?: string
}

/**
 * 停用台账的一条记录。**不是启用态的真值**。
 *
 * 真值是 sidecar 的 `invocationOverrides`（发现文件绝对路径集合）：provider
 * 只认它，`CatalogSkill.modelOverride` 由它派生。这里存 name / path / root /
 * description / disabledAt，用于占名、恢复归属和详情反推 —— 后两项是
 * overrides 没有的信息，所以两份数据不能合并。
 *
 * 判定「某个技能是否停用」必须看 `CatalogSkill.modelOverride`，**不要拿这个
 * 数组反查**：项目技能与外部只读技能停用时只写覆盖，根本不进台账。
 */
export interface DisabledSkill {
  name: string
  description: string
  /** Absolute path of the discovery file (SKILL.md / <name>.md), still in place. */
  path: string
  root: WritableRoot
  disabledAt: number
}

/** One diagnostic: either a file the provider skips, or a loadable skill with an issue. */
export interface DiagnosticEntry {
  path: string
  root: string
  reason: string
  /**
   * 面板呈现级别。`error` = 这个文件被 provider 跳过（解析失败、不可读、
   * 同名冲突、阻断级审计命中），技能压根进不了列表；`warn` = 技能能加载，
   * 但 frontmatter 或正文有值得处理的问题。由扫描端单点判定，UI 不做猜测。
   */
  level: 'error' | 'warn'
  /** Whether this diagnostic can be auto-fixed (e.g. unquoted colon). */
  fixable?: boolean
  /**
   * 条目来源。缺省 = 发现诊断（frontmatter / 发现路径 / 同名冲突等）；
   * `security` = 内容审计（正文里有值得看一眼的东西）。两者共用同一块 UI，
   * 但 security 条目不能「修复」，只能说清问题在哪一行。
   */
  kind?: 'security'
  /** security 条目的原始严重度；发现诊断条目省略，统一用上面的 level 呈现。 */
  severity?: 'block' | 'warn'
}

/**
 * 技能目录在 system prompt 里占用的公告成本。渐进加载的第一层只放
 * name + description，每个 token 都常驻在每一轮请求里 —— 面板要把这个
 * 数字显示出来，但它不是「能不能触发」的开关（见下）。
 */
export interface AnnouncementBudget {
  /** 参与公告的技能数（已启用且 modelInvocable）。 */
  skills: number
  /** name + 截断后的 description 总字符数，即 DSH 真正渲染的长度。 */
  chars: number
  /** 粗略 token 估算（按 3 字符/token）。 */
  approxTokens: number
  /** 单条描述的上限（字符），与 DSH 的 catalogDescriptionMaxLength 默认值一致。 */
  descriptionMaxLength: number
  /** 因超过单条上限而被截断的技能数。 */
  truncated: number
}

/**
 * DSH 渲染技能目录时对**单条** description 的上限，对应
 * `dsh-tool-skill` 的 catalogDescriptionMaxLength（默认 500，最小 3）。
 * 超出部分被替换为 "..."，但这只影响摘要长度，不影响条目是否出现。
 */
export const CATALOG_DESCRIPTION_MAX_LENGTH = 500

/**
 * 按「已启用且模型可调用」的技能估算公告成本。
 *
 * 口径对齐 DSH 的实际渲染（dsh-tool-skill/lib/index.js → renderCatalogEntries）：
 * 每条只渲染 `- \`name\`: description`，description 先压平空白再按
 * catalogDescriptionMaxLength 截断；`whenToUse` 不参与渲染。
 *
 * 注意这里**没有总量上限**：DSH 不做尾部丢弃，技能装多少就渲染多少，
 * 超出 8000 字符只是多花常驻 token，不会让技能「不触发」。
 */
export function computeAnnouncementBudget(skills: readonly CatalogSkill[]): AnnouncementBudget {
  let chars = 0
  let count = 0
  let truncated = 0
  for (const skill of skills) {
    if (!skill.invocation.modelInvocable) continue
    count += 1
    const description = skill.description.replace(/\s+/g, ' ').trim()
    if (description.length > CATALOG_DESCRIPTION_MAX_LENGTH) truncated += 1
    const rendered =
      description.length <= CATALOG_DESCRIPTION_MAX_LENGTH
        ? description
        : `${description.slice(0, CATALOG_DESCRIPTION_MAX_LENGTH - 3)}...`
    chars += skill.name.length + rendered.length
  }
  return {
    skills: count,
    chars,
    approxTokens: Math.ceil(chars / 3),
    descriptionMaxLength: CATALOG_DESCRIPTION_MAX_LENGTH,
    truncated,
  }
}

/** POST /api/skill-shelf/diagnostic/fix — repair a fixable diagnostic in place. */
export interface DiagnosticFixRequest {
  path: string
}
export interface DiagnosticFixResponse {
  ok: true
  path: string
}

/** GET /api/skill-shelf/catalog */
export interface CatalogResponse {
  ok: true
  /** 已安装插件自身的版本号（package.json version），面板标题旁显示。 */
  pluginVersion: string
  /** Whether discovery completed within a stable catalog revision. */
  complete: boolean
  /** Sorted winning summaries of every enabled skill (all roots + providers). */
  skills: CatalogSkill[]
  /** Skills the hub has toggled off (kept outside provider discovery). */
  disabled: DisabledSkill[]
  /** Known workspaces (dsh workspace.json); used by the create dialog. */
  workspaces?: Array<{ path: string; title: string }>
  /** 当前对话所在的工作区路径；面板据此预选工作区下拉的默认项。 */
  currentWorkspace?: string
  /** Graded diagnostics for the writable roots (provider-skipped files + loadable skills with issues). */
  diagnostics: DiagnosticEntry[]
  /** 技能目录占用的公告预算（见 AnnouncementBudget）。 */
  announcement: AnnouncementBudget
  /** Skill names that appeared in multiple roots (first wins, others hidden). Mirrors codex name_counts. */
  duplicateNames?: string[]
}

/** GET /api/skill-shelf/skill */
export interface SkillDetail {
  name: string
  description: string
  whenToUse?: string
  /** Claude Code 的 `argument-hint`（/name 的参数提示），dsh 不消费，详情里展示。 */
  argumentHint?: string
  invocation: HubInvocation
  provider: string
  /** Discovery source that produced this winning skill. */
  source?: string
  /** Absolute file path when the skill came from disk. */
  path?: string
  /** SKILL.md creation time (epoch ms); absent when the file is unreadable. */
  addedAt?: number
  /** SKILL.md last-modified time (epoch ms); absent when the file is unreadable. */
  updatedAt?: number
  /** Markdown instruction body. */
  content: string
  displayName?: string
  shortDescription?: string
  brandColor?: string
  iconSmall?: string
  iconLarge?: string
  defaultPrompt?: string
}

export interface SkillDetailResponse {
  ok: true
  skill: SkillDetail
}

/** POST /api/skill-shelf/skill/delete — 把单个技能移入回收站（可恢复）。 */
export interface SkillDeleteRequest {
  name: string
}

/** POST /api/skill-shelf/skill/delete */
export interface SkillDeleteResponse {
  ok: true
  name: string
  /** 移入回收站后的路径（目录或文件）。 */
  path: string
}

/** POST /api/skill-shelf/skill/invocation — 修改 frontmatter 里的两个调用开关。 */
export interface SkillInvocationRequest {
  name: string
  modelInvocable?: boolean
  userInvocable?: boolean
  /** 工作区技能需要带 cwd（与 delete/toggle 一致）。 */
  cwd?: string
}

export interface SkillInvocationResponse {
  ok: true
  name: string
  invocation: { modelInvocable: boolean; userInvocable: boolean }
  /** 该技能有上游来源：同步会覆盖这次 frontmatter 改动。UI 必须警告。 */
  sourceWillOverwrite?: boolean
}

/** POST /api/skill-shelf/toggle */
export interface ToggleRequest {
  /** Kebab-case skill name. */
  name: string
  /** true re-enables a hub-disabled skill; false disables an enabled one. */
  enabled: boolean
  /** Workspace path for project-level skills (passed through as the registry cwd). */
  cwd?: string
}

export interface ToggleResponse {
  ok: true
  /** Fresh catalog after the mutation (the filesystem provider may lag a beat). */
  catalog: CatalogResponse
}

/** POST /api/skill-shelf/toggle-batch — one group of skills, one write. */
export interface ToggleBatchRequest {
  names: string[]
  enabled: boolean
  /** Workspace path when the names belong to one project workspace. */
  cwd?: string
}

/** POST /api/skill-shelf/toggle-batch */
export interface ToggleBatchResponse {
  ok: true
  catalog: CatalogResponse
  /** Per-name failures (unknown/read-only skills); empty means all landed. */
  failures: Array<{ name: string; error: string }>
}

/** POST /api/skill-shelf/create */
export interface CreateRequest {
  /** Kebab-case skill name (validated with the official isSkillName grammar). */
  name: string
  /** Optional one-line routing description for the frontmatter. */
  description?: string
  /** Optional Markdown body written after the frontmatter. */
  body?: string
  /** Target user root; defaults to user-dsh (~/.dsh/skills). */
  root?: WritableRoot
  /** Target workspace path (absolute); takes precedence over root. */
  workspace?: string
}

export interface CreateResponse {
  ok: true
  path: string
  root?: WritableRoot
  workspace?: string
}
