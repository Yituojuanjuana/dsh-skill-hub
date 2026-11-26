/**
 * 离线重新解析。
 *
 * 用途：模型输出已经存在 `evolution.json` 里，但解析器后来修过 bug。
 * 这时不必再花几分钟重跑模型，直接用已存 markdown 走一遍**同一条管线**即可。
 *
 * 三条硬约束：
 * 1. **不发起 LLM 请求、不读会话** —— 纯本地文本处理；
 * 2. **不修改原始运行记录**（`runs` / `ranAt` / `markdown` 全部原样保留），
 *    只在 `proposals` 上做替换，且替换前备份上一版；
 * 3. **输入保真校验** —— 核心标题缺失或长度不足时直接拒绝，不返回脏数据。
 *
 * @module evolution/reparse
 */
import type { EvolutionProposal } from '../protocol/evolution.ts'
import { runPipeline, type PipelineSources, type PipelineResult } from './pipeline.ts'

/** markdown 最短长度：低于这个值不可能包含完整提案。 */
export const MIN_MARKDOWN_LENGTH = 200

/** 必须存在的核心标题（放宽匹配：允许 `## 一、` 与 `### 一、` 两种）。 */
const REQUIRED_SECTIONS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: '新建技能推荐清单', pattern: /#{2,4}\s*一[、.]\s*新建技能推荐清单/ },
  { label: '已有技能优化提案', pattern: /#{2,4}\s*二[、.]\s*已有技能优化提案/ },
]

/** 校验结论。 */
export interface ReparseCheck {
  ok: boolean
  /** 拒绝原因（ok=false 时必有）。 */
  reason?: string
}

/**
 * 输入层保真校验。
 *
 * 只做「这份 markdown 看起来像完整提案」的判断，不解析内容 ——
 * 目的是在浪费一次解析之前就把损坏/截断的记录挡掉。
 * @param markdown - 已存的模型输出。
 * @returns 校验结论。
 */
export function checkMarkdown(markdown: string): ReparseCheck {
  const text = String(markdown ?? '')
  if (text.trim() === '') {
    return { ok: false, reason: '暂无历史运行记录，请先运行一次分析' }
  }
  if (text.length < MIN_MARKDOWN_LENGTH) {
    return { ok: false, reason: `历史记录不完整（仅 ${String(text.length)} 字符，至少需要 ${String(MIN_MARKDOWN_LENGTH)}），已拒绝解析` }
  }
  for (const section of REQUIRED_SECTIONS) {
    if (!section.pattern.test(text)) {
      return { ok: false, reason: `历史记录缺少「${section.label}」章节，格式不兼容，已拒绝解析` }
    }
  }
  return { ok: true }
}

/** 重新解析结果。 */
export interface ReparseResult {
  ok: boolean
  /** 失败原因。 */
  error?: string
  /** 解析出的提案（失败时为空数组）。 */
  proposals: EvolutionProposal[]
  /** 各阶段丢弃统计。 */
  dropped: { noDraft: number; invalid: number; rejected: number; duplicate: number }
  /** 解析耗时（毫秒）。 */
  elapsedMs: number
}

/**
 * 执行一次离线重新解析。
 *
 * @param markdown - 已存的模型输出。
 * @param sources - 统计/回收站/驳回数据源（与完整分析同源）。
 * @param now - 当前时间。
 * @returns 提案与丢弃统计。
 */
export function reparseMarkdown(markdown: string, sources: PipelineSources, now = Date.now()): ReparseResult {
  const started = Date.now()
  const check = checkMarkdown(markdown)
  if (!check.ok) {
    return {
      ok: false,
      error: check.reason,
      proposals: [],
      dropped: { noDraft: 0, invalid: 0, rejected: 0, duplicate: 0 },
      elapsedMs: Date.now() - started,
    }
  }

  let result: PipelineResult
  try {
    result = runPipeline(markdown, sources, now)
  } catch (error) {
    return {
      ok: false,
      error: '解析失败：' + (error instanceof Error ? error.message : String(error)),
      proposals: [],
      dropped: { noDraft: 0, invalid: 0, rejected: 0, duplicate: 0 },
      elapsedMs: Date.now() - started,
    }
  }

  // 统一打上 reparse 标记，前端可据此展示「重新解析生成」。
  const proposals = result.proposals.map((proposal) => ({ ...proposal, source: 'reparse' as const }))

  return {
    ok: true,
    // 一条有效提案都没有也算「失败」，必须让用户看到原因而不是空列表。
    ...proposals.length === 0
      ? { error: '解析完成但没有产出任何有效提案（可能全部因缺草稿/字段非法/驳回去重被过滤）' }
      : {},
    proposals,
    dropped: {
      noDraft: result.droppedNoDraft.length,
      invalid: result.droppedInvalid.length,
      rejected: result.droppedRejected.length,
      duplicate: result.droppedDuplicate.length,
    },
    elapsedMs: Date.now() - started,
  }
}
