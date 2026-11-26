/**
 * 技能进化元代理：读会话轨迹 + 现有技能，产出**提案文本**。
 *
 * 三条硬约束（写在提示词里，也在代码里兜底）：
 * 1. 只产出提案，绝不读写技能文件 —— 这个模块没有任何 fs 写入技能目录的代码路径；
 * 2. 无价值时返回固定的「暂无技能进化提案」；
 * 3. 草稿必须带触发条件与测试用例（3 正向 + 1 异常）。
 */
import type { EvolutionProposal, EvolutionRunResult, EvolutionRunStatus } from '../protocol/evolution.ts'
import { runPipeline } from './pipeline.ts'
import { MAX_SCAN_PROPOSALS, scanAll, toOptimizeProposal, toReclaimProposal, type ScannableSkill } from './scan.ts'
import { normalizeName, SKILL_ID_PATTERN, toDisplayName, toDescription } from './naming.ts'
import type { ReviewMessage } from './review.ts'

/** 从会话里读消息的注入点。 */
export interface EvolutionSessionReader {
  /**
   * 候选会话（**顺序不重要**：引擎会自己重排）。
   *
   * - `userMessages`：用户消息数提示，让引擎不必先读全文就能排序；
   * - `cwd`：会话所在工作区，用于「业务工作区优先」的取样规则。
   */
  listSessions(): Promise<Array<{ id: string; userMessages?: number; cwd?: string }>>
  /** 一个会话的可见消息。 */
  readMessages(sessionId: string): Promise<ReviewMessage[]>
  /** 会话标题（可选）。 */
  readTitle?(sessionId: string): Promise<string | undefined>
  /** 把噪声过滤统计写成日志（可选；一次运行结束后调用）。 */
  flushNoiseStats?(): string
}

/** 模型调用注入点。 */
export interface EvolutionModel {
  complete(system: string, user: string, signal: AbortSignal): Promise<string>
}

/** 引擎依赖。 */
export interface EvolutionEngineDeps {
  reader: EvolutionSessionReader
  model: EvolutionModel
  /** 现有技能名 + 描述（用于判断「已有技能能否覆盖」）。 */
  listSkills: () => Promise<Array<{ name: string; description: string }>>
  /** 读某个技能的正文（反思时作为材料）。 */
  readSkillBody?: (name: string) => Promise<string | undefined>
  /**
   * 读技能的发现来源（`user-dsh` / `agent-trae-cn` / …）。
   *
   * 进化卡片要展示「归属目录」，与通用页「按目录」视图同一套分类。
   */
  readSkillSource?: (name: string) => Promise<string | undefined>
  /** 是否开启。 */
  enabled: () => boolean
  /** 单次最多读几个会话。 */
  maxSessions?: number
  /** 单会话最多读几条消息。 */
  maxMessagesPerSession?: number
  /** 会话进入分析的最低用户消息数（默认 MIN_USER_MESSAGES）。 */
  minUserMessages?: number
  /** 历史驳回记录（约束 4：同类场景不再重复生成）。 */
  listRejections?: () => Promise<Array<{ skillName: string; reason: string }>>
  /** 技能运行统计（历史调用量 / 近 7 天 / 成功率）。 */
  listUsage?: () => Promise<Array<{ name: string; total: number; week: number; successRate?: number; lastUsed?: number }>>
  /** 回收站元数据。 */
  listTrash?: () => Promise<Array<{ name: string; movedAt: number; note?: string }>>
  /** 日志出口（去重统计等）。 */
  log?: (message: string) => void
  /** 单次分析的模型调用时限（毫秒）；缺省 EVOLUTION_TIMEOUT_MS。 */
  timeoutMs?: number
  /** 当前时间注入（测试用）。 */
  now?: () => number
}

/** 无价值时的固定输出。 */
export const NO_PROPOSAL_TEXT = '暂无技能进化提案'


/** 单次进化的超时（毫秒）。 */
export const EVOLUTION_TIMEOUT_MS = 240_000

/** 默认读多少个会话。 */
export const DEFAULT_MAX_SESSIONS = 12

/** 默认每个会话读多少条消息。 */
export const DEFAULT_MAX_MESSAGES = 80

/**
 * 会话进入分析的最低用户消息数。
 *
 * mnemon 的子代理会话（`mnemon-run-v1-*` / `mnemon-review-v1-*`）只有 1~3 条
 * 消息，按 mtime 排序时会挤占全部名额，让真正有价值的长会话进不来。
 * 少于这个数的会话直接排除。
 */
export const MIN_USER_MESSAGES = 3

/**
 * 业务工作区的识别特征。
 *
 * 命中这些片段的会话在**同等消息量**下优先入选：它们承载的是具体业务规则
 * （游泳馆排课、会员卡、教练分配），比通用开发会话更适合挖掘细分专项技能。
 * 通用开发会话（default-workspace）不在这里，所以不会被特殊对待。
 */
export const BUSINESS_WORKSPACE_HINTS: readonly string[] = ['sports-coach']

/** 单条消息截断长度。 */
const MESSAGE_CLIP = 1200

/**
 * 元代理的系统提示。
 *
 * 格式与判定规则直接来自需求，改这里等于改产品行为，动之前先确认。
 * 五条强制约束是产品的核心承诺（只提案、无价值直返、草稿写触发条件、
 * 记住驳回理由、不加闲聊），任何一条都不能在改动中丢失。
 */
