/**
 * 会话消息的清洗：只保留**纯用户业务对话**。
 *
 * 为什么必须过滤：实测 1236 条 `user/message` 里有 728 条（58.9%）根本不是
 * 用户说的话 —— 运行时时间戳、插件上下文注入、子代理汇报、记忆系统快照、
 * 审批策略变更、后台任务通知。这些内容会让聚类把「Time sampled while
 * preparing turn 12」当成一个任务簇，也会让「出现次数」统计虚高。
 *
 * 过滤策略是**前缀匹配 + 精确特征**，不做模糊包含匹配：用户自己完全可能
 * 在消息里提到「插件」「时间」这些词，模糊匹配会误杀真实需求。
 *
 * @module evolution/review
 */

/** 复盘看到的一条消息。 */
export interface ReviewMessage {
  role: 'user' | 'assistant' | 'tool'
  text: string
  /** 工具名（仅 tool 消息）。 */
  tool?: string
  /** 工具是否失败（仅 tool 消息）。 */
  failed?: boolean
}

/** 单条消息的文本上限（字符）。 */
export const MESSAGE_CLIP = 1200

/** 一次最多送进模型的消息总字符数。 */
export const INPUT_BUDGET = 60_000

/** 一条噪声的判定规则。 */
interface NoiseRule {
  /** 规则 id，用于过滤日志统计。 */
  id: string
  /** 人类可读说明。 */
  label: string
  /** 命中即视为噪声（针对 trimStart 后的文本）。 */
  test: (text: string) => boolean
}

/**
 * 噪声规则表。
 *
 * 全部是**行首特征**：这些注入内容总是整段出现在消息开头，用行首匹配既能
 * 精确命中，又不会误伤用户正文里偶然出现的同类词汇。
 */
export const NOISE_RULES: readonly NoiseRule[] = [
  { id: 'time-sampled', label: '运行时时间戳', test: (t) => /^Time sampled while preparing turn/.test(t) },
  { id: 'agent-message', label: '子代理汇报', test: (t) => /^Agent [\w.-]+ sent a message:/.test(t) },
  { id: 'subagent-done', label: '子代理结束通知', test: (t) => /^Background subagent [\w.-]+ finished/.test(t) },
  { id: 'plugin-context', label: '插件上下文注入', test: (t) => /^\[Plugin context from/.test(t) },
  { id: 'mnemon', label: '记忆系统快照', test: (t) => /^\[MNEMON\]/.test(t) || /^MNEMON RUNTIME MEMORY SNAPSHOT/.test(t) },
  { id: 'tool-run-hint', label: '工具连跑提示', test: (t) => /^You have made a run of tool calls/.test(t) },
  { id: 'hindsight', label: 'Hindsight 记忆注入', test: (t) => /^<hindsight_knowledge/.test(t) },
  { id: 'path-hint', label: '路径提示', test: (t) => /^<path>/.test(t) },
  { id: 'background-job', label: '后台任务通知', test: (t) => /^background job [\w-]+ \(/.test(t) },
  { id: 'approval-policy', label: '审批策略变更', test: (t) => /^The user changed the approval policy/.test(t) },
  { id: 'runtime-context', label: '运行时上下文快照', test: (t) => /^Current runtime context\./.test(t) },
  { id: 'safety-net', label: 'CC Safety Net 提示', test: (t) => /^CC Safety Net did not check/.test(t) },
  { id: 'system-reminder', label: '系统提醒块', test: (t) => /^<system-reminder>/.test(t) },
  { id: 'environment', label: '环境块', test: (t) => /^<environment/.test(t) },
]

/** 一次过滤的统计。 */
export interface NoiseFilterStats {
  /** 检查过的用户消息总数。 */
  checked: number
  /** 被判定为噪声的条数。 */
  filtered: number
  /** 按规则统计的命中次数。 */
  byRule: Record<string, number>
}

/** 新建一份空的过滤统计。 */
export function emptyNoiseStats(): NoiseFilterStats {
  return { checked: 0, filtered: 0, byRule: {} }
}

/**
 * 判断一条用户消息是否为噪声。
 * @param text - 消息原文。
 * @returns 命中的规则；不是噪声返回 undefined。
 */
export function noiseRuleOf(text: string): NoiseRule | undefined {
  const head = text.trimStart()
  if (head === '') return { id: 'empty', label: '空消息', test: () => true }
  return NOISE_RULES.find((rule) => rule.test(head))
}

/**
 * 过滤一条用户消息，并累加统计。
 * @param text - 消息原文。
 * @param stats - 统计累加器（原地修改）。
 * @returns 保留时返回原文，噪声返回 undefined。
 */
export function keepUserMessage(text: string, stats: NoiseFilterStats): string | undefined {
  stats.checked += 1
  const rule = noiseRuleOf(text)
  if (rule === undefined) return text
  stats.filtered += 1
  stats.byRule[rule.id] = (stats.byRule[rule.id] ?? 0) + 1
  return undefined
}

/** 把过滤统计格式化成一行日志文本。 */
export function formatNoiseStats(stats: NoiseFilterStats): string {
  if (stats.checked === 0) return 'no user messages checked'
  const percent = ((stats.filtered / stats.checked) * 100).toFixed(1)
  const detail = Object.entries(stats.byRule)
    .sort((a, b) => b[1] - a[1])
    .map(([id, count]) => id + '=' + String(count))
    .join(' ')
  return `noise filter: kept ${String(stats.checked - stats.filtered)}/${String(stats.checked)} user messages (dropped ${String(stats.filtered)}, ${percent}%)${detail === '' ? '' : ' [' + detail + ']'}`
}

/** 把超长文本截断并加省略号。 */
export function clipText(text: string, max = MESSAGE_CLIP): string {
  return text.length > max ? text.slice(0, max) + ' …' : text
}

/**
 * 按总预算裁剪消息：保留最近的部分。
 * @param messages - 按时序的消息。
 * @param budget - 总字符预算。
 * @returns 裁剪后的消息（仍是时序）。
 */
export function boundMessages(messages: readonly ReviewMessage[], budget = INPUT_BUDGET): ReviewMessage[] {
  const out: ReviewMessage[] = []
  let used = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined) continue
    const text = clipText(message.text)
    if (used + text.length > budget) break
    used += text.length
    out.unshift({ ...message, text })
  }
  return out
}
