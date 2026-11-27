/**
 * 技能进化元代理（Skill Evolution Meta-Agent）的线上契约。
 *
 * 与上一版「自动采纳」的根本区别：**这个代理只产出提案文本，绝不读写任何技能
 * 文件**。所有提案落在一个独立的 JSON 里，等人审核；采纳与否是人的动作，
 * 由用户自己在技能页完成（或手动复制草稿）。
 */

/** 提案大类。 */
export type EvolutionProposalKind = 'new-skill' | 'optimize' | 'reclaim'

/** 新建技能的优先级。 */
export type EvolutionPriority = 'high' | 'medium' | 'low'

/**
 * 新建技能的建议动作。
 *
 * `niche` 是「细分专项」：任务大类已有通用技能覆盖，但属于某个业务平台
 * （如 sports-coach）的专属流程，重复出现 ≥2 次且每次都要额外交代业务规则，
 * 因此仍值得单独建一个专项技能。这类技能依赖已有的通用基础技能。
 */
export type EvolutionRecommendation = 'create' | 'niche' | 'observe'

/** 已有技能的变更类型。 */
export type EvolutionChangeType = 'modify' | 'merge' | 'archive'

/** 提案的人工处理状态。 */
export type EvolutionProposalStatus = 'pending' | 'accepted' | 'rejected' | 'deferred'

/**
 * 统计维度快照：提案生成时该技能的运行指标 + 回收站状态。
 *
 * 这是「四维联合评估」里的两个新维度（另两个是会话轨迹与驳回历史）。
 * 全部字段可选：早期提案没有这些数据，UI 要能优雅降级。
 */
export interface EvolutionSkillMetrics {
  /** 历史总调用次数。 */
  totalCalls?: number
  /** 近 7 天调用量。 */
  weekCalls?: number
  /** 历史成功率（0~1）。没有失败样本时为 undefined（不是 0）。 */
  successRate?: number
  /** 技能是否在回收站。 */
  inTrash?: boolean
  /** 移入回收站的时间（epoch ms）。 */
  trashedAt?: number
  /** 回收站备注。 */
  trashNote?: string
  /** 统计维度评估理由（为什么这条提案被判为优化/回收/拆分）。 */
  reason?: string
}

/** 一条提案。字段按 kind 分叉，UI 按 kind 渲染不同列。 */
export interface EvolutionProposal {
  id: string
  kind: EvolutionProposalKind
  /**
   * 技能 ID（kebab-case，可作目录名）。
   *
   * 新建提案由引擎规范化生成；优化提案沿用原技能 ID。
   */
  skillName: string
  /**
   * 该技能 frontmatter description 的快照，用于回收/优化提案的可读性，
   * 旧提案没有则 UI 整行不显示。只放 description 一行，超长按词边界截断。
   */
  skillSummary?: string
  /**
   * 当 description 确实含中文时的中文快照。宁缺勿造：没有真实中文就不写。
   */
  skillSummaryZh?: string
  /**
   * 卡片展示用的中文名称（精简名词短语）。
   *
   * 缺省时 UI 回退显示 `skillName` —— 早期提案没有这个字段。
   */
  displayName?: string
  /** 生成时间（epoch ms）。 */
  createdAt: number
  status: EvolutionProposalStatus

  // ---- new-skill ----
  priority?: EvolutionPriority
  /** 适用场景。 */
  scenario?: string
  /** 同类任务出现次数。 */
  occurrences?: number
  /** 收益。 */
  benefit?: string
  /** 潜在风险。 */
  risk?: string
  /** 新建 / 继续观察。 */
  recommendation?: EvolutionRecommendation
  /** 候选技能草稿（仅 recommendation=create 时有）。 */
  draft?: string

  // ---- optimize ----
  changeType?: EvolutionChangeType
  /** 痛点总结。 */
  painPoints?: string
  /** 新版技能源码（md / yaml）。 */
  newSource?: string
  /** 测试用例（正向 + 边界异常）。 */
  testCases?: string
  /** 风险评估。 */
  riskAssessment?: string
  /** 收益对比。 */
  benefitCompare?: string

  /**
   * 统计维度快照（历史调用量 / 成功率 / 回收站状态）。
   *
   * 由引擎在解析后回填 —— 模型只负责写提案文本，指标来自本地账本，不靠模型编。
   */
  metrics?: EvolutionSkillMetrics