export const EVOLUTION_SYSTEM_PROMPT = [
  '你是技能进化元代理，拥有两大核心职责：技能反思优化已有技能、挖掘推荐适合新建的独立技能。',
  '',
  '# 工作步骤（必须按顺序执行，不要跳步）',
  '',
  '## 第一步：逐会话拆解最小业务子任务',
  '对每个会话，把它拆到**最小业务子任务**级别，不要停在「开发」「改页面」这种大类。',
  '例如「优化后台管理页面」不是子任务；「游泳馆排课表的课时字段调整」才是。',
  '输出格式（每个会话一段）：',
  '### 会话：<会话标题或前 12 位 id>｜工作区：<cwd>｜用户消息：<n> 条',
  '- 子任务：<名称>｜出现次数：<n>｜证据：<引用用户原话片段>',
  '- 子任务：<名称>｜出现次数：<n>｜证据：<引用用户原话片段>',
  '',
  '## 第二步：统计子任务出现次数并跨会话归并',
  '把语义相同的子任务合并计数（同一个业务流程在不同会话里出现要累加）。',
  '',
  '## 第三步：执行细分专项判定',
  '**优先识别 sports-coach（运动陪练平台）的游泳馆专属业务子流程**：',
  '排课/课程表、教练分配、学员档案、会员卡、预约抢单、支付退款、通知推送、',
  '统计报表、场馆/场地管理、体验课成交率等。',
  '这类子任务只要出现 **≥2 次** → 必须标记【细分专项】，优先级「中」；流程是否完全固定不作为跳过理由，不固定就在「潜在风险」列写明。',
  '其它场景再按「≥3 次」的通用规则判定是否【新建】。',
  '',
  '# 基础判定规则',
  '',
  '## ✅ 适合推荐新建技能（尽量多条同时满足）',
  '- 同类任务出现 ≥3 次',
  '- 当前没有对应的现成技能，依赖模型裸推理，每次要重复说明、反复纠正',
  '- 流程固定，步骤多，封装后能降低幻觉、减少人工介入',
  '',
  '## ❌ 不推荐新建技能',
  '- 只出现一次的临时需求、极度小众场景',
  '- 现有技能组合就可以搞定',
  '- 业务变化极不稳定，没有固定流程，无法写触发规则',
  '',
  '## ✅ 允许挖掘【细分专项】技能（重要例外）',
  '**即使现有通用技能可以覆盖**，只要属于 sports-coach 运动陪练平台（游泳馆业务）的专属子任务且出现 **≥2 次**，就必须输出【细分专项】提案，不得以「已有技能覆盖」为由跳过。',
  '其它具体业务平台/项目的专属流程同样按 ≥2 次判定；通用开发任务仍走 ≥3 次的通用规则。',
  '这类提案在「建议」列标记【细分专项】，优先级固定为「中」。',
  '草稿里必须写明：**该技能是游泳馆业务专属**，依赖已有的通用基础技能（并指出依赖哪个通用技能），用来减少每次重复交代业务规范。',
  '',
  '## 反思判定规则（针对已有技能）',
  '找出：触发条件不准、缺少异常分支、提示模糊、校验缺失、步骤冗余的已有技能',
  '支持方案：修改技能、合并重复技能、标记长期失效技能归档下线',
  '',
  '# 输出固定格式',
  '# 技能进化提案汇总',
  '## 一、新建技能推荐清单',
  '序号｜优先级｜技能名称｜适用场景｜出现次数｜收益｜潜在风险｜建议（新建 / 细分专项 / 继续观察）',
  '> 标记【新建】或【细分专项】的，附带【候选技能草稿】（名称、描述、触发条件、执行步骤、测试用例）',
  '> 标记【继续观察】的只记录，不生成草稿',
  '> 【细分专项】的草稿里必须写明「该技能是游泳馆业务专属，依赖已有通用基础技能」，写明它减少哪些重复交代的业务规范，并指出依赖哪个通用技能',
  '',
  '## 二、已有技能优化提案',
  '变更类型：修改 / 合并 / 下线归档',
  '目标技能：',
  '痛点总结：',
  '新版技能源码（保持和项目一致格式：md / yaml）',
  '测试用例：至少3条正向用例 + 1条边界异常case',
  '风险评估：',
  '收益对比：',
  '',
  '# 强制约束',
  '1. 你只产出提案文本，绝不自动读写、修改本地任何技能文件，等待人工审核确认',
  `2. 如果本次轨迹没有任何优化、新建价值，直接返回：${NO_PROPOSAL_TEXT}`,
  '3. 草稿技能必须写清楚触发条件，防止后续Agent误调用、乱调用',
  '4. 当用户驳回提案时，记住驳回理由，同类场景不再重复生成相同提案',
  '5. 不要输出多余闲聊、解释，严格按照上面的模板输出',
].join('\n')

/** 把一条消息压成一行，避免超长正文吃掉预算。 */
function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > MESSAGE_CLIP ? flat.slice(0, MESSAGE_CLIP) + ' …' : flat
}

/**
 * 构造用户消息：现有技能清单 + 历史驳回理由 + 轨迹。
 * @param skills - 现有技能（名 + 描述 + 可选正文）。
 * @param sessions - 每段轨迹的消息。
 * @param rejections - 历史驳回记录（约束 4：同类场景不再重复生成）。
 * @returns 模型输入。
 */
export function renderEvolutionInput(
  skills: ReadonlyArray<{ name: string; description: string; body?: string }>,
  sessions: ReadonlyArray<{ id: string; title?: string; messages: ReviewMessage[] }>,
  rejections: ReadonlyArray<{ skillName: string; reason: string }> = [],
): string {
  const lines: string[] = []
  lines.push('## 现有技能（判断「已有技能能否覆盖」时用这个清单）')
  if (skills.length === 0) lines.push('（本机没有任何技能）')
  for (const skill of skills.slice(0, 120)) {
    lines.push(`- ${skill.name}: ${clip(skill.description)}`)
    if (skill.body !== undefined && skill.body !== '') {
      // 只给前 600 字：反思要看出「步骤冗余/校验缺失」，不需要整篇。
      lines.push('  正文节选: ' + clip(skill.body).slice(0, 600))
    }
  }

  // 约束 4：把历史驳回理由喂回去，同类场景不再重复生成。
  if (rejections.length > 0) {
    lines.push('')
    lines.push('## 历史驳回记录（同类场景不要再提同样的提案）')
    for (const rejection of rejections.slice(0, 40)) {
      lines.push(`- ${rejection.skillName}: ${clip(rejection.reason)}`)
    }
  }

  lines.push('')
  lines.push('## 历史轨迹')
  if (sessions.length === 0) lines.push('（没有可分析的会话）')
  for (const session of sessions) {
    lines.push('')
    lines.push(`### 会话 ${session.title !== undefined && session.title !== '' ? session.title : session.id.slice(0, 12)}`)
    for (const message of session.messages) {
      const who = message.role === 'user' ? '用户' : message.role === 'assistant' ? '助手' : `工具${message.tool !== undefined ? ' ' + message.tool : ''}${message.failed === true ? '（失败）' : ''}`
      lines.push(`[${who}] ${clip(message.text)}`)
    }
  }
  lines.push('')
  lines.push('现在按系统提示里的固定格式产出提案。没有价值就只输出那一行固定文本。')
  return lines.join('\n')
}

