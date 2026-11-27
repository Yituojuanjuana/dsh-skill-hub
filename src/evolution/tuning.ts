/**
 * 自适应参数校准（确定性，不经模型）。
 *
 * 输入是人工裁决台账（同意 / 驳回 / 暂缓），输出是一组**新的过滤/采样/去重
 * 参数**。整个过程是纯函数：同样的输入永远得到同样的输出，没有随机、没有
 * 模型参与。
 *
 * ## 为什么这套调参不可能让提案自动落地
 *
 * 它只能改**提案生成端**的三个环节：价值门槛（哪些提案被过滤掉）、扫描/采样
 * 上限（一次生成多少条）、去重阈值（哪些重复提案被抑制）。落地的唯一入口是
 * `wiring.ts` 的 `decide(id, 'accepted')`，那条路径由人点击触发、且必须先
 * 通过 `applyProposal` 的文件写入。本模块既没有 `apply` 引用，也不产生任何
 * 提案对象 —— 它只返回数字。把门槛调到最低，最多让更多提案出现在待审核
 * 列表里，仍然要人点「同意并落地」才会写文件。
 *
 * @module evolution/tuning
 */

import type { EvolutionTuningState } from '../protocol/evolution.ts'

/** 可校准参数的默认值。改这里等于改所有新装实例的起点。 */
export const TUNING_DEFAULTS = {
  /** 价值分门槛：低于它直接丢弃。 */
  minValueScore: 60,
  /** 单次运行主动扫描提案上限。 */
  maxScanProposals: 5,
  /** 近 N 天内优化过的技能跳过扫描。 */
  recentOptimizeDays: 7,
  /** 会话进入分析的最低用户消息数。 */
  minUserMessages: 3,
  /** 单次分析最多采样会话数。 */
  maxSessions: 12,
  /** 零调用技能建议回收的「闲置天数」。 */
  staleDays: 30,
  /** 驳回去重的理由相似度阈值。 */
  reasonSimilarityThreshold: 0.34,
} as const

/** 可校准参数的键名。 */
export type TuningKey = keyof typeof TUNING_DEFAULTS

/** 当前生效的参数集合。 */
export type TuningParams = Record<TuningKey, number>

/**
 * 每个参数的上下界。**所有边界只在这里定义**，越界一律夹紧 ——
 * 不允许散落到各模块的魔法数字里。
 */
export const TUNABLE_BOUNDS: Readonly<Record<TuningKey, { min: number; max: number }>> = {
  // 价值门槛：55 是「放宽」的极限，75 是「收紧」的极限（再高会把正常提案也杀掉）。
  minValueScore: { min: 55, max: 75 },
  // 扫描上限：最低 3 保证每轮仍有观察名额，最高 7 防止一次刷屏。
  maxScanProposals: { min: 3, max: 7 },
  recentOptimizeDays: { min: 7, max: 14 },
  minUserMessages: { min: 3, max: 6 },
  maxSessions: { min: 8, max: 12 },
  staleDays: { min: 30, max: 45 },
  reasonSimilarityThreshold: { min: 0.24, max: 0.4 },
}

/** 一条人工裁决记录。 */
export interface EvolutionDecision {
  id: string
  kind: 'new-skill' | 'optimize' | 'reclaim'
  skillName: string
  action: 'accepted' | 'rejected' | 'deferred'
  /** 用户填写的原始理由（快捷理由或自由文本）。 */
  reason: string
  /**
   * 理由归桶。
   *
   * 快捷理由映射到固定桶；自由文本统一 `freeform` —— **只计数、不驱动参数**，
   * 避免一段随手写的理由把阈值带偏。
   */
  reasonBucket: ReasonBucket
  at: number
}

/** 理由桶。`freeform` 不参与任何规则。 */
export type ReasonBucket =
  | 'tooNarrow' | 'covered' | 'unstable'
  | 'lowPriority' | 'risky' | 'sufficient'
  | 'keep' | 'observe' | 'stillUseful'
  | 'freeform'

/** 裁决台账上限。 */
export const MAX_DECISIONS = 300

/** 每类提案参与统计的最小样本数，不足则一项都不动。 */
export const MIN_SAMPLE = 8

/** 单次调整幅度上限（相对默认值的比例）。 */
export const MAX_STEP_RATIO = 0.2

/** 同一参数两次调整之间至少需要多少条新裁决（防抖）。 */
export const MIN_DECISIONS_BETWEEN_ADJUST = 3

/**
 * 同类提案出现概率的下界 / 上界与量化步长。
 *
 * 概率只决定「提案是否出现在待审核列表」，不参与落地决策。上界 1.0 表示
 * 完全不抑制（默认值）；下界 0.25 保证每类仍有出场机会。
 */