  /**
   * 提案来源。
   *
   * - `analysis`：轨迹 + 统计挖掘产出（新建推荐 / 细分专项 / 轨迹优化）
   * - `scan`：全量技能主动扫描产出（只产优化提案）
   * - `reparse`：离线重新解析（复用已存 markdown）产出
   *
   * 前端据此展示来源标签，让用户分清「这条是怎么来的」。
   */
  source?: 'analysis' | 'scan' | 'reparse'

  /**
   * 优化提案的发现方式（仅 kind=optimize 时有值）。
   *
   * - `trajectory`：从会话轨迹里发现该技能被用出问题
   * - `scan`：主动扫描技能正文发现的缺陷
   *
   * 两类互补、不重复：同一技能的优化提案只会保留价值分更高的那一条。
   */
  discoveredBy?: 'trajectory' | 'scan'

  /**
   * 技能价值分（0~100）。
   *
   * 低于门槛的提案已在管线里被过滤，所以这里的值都 ≥ MIN_VALUE_SCORE。
   * 60~75 分会被标记「低价值观察」，前端默认折叠。
   */
  valueScore?: number

  /**
   * 技能的发现来源（`user-dsh` / `agent-trae-cn` / `bundled` / …）。
   *
   * 前端据此展示「归属目录」标签，分类与通用页「按目录」视图完全一致。
   * 新建类提案的技能尚未落地，这里为空 —— 前端显示「待落地」。
   */
  skillSource?: string

  /**
   * 落地目标：写进哪个目录。
   *
   * - `user-dsh`（默认）：`~/.dsh/skills`
   * - `user-agents`：`~/.agents/skills`
   * - `project`：写进 `targetWorkspace` 指向的工作区 `.dsh/skills`
   *
   * 细分专项技能属于某个具体业务项目，落地到 DSH 用户目录会让它在
   * 「工作区」页永远看不到 —— 必须写到对应工作区里。
   */
  targetRoot?: 'user-dsh' | 'user-agents' | 'project'

  /**
   * 落地目标工作区路径（`targetRoot === 'project'` 时必填）。
   *
   * 由引擎在生成提案时根据会话轨迹的 cwd 推断并写死，用户点「同意并落地」
   * 时不需要再选一次。
   */
  targetWorkspace?: string
}

/** 运行态快照（GET 接口返回，前端轮询用）。 */
export interface EvolutionRunStatus {
  /** 是否正在跑。 */
  running: boolean
  /** 本次运行开始时间（epoch ms）。 */
  startedAt?: number
  /** 已耗时（跑着时是实时值，跑完是总耗时）。 */
  elapsedMs: number
  /** 最近一次失败原因。 */
  lastError?: string
  /** 最近一次被跳过的原因。 */
  lastSkip?: string
}

/** 一次进化运行的结果。 */
export interface EvolutionRunResult {
  /** 完整提案文本（固定格式的 Markdown）。 */
  markdown: string
  /** 解析出的结构化提案（UI 列表用）。 */
  proposals: EvolutionProposal[]
  /** 本次读了多少个会话。 */
  sessions: number
  /** 本次读了多少条消息。 */
  messages: number
  /** 失败原因；成功为空。 */
  error?: string
  /** 未执行的原因（未开启 / 会话太少）。 */
  skipped?: string
}

/** 落盘的进化数据。 */
/**
 * 一条人工裁决记录（同意 / 驳回 / 暂缓）。
 *
 * 这是自适应参数校准的**唯一**数据来源。它与 `EvolutionRejection` 的区别：
 * 后者只记驳回、只用于抑制同类再生；这里记全部三种动作，且带理由归桶，
 * 好让「用户反复暂缓」「用户大量采纳」这类信号能被统计到。
 */
export interface EvolutionDecisionRecord {
  id: string
  kind: 'new-skill' | 'optimize' | 'reclaim'
  skillName: string
  action: 'accepted' | 'rejected' | 'deferred'
  /** 用户填写的原始理由；accepted 时可为空。 */
  reason: string
  /** 理由归桶：快捷理由映射到固定桶，自由文本为 `freeform`（只计数不驱动）。 */
  reasonBucket: string
  at: number
}

