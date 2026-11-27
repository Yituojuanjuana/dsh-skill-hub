/**
 * 全量技能主动扫描。
 *
 * 与轨迹分析互补：轨迹回答「用户用这个技能时踩了什么坑」，主动扫描回答
 * 「这个技能本身写得有什么问题」。前者需要用户真的用过，后者覆盖全部已安装
 * 技能 —— 一个长期没人用但触发条件写得很糟的技能，只有主动扫描能发现。
 *
 * 评估维度（命中任意 2 项即候选）：
 *   1. 触发条件模糊
 *   2. 步骤不完整
 *   3. 输出不规范
 *   4. 描述与能力不符
 *   5. 可复用性差
 *   6. 缺少测试用例
 *
 * @module evolution/scan
 */
import type { EvolutionProposal } from '../protocol/evolution.ts'

/** 单次运行最多产出的主动扫描提案数。 */
export const MAX_SCAN_PROPOSALS = 5

/** 命中多少个维度才算候选。 */
export const MIN_SCAN_DIMENSIONS = 2

/** 近 N 天内刚优化过的技能跳过。 */
export const RECENT_OPTIMIZE_DAYS = 7

/** 一个待扫描的技能。 */
export interface ScannableSkill {
  name: string
  description: string
  /** SKILL.md 正文（含 frontmatter 后的部分）。 */
  body: string
  /** 最近一次被优化的时间（epoch ms）；没有则为 undefined。 */
  optimizedAt?: number
}

/** 扫描维度 id。 */
export type ScanDimension =
  | 'vague-trigger'
  | 'incomplete-steps'
  | 'unstructured-output'
  | 'description-mismatch'
  | 'poor-reusability'
  | 'no-tests'

/** 一条维度命中。 */
export interface DimensionHit {
  id: ScanDimension
  /** 人类可读的痛点描述。 */
  pain: string
  /** 具体证据（引用原文片段）。 */
  evidence: string
}

/** 单个技能的扫描结果。 */
export interface ScanFinding {
  skill: ScannableSkill
  /** 命中的维度。 */
  hits: DimensionHit[]
  /** 命中数量。 */
  score: number
}