export const PROBABILITY_MIN = 0.25
export const PROBABILITY_MAX = 1
/** 概率量化到 0.05 的整数倍，便于 UI 显示与确定性比较。 */
export const PROBABILITY_STEP = 0.05
/** 额外扫描名额上限：每类最多 +2，不会放宽 minValueScore。 */
export const MAX_EXTRA_SLOTS = 2

/** 校准留痕。 */
export interface TuningRecord {
  params: TuningParams
  updatedAt: number
  /** 参与本次决策的裁决统计。 */
  basis: {
    total: number
    accepted: number
    rejected: number
    deferred: number
    buckets: Partial<Record<ReasonBucket, number>>
    byKind?: Partial<Record<EvolutionDecision['kind'], { total: number; accepted: number; rejected: number; deferred: number }>>
  }
  /** 本次实际改动的参数键。 */
  applied: TuningKey[]
  /** 每个参数上次调整时的裁决总数（防抖用）。 */
  adjustedAt: Partial<Record<TuningKey, number>>
}

/**
 * 当前校准状态（持久化进 evolution.json）。
 *
 * **直接复用协议层的 `EvolutionTuningState`**，不另立一份同形接口 ——
 * 两份结构相同的类型会让「路由返回的类型」与「实现里的类型」互不兼容，
 * 每次赋值都要 `as never`。协议层是唯一来源，这里只做语义收窄的别名。
 */
export type TuningState = EvolutionTuningState

/** 默认参数的一份副本（避免调用方改到常量）。 */
export function defaultParams(): TuningParams {
  return { ...TUNING_DEFAULTS }
}

/** 默认校准状态。 */
export function defaultTuning(): TuningState {
  return {
    params: defaultParams(),
    updatedAt: 0,
    basis: { total: 0, accepted: 0, rejected: 0, deferred: 0, buckets: {} },
    applied: [],
    adjustedAt: {},
    kindProbability: {},
    probabilityEnabled: true,
    locked: [],
  }
}

/** 把值夹到某参数的合法区间。 */
export function clampParam(key: TuningKey, value: number): number {
  const { min, max } = TUNABLE_BOUNDS[key]
  return Math.min(max, Math.max(min, value))
}

/**
 * 单次调整的最大绝对步长。
 *
 * 取「默认值的 20%」与「1 个最小刻度」的较大者：整数参数至少能动 1，
 * 比例参数至少能动 0.01 —— 否则像 `reasonSimilarityThreshold` 这种
 * 默认 0.34 的参数会算出 0.068 的步长、一次就跳到下界，失去渐进意义。
 *
 * 上界仍然由 {@link TUNABLE_BOUNDS} 兜住，所以「≤20%」是**单次幅度**约束，
 * 不是「一步到位」的许可：参数会分多次、随新裁决逐步逼近目标。
 * @param key - 参数键。
 * @returns 允许的最大步长。
 */
export function maxStep(key: TuningKey): number {
  const base = TUNING_DEFAULTS[key]
  const raw = base * MAX_STEP_RATIO
  if (key === 'reasonSimilarityThreshold') {
    // 比例参数：0.05 一档，避免 0.34→0.24 一步到底。
    return 0.05
  }
  return Math.max(1, Math.round(raw))
}

/**
 * 把原始理由映射到桶。
 *
 * 快捷理由的文案与 `EvolutionView` 里的 QUICK_REJECT_REASONS 一一对应；
 * 匹配不上的一律 `freeform`（只计数、不驱动）。
 * @param kind - 提案类型。
 * @param reason - 用户填写的理由。
 * @returns 理由桶。
 */
export function bucketOf(kind: EvolutionDecision['kind'], reason: string): ReasonBucket {
  const text = reason.trim()
  const table: Record<EvolutionDecision['kind'], Array<[ReasonBucket, RegExp]>> = {
    'new-skill': [
      ['tooNarrow', /细碎|复用性差/],
      ['covered', /通用技能|可覆盖/],
      ['unstable', /流程不稳定|难固化/],
    ],
    optimize: [
      ['lowPriority', /优先级低/],
      ['risky', /风险大|维持现状/],
      ['sufficient', /已满足|够用/],
    ],
    reclaim: [
      ['keep', /暂不回收/],
      ['observe', /观察/],
      ['stillUseful', /仍有实际使用价值/],
    ],
  }
  for (const [bucket, pattern] of table[kind]) {
    if (pattern.test(text)) return bucket
  }
  return 'freeform'
}

/** 一次校准的输入。 */
export interface ComputeTuningInput {
  decisions: readonly EvolutionDecision[]
  current: TuningState
}

