/**
 * 统计维度评估：把技能运行指标与回收站状态叠加到提案上。
 *
 * 这是「四维联合评估」的扩展层 —— 会话轨迹回答「用户反复要什么」，这一层
 * 回答「现有技能活得怎么样」。两条信息合起来才能判断该新建还是该修旧的。
 *
 * 判定规则（与需求一一对应，优先级从高到低）：
 *   1. 已在回收站          → 跳过同类提案；仅当调用量回升时出「恢复评估」
 *   2. 长期 0 调用         → 低价值，出「建议移入回收站」，不推荐新建
 *   3. 高调用 + 高成功率   → 优先拆分细分专项 / 沉淀标准化模板
 *   4. 高调用 + 低成功率   → 优先优化重构 / 缺陷修复
 *
 * @module evolution/metrics
 */
import type { EvolutionProposal, EvolutionSkillMetrics } from '../protocol/evolution.ts'

/** 一个技能的运行统计（来自永久账本）。 */
export interface SkillUsageRow {
  name: string
  /** 历史总调用次数。 */
  total: number
  /** 近 7 天调用量。 */
  week: number
  /** 历史成功率（0~1）；没有样本时省略。 */
  successRate?: number
  /** 最近一次调用时间。 */
  lastUsed?: number
}

/** 回收站里的一条记录。 */
export interface TrashRow {
  name: string
  /** 移入时间（epoch ms）。 */
  movedAt: number
  /** 备注（可选）。 */
  note?: string
}

/** 评估用的阈值。集中在这里，便于调参与测试。 */
export const METRIC_THRESHOLDS = {
  /** 「高调用」门槛：历史总调用次数。 */
  highCalls: 20,
  /** 「高成功率」门槛。 */
  highSuccessRate: 0.9,
  /** 「低成功率」门槛。 */
  lowSuccessRate: 0.6,
  /** 「长期 0 调用」判定：超过这么多天没被调用即视为长期未用。 */
  staleDays: 30,
} as const

/** 统计维度的判定结论。 */
export type MetricVerdict =
  | 'in-trash'
  | 'trash-recover'
  | 'stale'
  /** 新建提案：技能尚未落地，0 调用是必然的，不构成低价值判定。 */
  | 'new-pending'
  | 'high-ok'
  | 'high-fail'
  | 'normal'

/**
 * 依据运行指标给出一条判定。
 * @param usage - 该技能的统计；不存在表示从未被记录过。
 * @param trash - 该技能的回收站记录；不在回收站则为 undefined。
 * @param now - 当前时间（测试注入）。
 * @param kind - 提案类型；`new-skill` 时禁用「0 调用 = 低价值」判定。
 * @returns 判定结论 + 人类可读理由。
 */
export function judgeByMetrics(
  usage: SkillUsageRow | undefined,
  trash: TrashRow | undefined,
  now = Date.now(),
  kind?: EvolutionProposal['kind'],
): { verdict: MetricVerdict; reason: string } {
  const total = usage?.total ?? 0
  const week = usage?.week ?? 0

  // 1) 已在回收站：默认跳过。唯一例外是「移入后又开始被调用」——
  //    说明用户其实还需要它，值得重新评估是否恢复。
  if (trash !== undefined) {
    const calledAfterTrash = (usage?.lastUsed ?? 0) > trash.movedAt
    if (calledAfterTrash && week > 0) {
      return {
        verdict: 'trash-recover',
        reason: `该技能已在回收站（${formatDate(trash.movedAt)} 移入），但之后仍有 ${String(week)} 次调用，建议重新评估是否恢复`,
      }
    }
    return {
      verdict: 'in-trash',
      reason: `该技能已在回收站（${formatDate(trash.movedAt)} 移入），跳过同类新建/优化提案`,
    }
  }

  // 2) 长期 0 调用：低价值，建议回收而不是新建。
  //
  // **但新建提案不适用**：这类技能还没落地，系统里本来就不存在，
  // 调用量必然是 0。对它输出「建议移入回收站」是自相矛盾的
  // —— 一个还不存在的技能没有回收站可进。
  const lastUsed = usage?.lastUsed ?? 0
  const daysSince = lastUsed === 0 ? Number.POSITIVE_INFINITY : Math.floor((now - lastUsed) / 86_400_000)
  const stale = total === 0 || (week === 0 && daysSince >= METRIC_THRESHOLDS.staleDays)
  if (stale) {
    if (kind === 'new-skill') {
      return {
        verdict: 'new-pending',
        reason: '该技能尚未落地，暂无调用记录',
      }
    }
    const span = lastUsed === 0 ? '从未被调用' : `最近一次调用在 ${String(daysSince)} 天前`
    return {
      verdict: 'stale',
      reason: `历史调用 ${String(total)} 次、近 7 天 ${String(week)} 次，${span} —— 判定为低价值，建议移入回收站`,
    }
  }

  const rate = usage?.successRate
  // 3) 高调用 + 高成功率：值得沉淀与拆分。
  if (total >= METRIC_THRESHOLDS.highCalls && rate !== undefined && rate >= METRIC_THRESHOLDS.highSuccessRate) {
    return {
      verdict: 'high-ok',
      reason: `历史调用 ${String(total)} 次、成功率 ${formatRate(rate)} —— 高频稳定，优先考虑拆分细分专项或沉淀标准化模板`,
    }
  }
  // 4) 高调用 + 低成功率：该修不该拆。
  if (total >= METRIC_THRESHOLDS.highCalls && rate !== undefined && rate < METRIC_THRESHOLDS.lowSuccessRate) {
    return {
      verdict: 'high-fail',
      reason: `历史调用 ${String(total)} 次但成功率仅 ${formatRate(rate)} —— 高频低效，优先产出优化重构与缺陷修复`,
    }
  }
  return {
    verdict: 'normal',
    reason: `历史调用 ${String(total)} 次、近 7 天 ${String(week)} 次${rate === undefined ? '' : '、成功率 ' + formatRate(rate)}`,
  }
}