/** 从正文里取一小段作为证据（去掉 markdown 记号）。 */
function snippet(text: string, max = 80): string {
  const flat = text.replace(/[#*`>-]/g, ' ').replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max) + '…' : flat
}

/**
 * 把技能描述压成提案里的可读快照（只取 description 一行）。
 *
 * 超过 160 字按词边界截断：优先在最后一个空格处收尾（且该空格不能太靠前，
 * 否则等于砍掉大半句），找不到合适的空格才硬切。省略号用单个 `…`。
 * @param description - frontmatter description 原文。
 * @returns 快照文本；描述为空时返回 undefined（调用方据此不写字段）。
 */
export function descriptionSnapshot(description: string | undefined): string | undefined {
  if (description === undefined) return undefined
  const flat = description.replace(/\s+/g, ' ').trim()
  if (flat === '') return undefined
  const MAX = 160
  if (flat.length <= MAX) return flat
  const head = flat.slice(0, MAX)
  const boundary = head.lastIndexOf(' ')
  return (boundary >= MAX / 2 ? head.slice(0, boundary) : head) + '…'
}

/**
 * 描述快照里的中文版本字段。
 *
 * **宁缺勿造**：只有原文真的含汉字才写 `skillSummaryZh`，不做任何翻译、
 * 不把英文拼成中文。旧提案没有这个字段时 UI 回退到 `skillSummary`。
 */
function zhSnapshot(description: string | undefined): string | undefined {
  if (description === undefined || !/[\u3400-\u9fff]/.test(description)) return undefined
  return descriptionSnapshot(description)
}

/**
 * 检查 6 个维度。
 * @param skill - 待扫描技能。
 * @returns 命中的维度列表。
 */
export function scanSkill(skill: ScannableSkill): DimensionHit[] {
  const hits: DimensionHit[] = []
  const body = skill.body

  // 1) 触发条件模糊：没有触发条件段，或触发词过于宽泛。
  const hasTriggerSection = /(触发条件|when\s*to\s*use|何时使用|使用时机)/i.test(body)
  const hasNegation = /(不适用|不要|禁止|避免|不触发|not\s+for)/i.test(body)
  if (!hasTriggerSection) {
    hits.push({
      id: 'vague-trigger',
      pain: '缺少明确的触发条件，模型只能凭描述猜测何时调用，容易误触发或该用时不触发',
      evidence: snippet(skill.description),
    })
  } else if (!hasNegation) {
    hits.push({
      id: 'vague-trigger',
      pain: '触发条件只写了「何时用」，没有写「何时不要用」，边界模糊容易误调用',
      evidence: snippet(body.match(/[^\n]*(触发条件|何时使用)[^\n]*/i)?.[0] ?? ''),
    })
  }

  // 2) 步骤不完整：没有步骤段，或步骤段很短且没有异常/失败处理。
  const stepMatches = body.match(/^\s*(?:\d+[.、)]|[-*]\s*\d+[.、)])\s+\S/gm) ?? []
  const hasErrorBranch = /(异常|失败|错误|兜底|回滚|fallback|error|catch)/i.test(body)
  if (stepMatches.length === 0) {
    hits.push({
      id: 'incomplete-steps',
      pain: '没有可执行的编号步骤，模型每次都要自行推断流程，结果不稳定',
      evidence: snippet(body.slice(0, 120)),
    })
  } else if (stepMatches.length >= 3 && !hasErrorBranch) {
    hits.push({
      id: 'incomplete-steps',
      pain: '有多步流程但没有异常分支与失败兜底，中途出错时无明确处理方式',
      evidence: snippet(body.match(/[^\n]*(步骤|流程)[^\n]*/i)?.[0] ?? ''),
    })
  }

  // 3) 输出不规范：没有**明确的输出格式规定**。
  //
  // 注意不能只匹配「输出」二字 —— 「随便输出点什么」也含「输出」，
  // 但那恰恰是没有格式规定的典型。要求出现「格式/模板/结构」这类规范词。
  const hasOutputSpec = /(输出格式|报告格式|返回格式|输出模板|固定格式|结构化输出|output\s*format)/i.test(body)
    || /(##\s*输出|输出[:：]\s*\n\s*[-*\d])/i.test(body)
  if (!hasOutputSpec) {
    hits.push({
      id: 'unstructured-output',
      pain: '没有规定输出格式，每次产出结构不一致，需要人工二次整理',
      evidence: snippet(skill.description),
    })
  }

  // 4) 描述与能力不符：描述极短或没有实质内容。
  const desc = skill.description.trim()
  if (desc.length < 20) {
    hits.push({
      id: 'description-mismatch',
      pain: '技能描述过短，无法说明实际能力边界，用户预期容易错位',
      evidence: desc === '' ? '(描述为空)' : snippet(desc),
    })
  } else if (!/(何时|when|用于|适用|use\s+when)/i.test(desc) && desc.length < 60) {
    hits.push({
      id: 'description-mismatch',
      pain: '描述只说了「做什么」，没说「什么时候用」，与模型路由所需信息不匹配',
      evidence: snippet(desc),
    })
  }

  // 5) 可复用性差：正文里硬编码了大量绝对路径或具体行号。
  const hardcoded = body.match(/([A-Za-z]:\\[^\s)]+|\/Users\/[^\s)]+|第\s*\d+\s*行|line\s*\d+)/g) ?? []
  if (hardcoded.length >= 2) {
    hits.push({
      id: 'poor-reusability',
      pain: '正文硬编码了具体路径/行号，换环境或改结构就失效，扩展成本高',
      evidence: hardcoded.slice(0, 2).join('、'),
    })
  }

  // 6) 缺少测试用例。
  if (!/(测试用例|测试示例|test\s*case|正向.*异常|验证用例)/i.test(body)) {
    hits.push({
      id: 'no-tests',
      pain: '没有正向/反向测试示例，落地后无法快速验证是否按预期工作',
      evidence: snippet(skill.description),
    })
  }

  return hits
}