/**
 * 自适应参数校准状态（持久化）。
 *
 * 字段与 `evolution/tuning.ts` 的 `TuningState` 同形；在这里重复声明是为了
 * 让 `protocol` 不依赖 `evolution` 的实现模块。
 */
export interface EvolutionTuningState {
  params: Record<string, number>
  updatedAt: number
  basis: {
    total: number
    accepted: number
    rejected: number
    deferred: number
    buckets: Record<string, number>
    /** 按提案类别拆分的裁决计数，给「出现概率」卡片展示依据。 */
    byKind?: Partial<Record<EvolutionProposalKind, { total: number; accepted: number; rejected: number; deferred: number }>>
  }
  applied: string[]
  adjustedAt: Record<string, number>
  /**
   * 各类提案本轮进入列表的概率（0.25–1.0）。缺省 = 1.0（不抑制）。
   * 只影响提案**是否出现在列表**，绝不自动落地任何提案。
   * 另有一个内部开关 `probabilityEnabled`，关闭时概率恒为 1.0 且不给额外名额。
   */
  kindProbability?: Partial<Record<EvolutionProposalKind, number>>
  probabilityEnabled?: boolean
  /** 各类已累积的额外扫描名额（0–2），只增加输出数量，不放宽价值门槛。 */
  extraSlots?: Partial<Record<EvolutionProposalKind, number>>
  /** 被用户锁定的参数键：校准跳过它们。 */
  locked: string[]
}
/**
 * 校准状态的默认值（协议层版本，供路由占位使用）。
 *
 * 不引 evolution/tuning.ts：路由层不该依赖实现模块。真正的默认值
 * 只有一处定义，这里只给出「全默认」的空壳。
 */
export function defaultTuningState(): EvolutionTuningState {
  return {
    params: {},
    updatedAt: 0,
    basis: { total: 0, accepted: 0, rejected: 0, deferred: 0, buckets: {} },
    applied: [],
    adjustedAt: {},
    kindProbability: {},
    probabilityEnabled: true,
    locked: [],
  }
}

export interface EvolutionFile {
  version: number
  /** 最近一次完整提案文本。 */
  markdown: string
  /** 最近一次运行时间（epoch ms）。 */
  ranAt: number
  /** 结构化提案（全部历史）。 */
  proposals: EvolutionProposal[]
  /** 运行记录。 */
  runs: EvolutionRunRecord[]
  /** 驳回记录：同类场景据此不再重复生成无效提案。 */
  rejections: EvolutionRejection[]
  /**
   * 统一裁决台账（同意 / 驳回 / 暂缓）。
   *
   * 与 `rejections` 并存而非替换：`rejections` 是去重用的「抑制名单」，
   * 这份是校准用的「全量样本」—— 它还要记录**被采纳**和**被暂缓**的裁决，
   * 那两类此前完全不落盘，于是自适应校准学不到任何东西。
   *
   * 旧文件没有该字段时按空数组降级读（见 `hydrateEvolutionFile`）。
   */
  decisions?: EvolutionDecisionRecord[]
  /**
   * 自适应参数校准的当前状态。
   *
   * 旧文件没有该字段时回落到 `defaultTuning()`，参数即默认值。
   */
  tuning?: EvolutionTuningState
  /**
   * 上一次的提案列表（重新解析前自动备份，支持回滚）。
   *
   * 只保留一份 —— 每次重新解析覆盖它，避免无限增长。
   */
  previousProposals?: EvolutionProposal[]
}

/** 一次运行的摘要记录。 */
export interface EvolutionRunRecord {
  at: number
  sessions: number
  messages: number
  proposals: number
  error?: string
  skipped?: string
}

/** GET /api/skill-shelf/evolution — 当前提案与运行状态。 */
export interface EvolutionResponse {
  /** 自适应参数当前状态（旧数据无此字段时由服务端补默认值）。 */
  tuning?: EvolutionTuningState
  ok: true
  /** 元代理开关是否打开。 */
  enabled: boolean
  /** 最近一次完整提案文本。 */
  markdown: string
  /** 最近一次运行时间。 */
  ranAt: number
  proposals: EvolutionProposal[]
  runs: EvolutionRunRecord[]
  /** 驳回记录（面板展示 + 去重依据）。 */
  rejections: EvolutionRejection[]
  /** 是否正在跑（服务端真实状态，前端据此显示进度）。 */
  running: boolean
  /** 本次运行开始时间（epoch ms）。 */
  startedAt?: number
  /** 已耗时（跑着是实时值，跑完是总耗时）。 */
  elapsedMs: number
  /** 最近一次失败原因（模型失败 / 超时 / 空返回）。 */
  lastError?: string
  /** 最近一次被跳过的原因（未开启 / 无达标会话）。 */
  lastSkip?: string
}