/** 百分比格式化。 */
function formatRate(rate: number): string {
  return (Math.round(rate * 1000) / 10).toFixed(1) + '%'
}

/** 日期格式化（只到天）。 */
function formatDate(ms: number): string {
  const date = new Date(ms)
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/**
 * 把统计维度附加到提案上。
 *
 * 不修改原数组元素（返回新对象），并给每条提案写上 `metrics.reason`。
 * @param proposals - 解析出的提案。
 * @param usageByName - 技能名 → 运行统计。
 * @param trashByName - 技能名 → 回收站记录。
 * @param now - 当前时间。
 * @returns 附好指标的提案。
 */
export function attachMetrics(
  proposals: readonly EvolutionProposal[],
  usageByName: ReadonlyMap<string, SkillUsageRow>,
  trashByName: ReadonlyMap<string, TrashRow>,
  now = Date.now(),
): EvolutionProposal[] {
  return proposals.map((proposal) => {
    const usage = usageByName.get(proposal.skillName)
    const trash = trashByName.get(proposal.skillName)
    // 把提案类型传进去：新建提案的 0 调用不是「低价值」，而是「还没落地」。
    const judged = judgeByMetrics(usage, trash, now, proposal.kind)
    const metrics: EvolutionSkillMetrics = {
      ...usage === undefined ? {} : {
        totalCalls: usage.total,
        weekCalls: usage.week,
        ...usage.successRate === undefined ? {} : { successRate: usage.successRate },
      },
      ...trash === undefined ? {} : { inTrash: true, trashedAt: trash.movedAt, ...trash.note === undefined ? {} : { trashNote: trash.note } },
      reason: judged.reason,
    }
    return { ...proposal, metrics }
  })
}

/**
 * 按统计维度过滤提案。
 *
 * - 回收站里的技能：丢掉同类「新建/优化」提案，只保留「恢复评估」；
 * - 长期 0 调用：把「新建」降级成「建议移入回收站」（改造 recommendation），
 *   因为给一个没人用的技能再建新技能是反的。
 * @param proposals - 已附指标的提案。
 * @param now - 当前时间。
 * @returns 过滤/改造后的提案。
 */
export function applyMetricRules(proposals: readonly EvolutionProposal[], now = Date.now()): EvolutionProposal[] {
  const out: EvolutionProposal[] = []
  for (const proposal of proposals) {
    const usage = proposal.metrics?.totalCalls === undefined
      ? undefined
      : {
          name: proposal.skillName,
          total: proposal.metrics.totalCalls,
          week: proposal.metrics.weekCalls ?? 0,
          ...proposal.metrics.successRate === undefined ? {} : { successRate: proposal.metrics.successRate },
        }
    const trash = proposal.metrics?.inTrash === true
      ? { name: proposal.skillName, movedAt: proposal.metrics.trashedAt ?? 0, ...proposal.metrics.trashNote === undefined ? {} : { note: proposal.metrics.trashNote } }
      : undefined
    const judged = judgeByMetrics(usage, trash, now, proposal.kind)

    // 回收站里的技能：不生成同类新建/优化，只留「恢复评估」。
    if (judged.verdict === 'in-trash') continue

    // 注意：**不再**把 0 调用的「新建」提案降级成 observe。
    //
    // 那是逻辑冲突：新建提案指向的技能还没落地，系统里本来就不存在，
    // 调用量必然是 0。对它输出「建议移入回收站」等于建议回收一个
    // 还不存在的技能。新建提案的 0 调用由 judgeByMetrics 用
    // `new-pending` 判定处理，理由写「该技能尚未落地，暂无调用记录」。
    // 只有「优化已有技能」才走低价值/回收判定。
    out.push({ ...proposal, metrics: { ...proposal.metrics, reason: judged.reason } })
  }
  return out
}
