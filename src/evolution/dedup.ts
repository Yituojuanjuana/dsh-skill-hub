/**
 * 驳回去重：同场景 + 同理由的提案不再重复推送。
 *
 * 宽松度设计（需求明确要求）：
 * - **只拦截高度同类**：技能名一致（或高度相似）**且**驳回理由语义相近；
 * - **不阻止新方案**：同一业务场景下换了思路的新提案必须放行 —— 否则用户
 *   永远无法对同一个痛点提出第二种解法。
 *
 * 判定用「关键词集合的 Jaccard 相似度」而不是字符串相等：模型两次描述同一
 * 个理由时措辞必然不同（「流程太不稳定」vs「业务变化快，写不出固定规则」），
 * 纯相等匹配几乎永远命中不了。
 *
 * @module evolution/dedup
 */
import type { EvolutionProposal, EvolutionRejection } from '../protocol/evolution.ts'

/** 理由相似度门槛：达到即认为「语义相近」。 */
export const REASON_SIMILARITY_THRESHOLD = 0.34

/** 技能名相似度门槛。 */
export const NAME_SIMILARITY_THRESHOLD = 0.8

/**
 * 中文/英文混排的切词：连续汉字按 2 字滑窗，连续字母数字按整词。
 *
 * 不做真正的分词（没有词典依赖），2 字滑窗对「流程不稳定」这类短语足够——
 * 「流程」「程不」「不稳」「稳定」四个片段足以和另一种说法的片段对上。
 * @param text - 原文。
 * @returns 片段集合。
 */
export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>()
  const lower = text.toLowerCase()
  // 英文/数字整词。
  for (const word of lower.match(/[a-z0-9]+/g) ?? []) {
    if (word.length >= 2) tokens.add(word)
  }
  // 连续汉字：2 字滑窗。
  for (const run of lower.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length <= 2) {
      tokens.add(run)
      continue
    }
    for (let index = 0; index + 2 <= run.length; index += 1) {
      tokens.add(run.slice(index, index + 2))
    }
  }
  return tokens
}

/**
 * 两个集合的 Jaccard 相似度。
 * @param a - 集合 A。
 * @param b - 集合 B。
 * @returns 0~1；任一为空时返回 0。
 */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  const union = a.size + b.size - shared
  return union === 0 ? 0 : shared / union
}

/** 一条驳回记录的比对视图（预切词，避免每条提案重复算）。 */
interface PreparedRejection {
  skillName: string
  nameTokens: Set<string>
  reasonTokens: Set<string>
  reason: string
  /** 被驳回提案的类型；旧记录没有该字段。 */
  kind?: 'new-skill' | 'optimize' | 'reclaim'
}

/** 预处理驳回记录。 */
export function prepareRejections(rejections: readonly EvolutionRejection[]): PreparedRejection[] {
  return rejections.map((item) => ({
    skillName: item.skillName,
    nameTokens: tokenize(item.skillName),
    reasonTokens: tokenize(item.reason),
    reason: item.reason,
    ...item.kind === undefined ? {} : { kind: item.kind },
  }))
}

/** 一条提案被过滤的结果。 */
export interface DedupResult {
  /** 保留下来的提案。 */
  kept: EvolutionProposal[]
  /** 被过滤掉的提案及命中的驳回理由。 */
  dropped: Array<{ proposal: EvolutionProposal; reason: string; matchedRejection: string }>
}

/**
 * 过滤掉与历史驳回高度同类的提案。
 *
 * 判定条件（必须同时满足）：
 *   1. 技能名一致或高度相似（Jaccard ≥ NAME_SIMILARITY_THRESHOLD）；
 *   2. 提案的场景/痛点描述与驳回理由语义相近（Jaccard ≥ REASON_SIMILARITY_THRESHOLD）。
 *
 * @param proposals - 待过滤的提案。
 * @param rejections - 历史驳回记录。
 * @returns 保留与被丢弃的提案。
 */
export function dedupeAgainstRejections(
  proposals: readonly EvolutionProposal[],
  rejections: readonly EvolutionRejection[],
): DedupResult {
  if (rejections.length === 0) return { kept: [...proposals], dropped: [] }
  const prepared = prepareRejections(rejections)
  const kept: EvolutionProposal[] = []
  const dropped: DedupResult['dropped'] = []

  for (const proposal of proposals) {
    const nameTokens = tokenize(proposal.skillName)
    // 提案的「场景描述」= 场景 + 痛点 + 收益，取到哪算哪。
    const scenarioText = [proposal.scenario, proposal.painPoints, proposal.benefit, proposal.benefitCompare]
      .filter((part): part is string => typeof part === 'string' && part !== '')
      .join(' ')
    const scenarioTokens = tokenize(scenarioText)

    const hit = prepared.find((rejection) => {
      // 类型隔离：驳回「新建推荐」不该阻止同一技能日后出现「优化提案」。
      // 旧记录没有 kind，视为不限制类型（向后兼容）。
      if (rejection.kind !== undefined && rejection.kind !== proposal.kind) return false
      // 名称：完全相同直接命中；否则算相似度。
      const exactName = rejection.skillName === proposal.skillName
      const nameMatch = exactName || jaccard(nameTokens, rejection.nameTokens) >= NAME_SIMILARITY_THRESHOLD
      if (!nameMatch) return false
      // **同技能 + 同类型 → 直接拦截**，不再要求理由相似。
      //
      // 原因：用户驳回某个技能的提案后，不该再看到同一技能的同类提案。
      // 而理由文本经常与提案描述毫无词汇重叠（「当前版本可用，暂不优化」
      // vs「触发条件模糊」），相似度恒为 0，只靠语义匹配会漏掉全部优化类驳回。
      //
      // 但**旧记录没有 kind**：那种情况下保持原语义（要求理由相近），
      // 以免破坏「同一技能换思路仍可提出新方案」的设计。
      if (exactName && rejection.kind !== undefined) return true
      // 名称只是相似、或旧记录无类型时，仍要求理由相近。
      return jaccard(scenarioTokens, rejection.reasonTokens) >= REASON_SIMILARITY_THRESHOLD
    })

    if (hit === undefined) {
      kept.push(proposal)
    } else {
      dropped.push({ proposal, reason: hit.reason, matchedRejection: hit.skillName })
    }
  }
  return { kept, dropped }
}