/** POST /api/skill-shelf/evolution/run — 启动一次后台分析。 */
export interface EvolutionRunRequest {
  /** 只分析这个会话；缺省取最近的若干个。 */
  sessionId?: string
}

/**
 * 启动结果。
 *
 * 接口**立即返回**，不等分析跑完：`started` 表示这次真的启动了，
 * `alreadyRunning` 表示已有一个在跑（带上它的进度，前端直接展示）。
 */
export interface EvolutionRunResponse {
  ok: true
  /** 本次是否真的启动了新分析。 */
  started: boolean
  /** 已有一个分析在跑。 */
  alreadyRunning?: boolean
  /** 那个正在跑的分析的开始时间。 */
  startedAt?: number
  /** 那个正在跑的分析的已耗时。 */
  elapsedMs?: number
}

/** POST /api/skill-shelf/evolution/decide — 人工处理一条提案。 */
export interface EvolutionDecideRequest {
  id: string
  /** accepted = 同意并落地；rejected = 驳回（必须给原因）；deferred = 暂缓。 */
  status: 'accepted' | 'rejected' | 'deferred'
  /** 驳回 / 暂缓原因；驳回时必填，用于「同类场景不再重复生成」。 */
  reason?: string
  /** accepted 时写入哪个可写根（缺省 user-dsh）。 */
  root?: 'user-dsh' | 'user-agents'
}

export interface EvolutionDecideResponse {
  ok: true
  /** 落地后的技能名（可能与提案名不同，重名时自动加后缀）。 */
  appliedName?: string
  /** 落地后的技能文件路径。 */
  appliedPath?: string
  /** 旧版本备份路径（替换已有技能时）。 */
  backupPath?: string
  /** 落地失败原因（HTTP 仍 200，前端据 error 显示）。 */
  error?: string
}

/** 一条驳回记录：用于「同类场景不再重复生成无效提案」。 */
export interface EvolutionRejection {
  id: string
  /** 被驳回的技能名。 */
  skillName: string
  /** 驳回原因。 */
  reason: string
  /** 驳回时间（epoch ms）。 */
  at: number
  /**
   * 被驳回提案的类型。
   *
   * 用于**按类型隔离去重**：驳回一条「新建推荐」不该阻止同一技能日后
   * 出现「优化提案」，反之亦然 —— 三类驳回的语义本来就不同。
   * 旧记录没有该字段，按「不限制类型」处理（向后兼容）。
   */
  kind?: 'new-skill' | 'optimize' | 'reclaim'
}

/** POST /api/skill-shelf/evolution/clear — 清空提案。 */
export interface EvolutionClearResponse {
  ok: true
}

/**
 * POST /api/skill-shelf/evolution/reparse — 用已存的模型输出重新解析。
 *
 * 不调用模型、不读会话，纯本地文本处理。
 */
export interface EvolutionReparseResponse {
  ok: boolean
  /** 失败原因（输入不完整 / 解析异常 / 0 条有效提案）。 */
  error?: string
  /** 解析出的提案数。 */
  proposals: number
  /** 解析耗时（毫秒）。 */
  elapsedMs: number
  /** 各阶段丢弃统计。 */
  dropped?: { noDraft: number; invalid: number; rejected: number; duplicate: number }
  /** 是否有可用的历史 markdown（前端据此决定按钮置灰）。 */
  hasMarkdown?: boolean
}

/** POST /api/skill-shelf/evolution/apply — 把已通过的提案落地为技能文件。 */
export interface EvolutionApplyRequest {
  id: string
  root?: 'user-dsh' | 'user-agents'
}

export interface EvolutionApplyResponse {
  ok: true
  name: string
  path: string
  /** 替换已有技能时的旧版本备份目录。 */
  backupPath?: string
  /** 版本标签（写进 frontmatter）。 */
  version: string
}
