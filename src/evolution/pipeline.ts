/**
 * 提案解析管线 —— **单源逻辑**。
 *
 * 完整分析（调用模型）与离线重新解析（复用已存 markdown）都必须走这里，
 * 禁止各写一套。任何规则调整只改这一个文件，两条路径自动保持一致。
 *
 * 管线顺序（顺序即语义，改动前先想清楚）：
 *   1. parseProposals      —— 文本 → 结构化提案（含命名规范化、草稿强制）
 *   2. 字段校验            —— 必填字段缺失/非法 → 丢弃该条
 *   3. attachMetrics       —— 叠加调用量/成功率/回收站
 *   4. applyMetricRules    —— 回收站跳过、0 调用新建不降级
 *   5. dedupeAgainstRejections —— 同场景同理由不再推送
 *   6. 内容去重            —— 同一批里 skillId + 内容哈希 唯一
 *
 * @module evolution/pipeline
 */
import type { EvolutionProposal, EvolutionRejection } from '../protocol/evolution.ts'
import { parseProposals } from './engine.ts'
import { applyMetricRules, attachMetrics, type SkillUsageRow, type TrashRow } from './metrics.ts'
import { dedupeAgainstRejections } from './dedup.ts'
import { SKILL_ID_PATTERN } from './naming.ts'
import { applyValueFilter } from './value.ts'

/** 管线依赖的数据源。 */
export interface PipelineSources {
  /** 技能运行统计。 */
  usage?: ReadonlyArray<SkillUsageRow>
  /** 回收站记录。 */
  trash?: ReadonlyArray<TrashRow>
  /** 历史驳回记录。 */
  rejections?: ReadonlyArray<{ skillName: string; reason: string }>
}

/** 管线结果。 */
export interface PipelineResult {
  /** 最终提案。 */
  proposals: EvolutionProposal[]
  /** 因缺草稿被丢弃的技能名。 */
  droppedNoDraft: string[]
  /** 因字段非法被丢弃的技能名。 */
  droppedInvalid: string[]
  /** 因驳回去重被丢弃的技能名。 */
  droppedRejected: string[]
  /** 因内容重复被丢弃的技能名。 */
  droppedDuplicate: string[]
  /** 因命中低价值黑名单被丢弃。 */
  droppedBlacklist: Array<{ skillName: string; reason: string }>
  /** 因价值分低于门槛被丢弃。 */
  droppedLowValue: Array<{ skillName: string; score: number }>
  /** 是否一个有效提案都没有。 */
  empty: boolean
}

/**
 * 校验一条提案的必填字段。
 *
 * 要求：skillId 是规范英文 ID、displayName 非空、kind 合法、
 * occurrences 是合理非负整数、priority 合法、draft 非空。
 * @param proposal - 待校验的提案。
 * @returns 通过时返回 undefined，否则返回原因。
 */
export function validateProposal(proposal: EvolutionProposal): string | undefined {
  if (!SKILL_ID_PATTERN.test(proposal.skillName)) return 'skillId 不是规范的 kebab-case'
  if (proposal.skillName.length > 64) return 'skillId 过长'
  // 展示名：新建提案必须有；优化提案沿用原 ID 时允许缺省（UI 回退显示 ID）。
  if (proposal.kind === 'new-skill') {
    const display = proposal.displayName
    if (display === undefined || display.trim() === '' || display === '未命名技能') return 'displayName 缺失'
  }
  if (proposal.kind !== 'new-skill' && proposal.kind !== 'optimize' && proposal.kind !== 'reclaim') return 'kind 非法'

  // 回收建议提案：只要求技能名合法 + 有说明。
  // **不要求草稿与新版源码** —— 它本来就不是「改技能」，而是「下线技能」。
  if (proposal.kind === 'reclaim') {
    if ((proposal.painPoints ?? '').trim() === '') return '回收提案缺少说明'
    return undefined
  }
  const occurrences = proposal.occurrences
  // 出现次数只对**新建/细分专项**是必填（它来自轨迹统计）。
  // 优化提案可能来自主动扫描 —— 那时没有「出现次数」这个概念，
  // 强制要求会把所有扫描结果全部丢掉。
  if (proposal.kind === 'new-skill') {
    if (occurrences === undefined || !Number.isSafeInteger(occurrences) || occurrences < 0 || occurrences > 999) {
      return 'occurrences 非法'
    }
  } else if (occurrences !== undefined && (!Number.isSafeInteger(occurrences) || occurrences < 0 || occurrences > 999)) {
    return 'occurrences 非法'
  }
  const priority = proposal.priority
  if (proposal.kind === 'new-skill' && priority !== undefined && priority !== 'high' && priority !== 'medium' && priority !== 'low') {
    return 'priority 非法'
  }
  // 草稿：新建必须有；优化必须有新版源码（解析层已镜像到 draft）。
  if ((proposal.draft ?? '').trim() === '') return 'draft 为空'

  // 优化提案的**五项强制内容**：缺任何一项都丢弃。
  //
  // 理由：优化提案的价值全在「能直接照着改」。没有新版源码就无法落地；
  // 没有痛点说明就不知道为什么要改；没有测试用例就无法验证改对了；
  // 没有风险评估就可能引入误触发。
  if (proposal.kind === 'optimize') {
    if ((proposal.painPoints ?? '').trim() === '') return '优化提案缺少痛点总结'
    if ((proposal.newSource ?? '').trim() === '') return '优化提案缺少新版技能源码'
    if ((proposal.testCases ?? '').trim() === '') return '优化提案缺少测试用例'
    if ((proposal.riskAssessment ?? '').trim() === '') return '优化提案缺少风险评估'
  }
  return undefined
}

