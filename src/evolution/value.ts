/**
 * 技能价值评分与低价值黑名单。
 *
 * 目的：把「细碎低价值场景」挡在待审核列表之外。模型倾向于把任何重复出现的
 * 操作都包装成技能提案，但「构建后看 dist 在不在」「改个 padding」这类东西
 * 封装成技能只会增加维护负担，收益接近于零。
 *
 * 评分满分 100，低于 `MIN_VALUE_SCORE` 直接丢弃；60~75 分标记「低价值观察」。
 *
 * @module evolution/value
 */
import type { EvolutionProposal } from '../protocol/evolution.ts'

/** 低于这个分数直接过滤，不展示不计数。 */
export const MIN_VALUE_SCORE = 60

/** 低于这个分数标记「低价值观察」，默认折叠。 */
export const LOW_VALUE_SCORE = 75

/**
 * 回收建议提案的固定价值分。
 *
 * 用 60 而不是更低：让它仍落在「低价值观察」区间内可见，但排在所有
 * 真正的优化提案之后 —— 清理闲置技能是必要的维护动作，优先级低于
 * 能提升能力的改进。
 */
export const RECLAIM_VALUE_SCORE = 60

/** 黑名单命中时的判定结果。 */
export interface BlacklistHit {
  /** 命中的黑名单条目 id。 */
  id: string
  /** 人类可读原因。 */
  reason: string
}

/**
 * 低价值场景黑名单。
 *
 * 这些场景**无论出现多少次**都不生成新建技能提案 —— 它们是「一次性动作」
 * 或「现有技能已覆盖」的典型代表，封装成技能没有长期价值。
 *
 * 匹配对象是提案的场景描述 + 技能名 + 草稿里的触发条件（合并成一个文本）。
 */
const BLACKLIST: ReadonlyArray<{ id: string; reason: string; test: (text: string) => boolean }> = [
  {
    id: 'build-verify',
    reason: '简单构建验证 / dist 产物存在性校验',
    // 「构建后确认产物存在」这类：提到 dist / 产物 / 编译 且提到 验证 / 存在 / 确认。
    test: (text) => /(dist|产物|编译|构建)/.test(text) && /(验证|核验|存在|确认|检查)/.test(text) && !/(业务|规则|字段|流程|排课|会员|教练|订单|学员)/.test(text),
  },
  {
    id: 'single-style-tweak',
    reason: '单次样式微调 / 像素级对齐 / 单字段修改',
    test: (text) => /(像素|px|padding|margin|圆角|字号|颜色|间距)/i.test(text) && /(微调|微改|改一下|调一下|对齐|单个)/.test(text),
  },
  {
    id: 'one-off-debug',
    reason: '临时排错 / bug 定位 / 一次性环境问题排查',
    test: (text) => /(临时|一次性|偶发)/.test(text) && /(排错|排查|定位|debug|环境问题)/i.test(text),
  },
  {
    id: 'covered-by-generic',
    reason: '能用现有通用开发/UI 技能直接完成',
    test: (text) => /(已有.*技能|现有.*技能|通用技能).*(覆盖|即可|足够)/.test(text) && !/(业务专属|细分专项)/.test(text),
  },
  {
    id: 'unstable-flow',
    reason: '流程极不稳定，每次改动差异很大',
    test: (text) => /(流程.*不(稳定|固定)|每次.*都.*不(同|一样)|无固定流程)/.test(text),
  },
]

/**
 * 检查提案是否命中低价值黑名单。
 * @param proposal - 提案。
 * @returns 命中的条目；未命中返回 undefined。
 */
export function blacklistHit(proposal: EvolutionProposal): BlacklistHit | undefined {
  // 只对「新建」类提案做黑名单拦截 —— 优化/回收提案本来就是在处理已有技能。
  if (proposal.kind !== 'new-skill') return undefined
  const text = [
    proposal.skillName,
    proposal.displayName ?? '',
    proposal.scenario ?? '',
    proposal.benefit ?? '',
    (proposal.draft ?? '').slice(0, 800),
  ].join(' ')
  for (const entry of BLACKLIST) {
    if (entry.test(text)) return { id: entry.id, reason: entry.reason }
  }
  return undefined
}

/** 评分的加分项。 */
interface ScoreFactor {
  id: string
  label: string
  delta: number
  test: (proposal: EvolutionProposal, text: string) => boolean
}

/** 加分项（每项 +15~20）。 */
const POSITIVE: readonly ScoreFactor[] = [
  {
    id: 'stable-flow',
    label: '业务流程固定可标准化',
    delta: 20,
    test: (_p, text) => /(流程固定|标准流程|固定流程|步骤固定|按顺序)/.test(text),
  },
  {
    id: 'many-steps',
    label: '步骤多、易出错，封装后明显降低返工',
    delta: 20,
    // 草稿里出现 ≥5 个编号步骤。
    test: (p) => countSteps(p.draft ?? '') >= 5,
  },
  {
    id: 'repeated-rules',
    label: '每次都要重复交代大量专属业务规则',
    delta: 15,
    test: (_p, text) => /(重复交代|每次都要说明|业务规范|业务规则|字段规则|页面规范)/.test(text),
  },
  {
    id: 'broad-scope',
    label: '适用场景广，跨多个页面/模块',
    delta: 15,
    test: (_p, text) => /(多个页面|跨页面|多个模块|通用|多处|系列页面)/.test(text),
  },
]