/** 扫描批量技能。 */
export interface ScanOptions {
  /** 回收站里的技能名（跳过）。 */
  trashed?: ReadonlySet<string>
  /** 当前时间（判断「近 7 天刚优化过」）。 */
  now?: number
  /** 最多返回几条。 */
  limit?: number
}

/**
 * 扫描全部技能并挑出最值得优化的。
 *
 * 过滤顺序：回收站 → 近 7 天已优化 → 命中维度数不足 → 按维度数降序取前 N。
 * @param skills - 全部已安装技能。
 * @param options - 过滤与上限。
 * @returns 命中的技能（按维度数降序）。
 */
/**
 * FNV-1a 32-bit 稳定哈希。用于按 (类别, 技能名, 本地日期) 做确定性抽样：
 * 同样的输入永远得到同样的结果，不用 Math.random，因此同一天同一技能
 * 是否出现是可复现的，不会因为多跑几次就反复横跳。
 */
export function fnv1a32(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** 本地日期 YYYY-MM-DD（不依赖 UTC，避免跨日边界漂移）。 */
function localDate(now: number): string {
  const d = new Date(now)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * 按「同类提案出现概率」对扫描候选做确定性过滤。
 *
 * - 只影响候选**是否进入待审核列表**，从不自动落地任何提案。
 * - 概率缺省视为 1.0（不过滤）；0.25–1.0 之外的值会被夹取。
 * - 返回被抑制的条数，调用方按类别汇总（scanning result 的 suppressedByProbability）。
 */
export function filterByProbability<T extends { name: string }>(
  findings: readonly T[],
  kind: 'optimize' | 'reclaim',
  options: {
    kindProbability?: Partial<Record<'optimize' | 'reclaim', number>>
    now?: number
    enabled?: boolean
  } = {},
): { findings: T[]; suppressedByProbability: number } {
  let suppressedByProbability = 0
  if (options.enabled === false) return { findings: [...findings], suppressedByProbability }
  const date = localDate(options.now ?? Date.now())
  const kept: T[] = []
  const raw = options.kindProbability?.[kind]
  const p = raw === undefined ? 1 : Math.min(1, Math.max(0.25, raw))
  for (const finding of findings) {
    if (p >= 1) { kept.push(finding); continue }
    const key = `${kind}|${finding.name}|${date}`
    const bucket = fnv1a32(key) % 1000
    if (bucket < Math.round(p * 1000)) kept.push(finding)
    else suppressedByProbability++
  }
  return { findings: kept, suppressedByProbability }
}

export function scanAll(skills: readonly ScannableSkill[], options: ScanOptions = {}): ScanFinding[] {
  const now = options.now ?? Date.now()
  const limit = options.limit ?? MAX_SCAN_PROPOSALS
  const trashed = options.trashed ?? new Set<string>()
  const findings: ScanFinding[] = []

  for (const skill of skills) {
    // 回收站里的技能不扫描 —— 它已经下线了。
    if (trashed.has(skill.name)) continue
    // 近 7 天刚优化过：避免反复提同一条。
    if (skill.optimizedAt !== undefined && now - skill.optimizedAt < RECENT_OPTIMIZE_DAYS * 86_400_000) continue
    const hits = scanSkill(skill)
    if (hits.length < MIN_SCAN_DIMENSIONS) continue
    findings.push({ skill, hits, score: hits.length })
  }

  // 命中维度多的优先（问题更集中，优化收益更大）。
  findings.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
  return findings.slice(0, limit)
}

/**
 * 把扫描结果转成优化提案。
 *
 * 生成的提案 `source: 'scan'`、`discoveredBy: 'scan'`，并带完整字段
 * （痛点 / 新版源码 / 优化点 / 测试用例 / 风险评估）。
 *
 * 注意：新版源码这里只做**结构化骨架 + 已知缺陷修补提示**，真正的完整源码
 * 由模型在后续调用里补全；这一步保证字段不为空、可直接进入管线校验。
 * @param finding - 扫描结果。
 * @param now - 时间戳。
 * @returns 优化提案。
 */
export function toOptimizeProposal(finding: ScanFinding, now = Date.now()): EvolutionProposal {
  const { skill, hits } = finding
  const painPoints = hits.map((hit, index) => `${String(index + 1)}. ${hit.pain}（证据：${hit.evidence}）`).join('\n')
  const optimizedAt = skill.optimizedAt

  const summary = descriptionSnapshot(skill.description)
  const summaryZh = zhSnapshot(skill.description)
  return {
    id: 'scan-' + skill.name + '-' + String(now),
    kind: 'optimize',
    skillName: skill.name,
    displayName: skill.name,
    ...summary === undefined ? {} : { skillSummary: summary },
    ...summaryZh === undefined ? {} : { skillSummaryZh: summaryZh },
    createdAt: now,
    status: 'pending',
    changeType: 'modify',
    source: 'scan',
    discoveredBy: 'scan',
    painPoints,
    // 新版源码：保留原正文，并在开头插入本次要修补的要点清单，
    // 供人工审核时对照；真正落地前仍由用户确认。
    newSource: buildPatchedSource(skill, hits),
    testCases: [
      '正向：给出典型使用场景，技能应触发并按其步骤产出预期结果',
      '正向：给出同义表述，技能仍应正确识别并触发',
      '边界异常：给出明显不属于该技能的场景，技能不应被触发（验证触发条件已收紧）',
    ].join('\n'),
    riskAssessment: [
      '改动集中在触发条件与异常分支，不改变技能的核心职责',
      hits.some((hit) => hit.id === 'vague-trigger')
        ? '收紧触发条件后误触发范围会缩小，但需确认不会漏掉原有合法场景'
        : '未改动触发条件，误触发范围不变',
    ].join('；'),
    draft: buildPatchedSource(skill, hits),
    ...optimizedAt === undefined ? {} : {},
  }
}

/** 在原文基础上生成「带修补要点」的新版源码。 */
function buildPatchedSource(skill: ScannableSkill, hits: readonly DimensionHit[]): string {
  const checklist = hits.map((hit) => `- [${hit.id}] ${hit.pain}`).join('\n')
  const original = skill.body.trim()
  return [
    '---',
    `name: ${skill.name}`,
    `description: ${skill.description.replace(/\s+/g, ' ').trim()}`,
    '---',
    '',
    '<!-- 本次优化要点（落地时请据此修订下方正文）：',
    checklist,
    '-->',
    '',
    original,
  ].join('\n')
}

/**
 * 把闲置技能转成「建议移入回收站」提案。
 *
 * 与优化提案的关键区别：**不带新版源码、不占草稿字段**。
 * 一个从没被调用过的技能，优化它没有意义 —— 该做的是腾出技能库空间。
 * @param skill - 闲置技能。
 * @param now - 时间戳。
 * @returns 回收建议提案。
 */
export function toReclaimProposal(skill: ScannableSkill, now = Date.now()): EvolutionProposal {
  const summary = descriptionSnapshot(skill.description)
  const summaryZh = zhSnapshot(skill.description)
  return {
    id: 'reclaim-' + skill.name + '-' + String(now),
    kind: 'reclaim',
    skillName: skill.name,
    displayName: skill.name,
    ...summary === undefined ? {} : { skillSummary: summary },
    ...summaryZh === undefined ? {} : { skillSummaryZh: summaryZh },
    createdAt: now,
    status: 'pending',
    source: 'scan',
    discoveredBy: 'scan',
    // 统一按低价值处理：排序靠后（价值分由管线按 reclaim 类型给低分）。
    painPoints: '该技能长期未被调用，判定为低价值，建议移入回收站释放技能库空间',
    // 明确不带源码与草稿。
    newSource: undefined,
    draft: undefined,
    testCases: undefined,
    riskAssessment: '移入回收站后可在回收站页面恢复，不影响其他技能',
  }
}