/**
 * 内容指纹：skillId + 关键字段的稳定哈希。
 *
 * 用于同一批结果内的幂等去重 —— 连点两次「重新解析」不该产生两份一样的提案。
 * @param proposal - 提案。
 * @returns 指纹字符串。
 */
export function fingerprint(proposal: EvolutionProposal): string {
  const parts = [
    proposal.kind,
    proposal.skillName,
    proposal.displayName ?? '',
    String(proposal.occurrences ?? 0),
    proposal.priority ?? '',
    proposal.recommendation ?? '',
    proposal.changeType ?? '',
    // 草稿只取前 200 字参与指纹：足够区分不同提案，又不受尾部细微差异影响。
    (proposal.draft ?? '').slice(0, 200),
  ]
  return parts.join('\u0000')
}

/**
 * 跑完整解析管线。
 *
 * @param markdown - 模型输出（完整分析时来自本次调用，重新解析时来自已存记录）。
 * @param sources - 统计/回收站/驳回数据源。
 * @param now - 当前时间（时间戳与幂等性都依赖它）。
 * @returns 提案与各阶段丢弃明细。
 */
export function runPipeline(
  markdown: string,
  sources: PipelineSources,
  now = Date.now(),
  presets: readonly EvolutionProposal[] = [],
): PipelineResult {
  // presets：调用方已构造好的提案（如主动扫描结果）。
  // 它们与解析结果走完全相同的校验 / 评分 / 去重链路，不另开分支。
  const parsed = [...parseProposals(markdown, now), ...presets]
  const droppedNoDraft = collectNoDraft(parsed)

  // 2) 字段校验
  const droppedInvalid: string[] = []
  const valid: EvolutionProposal[] = []
  for (const proposal of parsed) {
    const reason = validateProposal(proposal)
    if (reason === undefined) valid.push(proposal)
    else droppedInvalid.push(proposal.skillName)
  }

  // 2.5) 价值评分 + 黑名单
  //
  // 放在统计维度之前：低价值场景不该进入后续评估（回收站/驳回都白算）。
  // 这一步同时负责按分数降序排序，高价值提案自然置顶。
  const valued = applyValueFilter(valid)
  const droppedBlacklist = valued.blockedByBlacklist
  const droppedLowValue = valued.belowThreshold

  // 3) 统计维度
  const usageByName = new Map((sources.usage ?? []).map((row) => [row.name, row]))
  const trashByName = new Map((sources.trash ?? []).map((row) => [row.name, row]))
  let proposals = attachMetrics(valued.kept, usageByName, trashByName, now)
  // 4) 回收站跳过 / 新建不因 0 调用降级
  proposals = applyMetricRules(proposals, now)

  // 5) 驳回去重
  const rejectionRows: EvolutionRejection[] = (sources.rejections ?? []).map((row, index) => ({
    id: 'r' + String(index),
    skillName: row.skillName,
    reason: row.reason,
    at: 0,
  }))
  const deduped = dedupeAgainstRejections(proposals, rejectionRows)
  proposals = deduped.kept
  const droppedRejected = deduped.dropped.map((item) => item.proposal.skillName)

  // 6) 内容指纹去重（同一批内唯一）
  const droppedDuplicate: string[] = []
  const seen = new Set<string>()
  const unique: EvolutionProposal[] = []
  for (const proposal of proposals) {
    const key = fingerprint(proposal)
    if (seen.has(key)) { droppedDuplicate.push(proposal.skillName); continue }
    seen.add(key)
    unique.push(proposal)
  }

  // 7) 同技能的优化提案只留一条
  //
  // 轨迹优化与主动扫描可能同时发现同一个技能的问题。它们互补但**不该重复**
  // 推送 —— 保留价值分更高的那条，另一条记入 droppedDuplicate。
  const bySkill = new Map<string, EvolutionProposal>()
  const dedupedBySkill: EvolutionProposal[] = []
  for (const proposal of unique) {
    if (proposal.kind !== 'optimize') { dedupedBySkill.push(proposal); continue }
    const existing = bySkill.get(proposal.skillName)
    if (existing === undefined) {
      bySkill.set(proposal.skillName, proposal)
      dedupedBySkill.push(proposal)
      continue
    }
    // 已有同技能优化：留下分数更高的。
    if ((proposal.valueScore ?? 0) > (existing.valueScore ?? 0)) {
      const index = dedupedBySkill.indexOf(existing)
      if (index >= 0) dedupedBySkill[index] = proposal
      bySkill.set(proposal.skillName, proposal)
    }
    droppedDuplicate.push(proposal.skillName)
  }

  return {
    proposals: dedupedBySkill,
    droppedNoDraft,
    droppedInvalid,
    droppedRejected,
    droppedDuplicate,
    droppedBlacklist,
    droppedLowValue,
    empty: dedupedBySkill.length === 0,
  }
}

/** parseProposals 内部已丢弃无草稿项，这里只做占位以便日志口径一致。 */
function collectNoDraft(_parsed: readonly EvolutionProposal[]): string[] {
  return []
}