/** 减分项（每项 -15~20）。 */
const NEGATIVE: readonly ScoreFactor[] = [
  {
    id: 'few-steps',
    label: '步骤≤3 步，单次耗时短',
    delta: -20,
    test: (p) => {
      const steps = countSteps(p.draft ?? '')
      return steps > 0 && steps <= 3
    },
  },
  {
    id: 'concrete-path',
    label: '依赖具体文件路径 / 具体代码行',
    delta: -15,
    test: (_p, text) => /(第\s*\d+\s*行|line\s*\d+|src\/[a-z/]+\.(tsx?|scss|css))/.test(text),
  },
  {
    id: 'one-off',
    label: '临时排查 / 一次性验证类操作',
    delta: -20,
    test: (_p, text) => /(临时|一次性|偶发|试一下)/.test(text),
  },
  {
    id: 'generic-combo',
    label: '现有通用技能简单组合即可完成',
    delta: -15,
    test: (_p, text) => /(现有.*技能.*组合|通用技能.*即可|无需.*封装)/.test(text),
  },
  {
    id: 'narrow-scope',
    label: '场景极窄，仅适用单个页面单次改动',
    delta: -15,
    test: (_p, text) => /(单个页面|仅.*一次|只此一处|单次改动)/.test(text),
  },
]

/** 数一数草稿里的编号步骤（`1.` / `1、` / `- 1.` 等）。 */
export function countSteps(draft: string): number {
  const matches = draft.match(/^\s*(?:\d+[.、)]|[-*]\s*\d+[.、)])\s+\S/gm)
  return matches === null ? 0 : matches.length
}

/** 评分结果。 */
export interface ValueScore {
  /** 总分（0~100，夹紧）。 */
  score: number
  /** 命中的加分项标签。 */
  positives: string[]
  /** 命中的减分项标签。 */
  negatives: string[]
  /** 是否低于最低门槛（会被丢弃）。 */
  belowThreshold: boolean
  /** 是否属于「低价值观察」（60~75）。 */
  lowValue: boolean
}

/**
 * 给一条提案打分。
 *
 * 基础分 50，加减项累加后夹到 0~100。
 * @param proposal - 提案。
 * @returns 评分明细。
 */
export function scoreProposal(proposal: EvolutionProposal): ValueScore {
  const text = [
    proposal.skillName,
    proposal.displayName ?? '',
    proposal.scenario ?? '',
    proposal.benefit ?? '',
    proposal.risk ?? '',
    proposal.draft ?? '',
  ].join(' ')

  let score = 50
  const positives: string[] = []
  const negatives: string[] = []
  for (const factor of POSITIVE) {
    if (factor.test(proposal, text)) {
      score += factor.delta
      positives.push(factor.label)
    }
  }
  for (const factor of NEGATIVE) {
    if (factor.test(proposal, text)) {
      score += factor.delta
      negatives.push(factor.label)
    }
  }
  // 细分专项自带「业务专属」价值，给一点基础加权（它不是通用技能能替代的）。
  if (proposal.recommendation === 'niche') {
    score += 10
    positives.push('细分专项：业务专属流程')
  }

  const clamped = Math.min(100, Math.max(0, score))
  return {
    score: clamped,
    positives,
    negatives,
    belowThreshold: clamped < MIN_VALUE_SCORE,
    lowValue: clamped >= MIN_VALUE_SCORE && clamped < LOW_VALUE_SCORE,
  }
}

/** 过滤统计。 */
export interface ValueFilterResult {
  /** 保留的提案（已按分数降序）。 */
  kept: EvolutionProposal[]
  /** 被黑名单拦掉的。 */
  blockedByBlacklist: Array<{ skillName: string; reason: string }>
  /** 分数低于门槛被丢弃的。 */
  belowThreshold: Array<{ skillName: string; score: number }>
}

/**
 * 应用价值评分与黑名单。
 *
 * @param proposals - 待过滤提案。
 * @returns 保留的（按分数降序，带 valueScore 字段）与丢弃明细。
 */
export function applyValueFilter(proposals: readonly EvolutionProposal[]): ValueFilterResult {
  const kept: EvolutionProposal[] = []
  const blockedByBlacklist: ValueFilterResult['blockedByBlacklist'] = []
  const belowThreshold: ValueFilterResult['belowThreshold'] = []

  for (const proposal of proposals) {
    // 回收建议提案统一按低价值处理：固定低分、排序靠后。
    //
    // 但它**不该被价值门槛丢掉** —— 它是唯一能清理闲置技能的入口。
    // 也不能走正常评分：回收提案没有草稿，评分逻辑会判它 50 分直接丢弃。
    if (proposal.kind === 'reclaim') {
      kept.push({ ...proposal, valueScore: RECLAIM_VALUE_SCORE })
      continue
    }
    const hit = blacklistHit(proposal)
    if (hit !== undefined) {
      blockedByBlacklist.push({ skillName: proposal.skillName, reason: hit.reason })
      continue
    }
    const scored = scoreProposal(proposal)
    if (scored.belowThreshold) {
      belowThreshold.push({ skillName: proposal.skillName, score: scored.score })
      continue
    }
    kept.push({ ...proposal, valueScore: scored.score })
  }

  // 按价值分降序 —— 高价值置顶。
  kept.sort((a, b) => (b.valueScore ?? 0) - (a.valueScore ?? 0))
  return { kept, blockedByBlacklist, belowThreshold }
}