/** 一次校准的输出。 */
export interface ComputeTuningResult {
  /** 新参数（已夹紧）。 */
  params: TuningParams
  /** 本次改动的键。 */
  applied: TuningKey[]
  /** 依据统计。 */
  basis: TuningRecord['basis']
  /** 更新后的防抖水位。 */
  adjustedAt: Partial<Record<TuningKey, number>>
  /** 各类提案本轮进入列表的概率（0.25–1.0）；缺省沿用 current 的值。 */
  kindProbability: Partial<Record<EvolutionDecision['kind'], number>>
  /** 各类提案因采纳率高而获得的额外扫描名额（每类最多 +2）。 */
  extraSlots: Partial<Record<EvolutionDecision['kind'], number>>
}

/**
 * 从裁决历史推导新参数。
 *
 * 纯函数：不读盘、不写盘、不调模型、不产生提案。所有规则都受
 * {@link TUNABLE_BOUNDS} 夹紧与 {@link MIN_SAMPLE} 最小样本约束。
 * @param input - 裁决台账与当前状态。
 * @returns 新参数、改动清单、依据统计。
 */
export function computeTuning(input: ComputeTuningInput): ComputeTuningResult {
  const { decisions, current } = input
  const locked = new Set(current.locked)
  const params: TuningParams = { ...current.params } as TuningParams
  const applied: TuningKey[] = []
  const adjustedAt: Partial<Record<TuningKey, number>> = { ...current.adjustedAt }
  const total = decisions.length

  // ---- 依据统计 ----
  const basis: TuningRecord['basis'] = { total, accepted: 0, rejected: 0, deferred: 0, buckets: {}, byKind: {} }
  const byKind = new Map<EvolutionDecision['kind'], EvolutionDecision[]>()
  for (const decision of decisions) {
    if (decision.action === 'accepted') basis.accepted++
    else if (decision.action === 'rejected') basis.rejected++
    else basis.deferred++
    // 按类别累计（给「出现概率」卡片展示依据）。
    const kindStat = basis.byKind![decision.kind] ?? { total: 0, accepted: 0, rejected: 0, deferred: 0 }
    kindStat.total++
    if (decision.action === 'accepted') kindStat.accepted++
    else if (decision.action === 'rejected') kindStat.rejected++
    else kindStat.deferred++
    basis.byKind![decision.kind] = kindStat
    // freeform 只计数、不驱动参数，但 basis 里如实记录。
    basis.buckets[decision.reasonBucket] = (basis.buckets[decision.reasonBucket] ?? 0) + 1
    const list = byKind.get(decision.kind)
    if (list === undefined) byKind.set(decision.kind, [decision])
    else list.push(decision)
  }

  /**
   * 是否允许动这个参数。
   *
   * 三重闸门：用户锁定 → 防抖（距上次调整至少 3 条新裁决）→ 步长上限。
   * @param key - 参数键。
   * @returns true 表示可以调整。
   */
  const canAdjust = (key: TuningKey): boolean => {
    if (locked.has(key)) return false
    const last = adjustedAt[key]
    if (last !== undefined && total - last < MIN_DECISIONS_BETWEEN_ADJUST) return false
    return true
  }

  /**
   * 施加一次调整（相对**当前值**移动一个步长，再夹紧）。
   *
   * 目标必须是相对当前值，而不是「默认值 ± 步长」：后者会让参数一步就停在
   * 固定点（例如 60→72 之后永远 72），既到不了上界也回不到下界。相对移动
   * 配合 {@link MIN_DECISIONS_BETWEEN_ADJUST} 的防抖，参数会随新裁决逐步
   * 逼近目标，任何一步的幅度都不超过 {@link MAX_STEP_RATIO}。
   * @param key - 参数键。
   * @param direction - 1 上调，-1 下调。
   */
  const adjust = (key: TuningKey, direction: 1 | -1): void => {
    if (!canAdjust(key)) return
    const step = maxStep(key)
    const from = params[key]
    let next = clampParam(key, from + direction * step)
    // 比例类参数保留 3 位小数，其余取整。
    next = key === 'reasonSimilarityThreshold' ? Math.round(next * 1000) / 1000 : Math.round(next)
    if (next === from) return
    params[key] = next
    applied.push(key)
    adjustedAt[key] = total
  }

  /** 某类里某几个桶占该类驳回总数的比例（分母是该类全部裁决）。 */
  const shareOf = (kind: EvolutionDecision['kind'], buckets: ReasonBucket[]): number => {
    const list = byKind.get(kind) ?? []
    if (list.length < MIN_SAMPLE) return 0
    const hit = list.filter((d) => buckets.includes(d.reasonBucket)).length
    return hit / list.length
  }

  /** 某类里某动作占比。 */
  const actionShare = (kind: EvolutionDecision['kind'], action: EvolutionDecision['action']): number => {
    const list = byKind.get(kind) ?? []
    if (list.length < MIN_SAMPLE) return 0
    return list.filter((d) => d.action === action).length / list.length
  }

  // ---- 规则 1：new-skill 反复被判「太细碎 / 已有覆盖」 → 收紧 ----
  if (shareOf('new-skill', ['tooNarrow', 'covered']) >= 0.6) {
    adjust('minValueScore', 1)
    adjust('maxScanProposals', -1)
  }

  // ---- 规则 2：new-skill 采纳率高 → 反向放宽 ----
  if (actionShare('new-skill', 'accepted') >= 0.7) {
    adjust('minValueScore', -1)
    adjust('maxScanProposals', 1)
  }

  // ---- 规则 3：optimize 多数因「风险大」被驳回 → 降低重扫频率 ----
  if (shareOf('optimize', ['risky']) >= 0.5) {
    adjust('recentOptimizeDays', 1)
    adjust('maxScanProposals', -1)
  }

  // ---- 规则 4：某类「暂缓」过半 → 降频，**绝不收紧门槛** ----
  //
  // 暂缓的含义是「时机不对 / 节奏太快」，不是「提案错」。把它当错误去提高
  // 门槛，会把本来正确的提案一起杀掉 —— 这是最典型的误调。所以这里只降低
  // 分析频率（更少会话、更严的入场样本），不动价值门槛。
  for (const kind of ['new-skill', 'optimize', 'reclaim'] as const) {
    if (actionShare(kind, 'deferred') >= 0.5) {
      adjust('minUserMessages', 1)
      adjust('maxSessions', -1)
      break
    }
  }

  // ---- 规则 5：reclaim 反复被判「还有用 / 暂不回收」 → 更保守 ----
  if (shareOf('reclaim', ['stillUseful', 'keep']) >= 0.7) {
    adjust('staleDays', 1)
  }

  // ---- 规则 6：反复被判「已有技能覆盖」 → dedup 更积极 ----
  if (shareOf('new-skill', ['covered']) >= 0.7) {
    adjust('reasonSimilarityThreshold', -1)
  }

  // ---- 出现概率：按每类裁决统计推导，只影响提案「是否进入列表」 ----
  //
  // 概率 = clamp(0.25, 1, 0.5 + 0.5 × (同意 - 驳回 - 0.5×暂缓) / 总数)，量化到 0.05。
  // 暂缓按半票负面计（时机问题，不算全错）。样本不足（< MIN_SAMPLE）时沿用旧值。
  // 关闭开关时概率恒为 1.0，且不给任何类别额外名额。
  const probabilityEnabled = current.probabilityEnabled !== false
  const kindProbability: Partial<Record<EvolutionDecision['kind'], number>> = { ...current.kindProbability }
  const extraSlots: Partial<Record<EvolutionDecision['kind'], number>> = {}
  for (const kind of ['new-skill', 'optimize', 'reclaim'] as const) {
    const list = byKind.get(kind) ?? []
    if (!probabilityEnabled) {
      kindProbability[kind] = PROBABILITY_MAX
      continue
    }
    if (list.length < MIN_SAMPLE) continue // 样本不足：沿用旧值，绝不臆测
    let accepted = 0
    let rejected = 0
    let deferred = 0
    for (const d of list) {
      if (d.action === 'accepted') accepted++
      else if (d.action === 'rejected') rejected++
      else deferred++
    }
    const n = accepted + rejected + deferred
    const raw = 0.5 + 0.5 * (accepted - rejected - 0.5 * deferred) / n
    const clamped = Math.min(PROBABILITY_MAX, Math.max(PROBABILITY_MIN, raw))
    const p = Math.round(clamped / PROBABILITY_STEP) * PROBABILITY_STEP
    kindProbability[kind] = Math.round(p * 100) / 100
    // 采纳率 ≥70% 时给该类多一个观察名额（上限 +2）。
    // 只增加「输出数量」，绝不降低 minValueScore 或让提案自动落地。
    if (accepted / n >= 0.7) {
      extraSlots[kind] = Math.min(MAX_EXTRA_SLOTS, (extraSlots[kind] ?? 0) + 1)
    }
  }

  return { params, applied, basis, adjustedAt, kindProbability, extraSlots }
}

/**
 * 判断某条提案是否被当前价值门槛过滤。
 *
 * 抽成函数是为了让「门槛调到 68 后，价值 65 的提案不出现」这条能被单测钉住，
 * 而不是只能靠读代码相信。
 * @param score - 提案的价值分。
 * @param params - 当前参数。
 * @returns true 表示应丢弃。
 */
export function belowValueGate(score: number, params: TuningParams): boolean {
  return score < params.minValueScore
}