/** 出现次数的合理上限。超过这个数一定是解析错位，不是真实计数。 */
export const MAX_OCCURRENCES = 999

/**
 * 挑一个可读的中文展示名。
 *
 * 依次尝试：原始标题 → 适用场景 → 草稿里的「描述」首句。
 * 全部是英文时最后退回「未命名技能」，但会把 ID 展示在旁边的等宽标签里，
 * 所以不会真的丢失识别信息。
 * @param rawName - 表格里的技能名。
 * @param scenario - 适用场景列。
 * @param draft - 草稿正文（可能含中文描述）。
 * @returns 展示名。
 */
function pickDisplayName(rawName: string, scenario: string, draft?: string): string {
  for (const candidate of [rawName, scenario]) {
    const name = toDisplayName(candidate)
    if (name !== '未命名技能') return name
  }
  // 草稿正文里通常有 `**描述**：中文说明`，从中取前若干字。
  const described = draft === undefined ? undefined : /\*{0,2}描述\*{0,2}[:：]\s*([^\n]{2,60})/.exec(draft)?.[1]
  if (described !== undefined) {
    const name = toDisplayName(described)
    if (name !== '未命名技能') return name
  }
  return toDisplayName(rawName)
}

/**
 * 按名字或序号找草稿正文。
 *
 * 匹配优先级（避免「一个草稿被所有行共用」）：
 *   1. 名字完全相等；
 *   2. **序号**（草稿标题的 `候选技能草稿 N` 与表格第 N 行是同一提案）——
 *      这一步要早于模糊包含，否则长句名会同时命中多个草稿；
 *   3. 名字互相包含（仅在前两步都落空时兜底）。
 * @param blocks - 草稿表（名字 → 正文，插入顺序即出现顺序）。
 * @param rawName - 表格里的原始名字。
 * @param order - 该行在表格里的序号（1 起）。
 * @returns 草稿正文；找不到返回 undefined。
 */
function findDraft(blocks: ReadonlyMap<string, string>, rawName: string, order: number): string | undefined {
  const exact = blocks.get(rawName)
  if (exact !== undefined) return exact
  // 序号兜底优先：这一步最可靠，且不会重复命中。
  const ordered = [...blocks.keys()]
  const byOrder = ordered[order - 1]
  if (byOrder !== undefined) {
    const body = blocks.get(byOrder)
    if (body !== undefined) return body
  }
  // 最后才用包含匹配。
  for (const [key, body] of blocks) {
    if (key === '' || rawName === '') continue
    if (key.includes(rawName) || rawName.includes(key)) return body
  }
  return undefined
}

/**
 * 按名字或序号找草稿标题里的规范 ID。
 * @param ids - 序号 → 草稿标题名（按出现顺序）。
 * @param rawName - 表格里的原始名字。
 * @param order - 表格序号。
 * @returns 规范 ID；找不到返回 undefined。
 */
function findDraftId(ids: readonly string[], rawName: string, order: number): string | undefined {
  const exact = ids.find((id) => id === rawName)
  if (exact !== undefined) return exact
  return ids[order - 1]
}

/**
 * 解析「出现次数」单元格。
 *
 * 模型会写 `6（session-66f4 ×2、session-b9b8 ×2）` 这种带证据的形式。
 * 早期实现用 `replace(/[^\d]/g,'')` 把**所有**数字拼起来，于是
 * `6（…×2…×2…×2…285c…368d ×2）` 变成 `66642982822853680` —— 一个 17 位的
 * 天文数字。正确做法是只取**开头的第一个整数**（那才是真实次数），
 * 并且做边界保护：超出合理范围就当作未知，绝不把垃圾数字展示给用户。
 * @param cell - 表格里「出现次数」列的原文。
 * @returns 合理范围内的非负整数；无法判定时返回 0。
 */
export function parseOccurrences(cell: string): number {
  const text = String(cell ?? '').trim()
  if (text === '') return 0
  // 只认开头（可带「约」「~」前缀）的第一个整数，例如 "6（session-...）" → 6。
  const match = /^\D{0,4}?(\d{1,4})/.exec(text)
  const value = match?.[1] === undefined ? 0 : Number(match[1])
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_OCCURRENCES) return 0
  return value
}

/**
 * 从模型输出里解析出结构化提案。
 *
 * 模型给的是固定格式的 Markdown，这里做**宽松**解析：能抽出来就抽，抽不出
 * 就保留 markdown 让 UI 直接渲染原文 —— 解析失败不能让整次运行看起来没结果。
 * @param markdown - 模型输出。
 * @param now - 时间戳。
 * @returns 结构化提案（可能为空）。
 */
export function parseProposals(markdown: string, now = Date.now()): EvolutionProposal[] {
  const proposals: EvolutionProposal[] = []
  const trimmedAll = markdown.trim()
  if (trimmedAll === '') return proposals
  // 「无提案」判定必须是**整篇就等于这句话**，不能是 includes。
  //
  // 之前的写法是 `markdown.includes(NO_PROPOSAL_TEXT)`，而系统提示词里本身就
  // 含有这句固定文案（强制约束第 2 条）。模型一旦把约束复述出来、或按模板
  // 正常输出，includes 就命中，整份提案被当成「无提案」丢弃 —— 这是 proposals
  // 一直是 0 的直接原因之一。
  const isNoProposal = trimmedAll === NO_PROPOSAL_TEXT
    || trimmedAll.replace(/[`*"'“”「」\s]/g, '') === NO_PROPOSAL_TEXT
  if (isNoProposal) return proposals

  // 技能名清洗：模型常写成 `` `name` ``、`**name**`、"name"、"「name」"，
  // 直接当目录名会带出一堆非法字符。去壳后只取第一个词（表格里偶尔跟说明）。
  const cleanSkillName = (text: string): string => {
    const flat = String(text ?? '').replace(/[`*"'“”「」]/g, '').trim()
    return flat.split(/\s+/)[0] ?? ''
  }

  // ---- 一、新建技能推荐清单：表格行 ----
  //
  // 模型会在模板前先输出一段英文分析过程（"Let me analyze the sessions…"），
  // 里面也有 `1. session-66f4 — …` 这类编号行。所以不能「找到第一个像表格的
  // 东西就返回」，必须**只认带足够竖线分隔符的行**，前言自然被跳过。
  const newSection = markdown.split('## 二、')[0] ?? ''
  const draftBlocks = new Map<string, string>()
  /** 因缺草稿被丢弃的技能名（供调用方记日志）。 */
  const droppedNoDraft: string[] = []
  /** 草稿标题里的技能名，按出现顺序（序号兜底匹配用）。 */
  const draftIds: string[] = []
  // 草稿块有两种常见写法：
  //   `### 候选技能草稿 1：`name``（中文冒号，模型最常用）
  //   `### 候选技能草稿 1｜name`（全角竖线）
  //   `【候选技能草稿】` 正文块（提示词里的写法）
  // 三种都要认，否则草稿会整体丢失 —— 这正是「解析出 0 条」的直接原因。
  // 标题里可能夹 `【细分专项】` 前缀，用 (?:【[^】]*】)? 吃掉。
  // 草稿块有三种常见写法（模型每次挑一种，全都要认）：
  //   `### 候选技能草稿 1：`name``（中文冒号）
  //   `### 候选技能草稿 1｜name`（全角竖线）
  //   `### 【候选技能草稿 1】name`（方括号包编号）
  //   `【候选技能草稿】` 正文块（提示词里的写法）
  //
  // **必须在全文扫描，不能只看 `## 二、` 之前**：模型经常先写一段分析过程，
  // 再输出正式模板，导致 `## 二、` 出现在草稿之前（实测 markdown 里
  // `## 二、` 在 8840、草稿标题在 10887）。按段落切分会把所有草稿划走。
  for (const match of markdown.matchAll(/^#{2,4}\s*(?:【\s*候选技能草稿\s*\d*\s*】|候选技能草稿\s*\d*)\s*(?:【[^】]*】)?\s*[:：｜|]?\s*(.+?)[ \t]*\n([\s\S]*?)(?=\n#{2,4}\s*(?:【\s*候选技能草稿|候选技能草稿)|\n#{1,2}\s+(?!候选技能草稿)|\n---[ \t]*(?:\n|$)|$(?![\s\S]))/gm)) {
    const key = cleanSkillName(match[1] ?? '')
    const body = (match[2] ?? '').trim().replace(/\n---\s*$/, '').trim()
    if (key !== '' && body !== '') {
      draftBlocks.set(key, body)
      draftIds.push(key)
    }
  }
  for (const match of markdown.matchAll(/【候选技能草稿】\s*\n?([\s\S]*?)(?=\n【候选技能草稿】|\n## |\n> 标记|\s*$)/g)) {
    const body = match[1]?.trim() ?? ''
    if (body === '') continue
    // 名称标签可能写成 `**名称**：xxx` 或 `名称：xxx`。
    const key = cleanSkillName(body.match(/\*{0,2}名称\*{0,2}[:：]\s*(.+)/)?.[1] ?? String(draftBlocks.size))
    draftBlocks.set(key, body)
  }

  let index = 0
  for (const line of newSection.split('\n')) {
    const trimmed = line.trim()
    // 表格行可能以 `|` 开头（`| 1 | 高 | name | …`），也可能直接以序号开头
    // （`1｜高｜name｜…`）。先剥首尾竖线再判断「是不是序号行」，否则带竖线的
    // 标准 Markdown 表格全部会被跳过 —— 这是 proposals=0 的第二个直接原因。
    const stripped = trimmed.replace(/^\|/, '').replace(/\|$/, '').trim()
    if (!/^\d+/.test(stripped)) continue
    const cells = stripped.split(/[｜|]/).map((cell) => cell.trim())
    // 前言里的 `1. session-66f4 — coach-admin 工作台重设计` 只会有 1 个单元格，
    // 这里用「至少 6 列」把它挡掉；真表格有 8 列。
    if (cells.length < 6) continue
    index += 1
    // 列数有两种常见形态：
    //   8 列：`| 1 | 中 | name | 场景 | 5 | 收益 | 风险 | 建议 |`（标准表格）
    //   7 列：`1. 中 | name | 场景 | 5 | ... | 风险 | 建议`（编号列表，序号与优先级合并）
    // 之前一律按 8 列解构，7 列时 `skillName` 取到的是「适用场景」列 —— 全行错位。
    let priority = ''
    let skillNameRaw = ''
    let scenario = ''
    let occurrences = ''
    let benefit = ''
    let risk = ''
    let advice = ''
    const first = cells[0] ?? ''
    const merged = /^(\d+)\s*[.、]?\s*(.*)$/.exec(first)
    if (cells.length >= 8) {
      ;[, priority, skillNameRaw, scenario, occurrences, benefit, risk, advice] = cells
    } else {
      // 7 列：首格是「序号. 优先级」。
      priority = merged?.[2] ?? ''
      ;[, skillNameRaw, scenario, occurrences, benefit, risk, advice] = cells
    }
    const rawName = cleanSkillName(skillNameRaw ?? '')
    // 占位符行（`---`、`—`）不是真提案。
    if (rawName === '' || /^[-—–]+$/.test(rawName)) continue
    const adviceText = advice ?? ''
    // 【细分专项】必须比【新建】先判：它同样带草稿，但优先级固定为「中」。
    const isNiche = /细分专项/.test(adviceText)
    const isCreate = isNiche || /新建/.test(adviceText)
    // 草稿匹配：模型给表格起的名字（长句）和草稿标题里的名字（规范 ID）经常不同，
    // 所以按「序号」也能对上 —— 草稿标题带 `候选技能草稿 N`，N 与表格序号一致。
    const draft = isCreate ? findDraft(draftBlocks, rawName, index) : undefined
    // 命名规范化：长句业务描述不能当目录名，也不能当标题。
    //
    // 关键：如果草稿标题里已经给了规范 ID（`sports-coach-miniapp-verify`），
    // **以它为准** —— 那是模型自己起好的名字，比我从句子里推的更贴切。
    const draftId = draft === undefined ? undefined : findDraftId(draftIds, rawName, index)
    // 展示名优先从「原始标题 + 适用场景」里提炼中文名词短语；
    // 两者都是纯英文时（模型只给了 ID），退回草稿正文里的「描述」首句。
    const named = draftId !== undefined && SKILL_ID_PATTERN.test(draftId)
      ? {
          id: draftId,
          displayName: pickDisplayName(rawName, scenario ?? '', draft),
          description: toDescription(rawName, scenario ?? ''),
        }
      : normalizeName(rawName, scenario ?? '', String(index))
    const occurrencesCount = parseOccurrences(occurrences ?? '')
    // 没有草稿的「新建 / 细分专项」提案直接丢弃。
    //
    // 理由：这类提案的**唯一价值**就是那份可以直接落地的技能草稿。没有草稿时
    // 用户在卡片上只能看到一句话描述，既无法审核也无法落地，只会占位噪音。
    // 【继续观察】本来就不带草稿，不受这条约束。
    if (isCreate && (draft === undefined || draft.trim() === '')) {
      droppedNoDraft.push(named.id)
      continue
    }
    proposals.push({
      id: 'new-' + String(index) + '-' + String(now),
      kind: 'new-skill',
      skillName: named.id,
      displayName: named.displayName,
      createdAt: now,
      status: 'pending',
      // 细分专项的优先级由规则固定为「中」，不采信模型自己写的优先级。
      priority: isNiche ? 'medium' : /高/.test(priority ?? '') ? 'high' : /低/.test(priority ?? '') ? 'low' : 'medium',
      // 原始长句业务描述落到 scenario（详情里展示），不再占标题位。
      scenario: named.description,
      occurrences: occurrencesCount,
      benefit: benefit ?? '',
      risk: risk ?? '',
      recommendation: isNiche ? 'niche' : isCreate ? 'create' : 'observe',
      ...draft === undefined ? {} : { draft },
    })
  }

  // ---- 二、已有技能优化提案：按「变更类型：」分块 ----
  const optSection = markdown.split('## 二、')[1] ?? ''
  const LABEL_NAMES = ['变更类型', '目标技能', '痛点总结', '新版技能源码', '测试用例', '风险评估', '收益对比']
  // 字段边界：下一个标签可以带 ### 标题、**加粗**、括号说明。
  const labelBoundary = '(?=\\n\\s*(?:#{1,4}\\s*)?(?:\\*\\*)?(?:' + LABEL_NAMES.join('|') + ')(?:\\*\\*)?\\s*(?:（[^）]*）)?\\s*[:：]|$)'
  for (const block of optSection.split(/(?=变更类型[:：])/g)) {
    if (!/变更类型[:：]/.test(block)) continue
    // 模型常写成 `### 变更类型：修改` / `**痛点总结**：` / `新版技能源码（...）：`，
    // 标题、加粗、括号说明都不能影响字段匹配。
    const pick = (label: string): string => {
      const hit = block.match(new RegExp('(?:#{1,4}\\s*)?(?:\\*\\*)?(?:' + label + ')(?:\\*\\*)?\\s*(?:（[^）]*）)?\\s*[:：]?\\s*([\\s\\S]*?)' + labelBoundary))
      return (hit?.[1] ?? '').replace(/\n---\s*$/, '').trim()
    }
    const changeRaw = pick('变更类型')
    const target = cleanSkillName(pick('目标技能'))
    if (target === '') continue
    const newSource = pick('新版技能源码')
    // 优化提案同样必须带完整草稿（新版源码即草稿）。
    //
    // 理由与新建一致：没有源码就无法落地，卡片上只剩一句「痛点总结」，
    // 用户既审核不了也应用不了。缺源码的优化提案直接丢弃。
    if (newSource.trim() === '') {
      droppedNoDraft.push(target)
      continue
    }
    index += 1
    proposals.push({
      id: 'opt-' + String(index) + '-' + String(now),
      kind: 'optimize',
      // 优化提案沿用原有技能 ID，不改名。
      skillName: target,
      createdAt: now,
      status: 'pending',
      changeType: /合并/.test(changeRaw) ? 'merge' : /归档|下线/.test(changeRaw) ? 'archive' : 'modify',
      painPoints: pick('痛点总结'),
      newSource,
      testCases: pick('测试用例'),
      riskAssessment: pick('风险评估'),
      benefitCompare: pick('收益对比'),
      // 优化提案的草稿就是新版源码，统一放进 draft 供 UI 展开查看。
      draft: newSource,
    })
  }
  return proposals
}

/** 引擎主体。 */
export class EvolutionEngine {
  private readonly deps: EvolutionEngineDeps
  private running = false
  /** 本次（或最近一次）运行的开始时间。 */
  private startedAt: number | undefined
  /** 最近一次运行的结束时间。 */
  private finishedAt: number | undefined
  /** 最近一次失败原因（模型失败 / 超时 / 读会话失败）。 */
  private lastError: string | undefined
  /** 最近一次被跳过的原因（未开启 / 无达标会话）。 */
  private lastSkip: string | undefined
  /** 会话 id → 工作区路径（取样时判断业务工作区用）。 */
  private readonly cwdOf = new Map<string, string>()

  constructor(deps: EvolutionEngineDeps) {
    this.deps = deps
  }

  /**
   * 判断一个会话是否属于业务工作区。
   * @param sessionId - 会话 id。
   * @returns 命中 BUSINESS_WORKSPACE_HINTS 任一片段即为 true。
   */
  private isBusinessSession(sessionId: string): boolean {
    const cwd = this.cwdOf.get(sessionId)
    if (cwd === undefined) return false
    const lower = cwd.toLowerCase()
    return BUSINESS_WORKSPACE_HINTS.some((hint) => lower.includes(hint.toLowerCase()))
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /**
   * 跑一次进化。
   * @param sessionId - 只分析该会话；缺省取最近的若干个。
   * @returns 提案文本与结构化结果。
   */
  async run(sessionId?: string): Promise<EvolutionRunResult> {
    if (!this.deps.enabled()) return { markdown: '', proposals: [], sessions: 0, messages: 0, skipped: 'evolution disabled' }
    if (this.running) return { markdown: '', proposals: [], sessions: 0, messages: 0, skipped: 'another run is in progress' }
    this.running = true
    this.startedAt = this.now()
    this.lastError = undefined
    try {
      const result = await this.execute(sessionId)
      // 失败 / 跳过原因都留在引擎上，让 GET 接口能读到 —— 前端据此在面板顶部显示。
      if (result.error !== undefined) this.lastError = result.error
      this.lastSkip = result.skipped
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.lastError = message
      throw error
    } finally {
      this.running = false
      this.finishedAt = this.now()
    }
  }

  /**
   * 当前运行态快照。
   *
   * 前端轮询 GET 时读这个，不要自己猜「是不是还在跑」——组件会被卸载，
   * 状态必须活在服务端。
   * @returns 运行态。
   */
  status(): EvolutionRunStatus {
    const startedAt = this.startedAt
    const now = this.now()
    return {
      running: this.running,
      ...startedAt === undefined ? {} : { startedAt },
      // 跑着就报已耗时，跑完就报总耗时（都基于 startedAt，语义一致）。
      elapsedMs: startedAt === undefined ? 0 : Math.max(0, (this.running ? now : (this.finishedAt ?? now)) - startedAt),
      ...this.lastError === undefined ? {} : { lastError: this.lastError },
      ...this.lastSkip === undefined ? {} : { lastSkip: this.lastSkip },
    }
  }

  private async execute(sessionId?: string): Promise<EvolutionRunResult> {
    const maxSessions = this.deps.maxSessions ?? DEFAULT_MAX_SESSIONS
    const maxMessages = this.deps.maxMessagesPerSession ?? DEFAULT_MAX_MESSAGES
    const minUserMessages = this.deps.minUserMessages ?? MIN_USER_MESSAGES

    // ---- 候选池 ----
    let candidates: Array<{ id: string; userMessages?: number; cwd?: string }>
    try {
      if (sessionId !== undefined && sessionId !== '') {
        candidates = [{ id: sessionId }]
      } else {
        // 宿主 sessionQuery 在索引刚建好、或并发访问时可能短暂返回空/抛错。
        // 这里做一次短重试：连续两次都拿不到才算真的没有会话，避免把瞬时
        // 故障记录成 sessions=0（那正是历史里那几条 0 记录的成因）。
        const listWithRetry = async (): Promise<Array<{ id: string; userMessages?: number; cwd?: string }>> => {
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              const listed = await this.deps.reader.listSessions()
              const mapped = listed.map((item) => typeof item === 'string' ? { id: item } : item)
              if (mapped.length > 0) return mapped
            } catch (error) {
              // 第一次失败先等一会儿再试；第二次失败才把错误抛出去。
              if (attempt === 1) throw error
            }
            if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 250))
          }
          return []
        }
        candidates = await listWithRetry()
        // 记住每个会话的工作区，供业务优先排序使用。
        for (const item of candidates) {
          if (typeof item !== 'string' && item.cwd !== undefined) this.cwdOf.set(item.id, item.cwd)
        }
      }
    } catch (error) {
      // 不能把「读会话失败」静默成 sessions=0：那会让用户以为「没有会话」，
      // 而真相是宿主服务调用出错。错误必须带上，前端顶部能看到。
      return {
        markdown: '',
        proposals: [],
        sessions: 0,
        messages: 0,
        error: '读取会话列表失败：' + describe(error) + '（这是宿主 sessionQuery 调用异常，不是没有会话）',
      }
    }
    if (candidates.length === 0) {
      // 同样要说清「是查询返回了空列表」而不是含糊的「没有会话」。
      return {
        markdown: '',
        proposals: [],
        sessions: 0,
        messages: 0,
        error: '会话列表为空：宿主 sessionQuery 返回了 0 个会话（可能是索引尚未就绪，稍后重试）',
      }
    }

    // ---- 取样：按用户消息数降序，过滤掉短会话，取前 N 个 ----
    //
    // 为什么不能按 mtime：mnemon 子代理会话（1~3 条消息）刷新最频繁，按时间排序
    // 会把 12 个名额全部占满，真正有 300+ 条消息的主会话反而进不来 —— 之前
    // 「读到 6 个会话、24 条消息」就是这么来的。
    //
    // 已知 userMessages 的直接排序；未知的要先读一次统计（读过的缓存复用，
    // 不重复 IO）。
    const cache = new Map<string, ReviewMessage[]>()
    const readCached = async (id: string): Promise<ReviewMessage[]> => {
      const hit = cache.get(id)
      if (hit !== undefined) return hit
      const messages = await this.deps.reader.readMessages(id).catch(() => [])
      cache.set(id, messages)
      return messages
    }

    // 显式指定了会话（sessionId）时不做阈值过滤：用户明确要看这一个，
    // 哪怕它很短也照分析 —— 阈值是为了筛掉自动取样时的噪音，不该挡住手动指定。
    const explicit = sessionId !== undefined && sessionId !== ''
    const scored: Array<{ id: string; userMessages: number; business: boolean }> = []
    for (const candidate of candidates) {
      const userMessages = candidate.userMessages ?? (await readCached(candidate.id)).filter((m) => m.role === 'user').length
      if (!explicit && userMessages < minUserMessages) continue
      scored.push({ id: candidate.id, userMessages, business: this.isBusinessSession(candidate.id) })
    }
    // 排序：先按业务工作区优先，再按用户消息数降序。
    //
    // 为什么业务优先：sports-coach 这类业务会话承载具体业务规则（游泳馆排课、
    // 会员卡、教练分配），是「细分专项」技能的原料；通用开发会话再多也不产出
    // 业务专项提案。只做「同量级优先」不够——通用会话动辄 100+ 条，会把只有
    // 十几条的业务会话全部挤出 12 个名额。
    scored.sort((a, b) => {
      if (a.business !== b.business) return a.business ? -1 : 1
      return b.userMessages - a.userMessages
    })
    const picked = scored.slice(0, maxSessions)

    if (picked.length === 0) {
      // 明确说明「全部会话都被短会话过滤掉了」，而不是含糊的「没有可读消息」。
      return {
        markdown: '',
        proposals: [],
        sessions: 0,
        messages: 0,
        skipped: `no session has >= ${minUserMessages} user messages (checked ${candidates.length})`,
      }
    }

    const sessions: Array<{ id: string; title?: string; messages: ReviewMessage[] }> = []
    let totalMessages = 0
    for (const item of picked) {
      const messages = (await readCached(item.id)).slice(-maxMessages)
      if (messages.length === 0) continue
      const title = await this.deps.reader.readTitle?.(item.id).catch(() => undefined)
      sessions.push({ id: item.id, ...title === undefined ? {} : { title }, messages })
      totalMessages += messages.length
    }
    if (sessions.length === 0) return { markdown: '', proposals: [], sessions: 0, messages: 0, skipped: 'no readable messages' }

    const listed = await this.deps.listSkills().catch(() => [])
    const skills: Array<{ name: string; description: string; body?: string }> = []
    for (const skill of listed.slice(0, 60)) {
      const body = await this.deps.readSkillBody?.(skill.name).catch(() => undefined)
      skills.push({ name: skill.name, description: skill.description, ...body === undefined ? {} : { body } })
    }

    const rejections = await this.deps.listRejections?.().catch(() => []) ?? []
    const timeoutMs = this.deps.timeoutMs ?? EVOLUTION_TIMEOUT_MS
    const controller = new AbortController()
    // 超时不再静默中止：到点先 abort，再把「超时」作为明确错误返回，
    // 前端顶部会看到「分析超时（N 秒）」而不是一个空结果。
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error('evolution timed out'))
    }, timeoutMs)
    let text: string
    try {
      text = await this.deps.model.complete(
        EVOLUTION_SYSTEM_PROMPT,
        renderEvolutionInput(skills, sessions, rejections),
        controller.signal,
      )
    } catch (error) {
      const reason = timedOut
        ? `分析超时（已超过 ${Math.round(timeoutMs / 1000)} 秒）：已读取 ${String(sessions.length)} 个会话 / ${String(totalMessages)} 条消息，但模型未在时限内返回`
        : 'model failed: ' + describe(error)
      return { markdown: '', proposals: [], sessions: sessions.length, messages: totalMessages, error: reason }
    } finally {
      clearTimeout(timer)
    }
    // 模型返回空但没抛错：也算失败，否则界面只看到「暂无提案」而不知道是空的。
    if (text.trim() === '') {
      return { markdown: '', proposals: [], sessions: sessions.length, messages: totalMessages, error: '模型返回空内容（未产出任何文本）' }
    }

    // 输出噪声过滤日志：这一行能直接看出「读了多少、丢了多少、为什么丢」。
    this.deps.reader.flushNoiseStats?.()

    const markdown = text.trim()
    const sources = {
      usage: await this.deps.listUsage?.().catch(() => []) ?? [],
      trash: await this.deps.listTrash?.().catch(() => []) ?? [],
      rejections: await this.deps.listRejections?.().catch(() => []) ?? [],
    }
    // 走**单一解析管线**：完整分析与离线重新解析共用同一入口，
    // 保证两条路径的字段校验、命名规范化、草稿强制、统计评估、
    // 驳回去重、内容去重完全一致。
    const pipeline = runPipeline(markdown, sources, this.now())

    // ---- 全量技能主动扫描 ----
    //
    // 与轨迹分析互补：轨迹看「用户用出什么问题」，扫描看「技能本身写得怎样」。
    // 扫描产出的优化提案同样走价值评分与去重，最后与轨迹结果合并排序。
    const scanned = await this.scanAllSkills(sources.trash ?? [], sources.usage ?? [])
    let proposals = pipeline.proposals
    if (scanned.length > 0) {
      const scannedPipeline = runPipeline('', { ...sources }, this.now(), scanned)
      proposals = mergeProposals(proposals, scannedPipeline.proposals)
      this.deps.log?.('[dsh-skill-hub] evolution scan produced ' + String(scannedPipeline.proposals.length) + ' optimize proposal(s) from '
        + String(scanned.length) + ' candidate skill(s)')
    }

    // 回填归属目录：优化/回收提案指向已存在的技能，能查到真实来源。
    // 新建/细分专项的技能还没落地，留空由前端显示「待落地」。
    if (this.deps.readSkillSource !== undefined) {
      for (const proposal of proposals) {
        if (proposal.kind === 'new-skill') continue
        const source = await this.deps.readSkillSource(proposal.skillName).catch(() => undefined)
        if (source !== undefined && source !== '') proposal.skillSource = source
      }
    }

    // 回填落地目标：细分专项属于具体业务项目，必须写进那个工作区。
    //
    // 不做这一步的话，所有提案都落到 `~/.dsh/skills`，而工作区页只扫
    // `<workspace>/.dsh/skills` —— 技能确实写成功了，但在工作区列表里
    // 永远看不到，用户会以为「落地没生效」。
    const businessWorkspace = this.businessWorkspace()
    for (const proposal of proposals) {
      if (proposal.kind !== 'new-skill') continue
      if (proposal.recommendation === 'niche' && businessWorkspace !== undefined) {
        proposal.targetRoot = 'project'
        proposal.targetWorkspace = businessWorkspace
      } else {
        proposal.targetRoot = 'user-dsh'
      }
    }
    if (pipeline.droppedRejected.length > 0) {
      this.deps.log?.('[dsh-skill-hub] evolution dedup dropped ' + String(pipeline.droppedRejected.length) + ' proposal(s): '
        + pipeline.droppedRejected.join(', '))
    }
    if (pipeline.droppedInvalid.length > 0) {
      this.deps.log?.('[dsh-skill-hub] evolution field validation dropped ' + String(pipeline.droppedInvalid.length) + ': '
        + pipeline.droppedInvalid.join(', '))
    }
    return { markdown, proposals, sessions: sessions.length, messages: totalMessages }
  }

  /**
   * 从本次采样到的会话里找出「业务工作区」路径。
   *
   * 判定用 BUSINESS_WORKSPACE_HINTS（sports-coach 等）。命中多个时取出现
   * 次数最多的那个 —— 细分专项应该落到它真正所属的项目里。
   * @returns 工作区路径；没有业务会话时返回 undefined。
   */
  private businessWorkspace(): string | undefined {
    const counts = new Map<string, number>()
    for (const cwd of this.cwdOf.values()) {
      const lower = cwd.toLowerCase()
      if (!BUSINESS_WORKSPACE_HINTS.some((hint) => lower.includes(hint.toLowerCase()))) continue
      counts.set(cwd, (counts.get(cwd) ?? 0) + 1)
    }
    let best: string | undefined
    let bestCount = 0
    for (const [cwd, count] of counts) {
      if (count > bestCount) { best = cwd; bestCount = count }
    }
    return best
  }

  /**
   * 扫描全部已安装技能，产出主动扫描优化提案。
   * @param trash - 回收站记录（跳过已下线的）。
   * @returns 扫描出的候选（已按维度数降序，上限 MAX_SCAN_PROPOSALS）。
   */
  private async scanAllSkills(
    trash: ReadonlyArray<{ name: string }>,
    usage: ReadonlyArray<{ name: string; total: number; week: number }>,
  ): Promise<EvolutionProposal[]> {
    const listed = await this.deps.listSkills().catch(() => [])
    const usageByName = new Map(usage.map((row) => [row.name, row]))
    const scannable: ScannableSkill[] = []
    const idle: ScannableSkill[] = []
    for (const skill of listed) {
      const body = await this.deps.readSkillBody?.(skill.name).catch(() => undefined)
      if (body === undefined || body.trim() === '') continue
      const item: ScannableSkill = { name: skill.name, description: skill.description, body }
      // 闲置技能（历史 0 调用且近 7 天 0 调用）走**回收建议**分支。
      //
      // 逻辑冲突的根因就在这里：以前扫描只看质量、不看用量，于是给一个
      // 从没被调用过的技能既出优化源码、又标注「建议回收」，自相矛盾。
      // 对闲置技能来说优化源码没有意义 —— 没人用它，改好了也不会被用。
      const stat = usageByName.get(skill.name)
      const total = stat?.total ?? 0
      const week = stat?.week ?? 0
      if (total === 0 && week === 0) idle.push(item)
      else scannable.push(item)
    }

    const findings = scanAll(scannable, {
      trashed: new Set(trash.map((row) => row.name)),
      now: this.now(),
      limit: MAX_SCAN_PROPOSALS,
    })
    const optimize = findings.map((finding) => toOptimizeProposal(finding, this.now()))

    // 闲置技能：转成「建议移入回收站」提案（不带源码、不占草稿）。
    const trashedNames = new Set(trash.map((row) => row.name))
    const reclaim = idle
      .filter((skill) => !trashedNames.has(skill.name))
      .slice(0, MAX_SCAN_PROPOSALS)
      .map((skill) => toReclaimProposal(skill, this.now()))

    return [...optimize, ...reclaim]
  }
}

/**
 * 合并轨迹提案与扫描提案，按价值分降序。
 *
 * 同一技能的优化提案只留价值分更高的一条 —— 两类发现互补但不应重复推送。
 * @param trajectory - 轨迹分析产出的提案。
 * @param scanned - 主动扫描产出的提案。
 * @returns 合并后的提案（降序）。
 */
function mergeProposals(
  trajectory: readonly EvolutionProposal[],
  scanned: readonly EvolutionProposal[],
): EvolutionProposal[] {
  const merged = [...trajectory]
  const optimizedSkills = new Set(trajectory.filter((item) => item.kind === 'optimize').map((item) => item.skillName))
  for (const proposal of scanned) {
    // 轨迹已经发现这个技能的问题：不再重复推扫描结果。
    if (optimizedSkills.has(proposal.skillName)) continue
    merged.push(proposal)
  }
  merged.sort((a, b) => (b.valueScore ?? 0) - (a.valueScore ?? 0))
  return merged
}

/** 把异常变成一句可读的话（不拿 stack，避免泄露路径）。 */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
