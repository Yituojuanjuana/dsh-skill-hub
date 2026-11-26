/**
 * 技能命名规范化。
 *
 * 问题：模型会把**长句业务描述**直接当技能名，例如
 *   「抢单大厅/我的预约卡片对齐、窄屏」
 * 这个字符串既不能当目录名（含中文、斜杠、顿号），也不适合当卡片标题。
 *
 * 正确形态是两套名字：
 *   - 技能 ID（内部标识、目录名）：`sports-coach-card-align`，kebab-case 英文
 *   - 展示名（卡片标题）：`预约卡片自适应对齐`，精简中文名词短语
 *   - 原始长句：落到 `description` 字段，不占标题位
 *
 * @module evolution/naming
 */

/** kebab-case 技能 ID 的合法形态。 */
export const SKILL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 技能 ID 的最大长度（目录名不宜过长）。 */
export const MAX_SKILL_ID_LENGTH = 48

/** 中文展示名的最大长度。 */
export const MAX_DISPLAY_NAME_LENGTH = 18

/** 业务平台关键词 → ID 前缀。按命中顺序取第一个。 */
const PLATFORM_HINTS: ReadonlyArray<{ id: string; keys: readonly string[] }> = [
  { id: 'sports-coach', keys: ['sports-coach', 'sportscoach', '运动陪练', '游泳馆', '教练端', '抢单大厅'] },
  { id: 'taro-weapp', keys: ['taro', '微信小程序', '小程序', 'miniapp', 'weapp'] },
  { id: 'dsh-plugin', keys: ['dsh', '插件', 'skill-hub', '技能中枢', 'cordis'] },
  { id: 'llm-pipeline', keys: ['prompt', 'llm', '模型调用', '解析器', '进化'] },
]

/** 中文动作/对象词 → 英文 ID 片段。用于把中文标题翻成可读的 kebab-case。 */
const TERM_MAP: ReadonlyArray<{ keys: readonly string[]; slug: string }> = [
  { keys: ['卡片', 'card'], slug: 'card' },
  { keys: ['对齐', 'align'], slug: 'align' },
  { keys: ['窄屏', '响应', 'adaptive'], slug: 'responsive' },
  { keys: ['等高', '几何'], slug: 'geometry' },
  { keys: ['验证', '核验', 'verify'], slug: 'verify' },
  { keys: ['构建', '编译', 'build'], slug: 'build' },
  { keys: ['工作台', 'workbench'], slug: 'workbench' },
  { keys: ['学员', 'student'], slug: 'student' },
  { keys: ['档案', 'records'], slug: 'records' },
  { keys: ['字段', 'field'], slug: 'field' },
  { keys: ['入口', 'entry'], slug: 'entry' },
  { keys: ['订单', 'order'], slug: 'order' },
  { keys: ['列表', 'list'], slug: 'list' },
  { keys: ['统计', 'stats'], slug: 'stats' },
  { keys: ['解析', 'parse'], slug: 'parse' },
  { keys: ['调试', 'debug'], slug: 'debug' },
  { keys: ['截图', 'screenshot'], slug: 'screenshot' },
  { keys: ['预览', 'preview'], slug: 'preview' },
  { keys: ['文档', 'doc'], slug: 'doc' },
  { keys: ['审阅', 'review'], slug: 'review' },
  { keys: ['清理', 'clean'], slug: 'clean' },
  { keys: ['扫描', 'scan'], slug: 'scan' },
  { keys: ['插件', 'plugin'], slug: 'plugin' },
  { keys: ['侧边栏', 'sidebar'], slug: 'sidebar' },
  { keys: ['信息层级', 'hierarchy'], slug: 'hierarchy' },
  { keys: ['改版', '重设计', 'redesign'], slug: 'redesign' },
  { keys: ['维护', 'maintain'], slug: 'maintain' },
  { keys: ['闭环', 'pipeline'], slug: 'pipeline' },
]

/** 已经在标题里出现的英文片段直接保留（如 miniapp、build）。 */
const KEEP_ASCII = /[a-z][a-z0-9-]{1,}/g

/**
 * 从原始标题里提取业务平台前缀。
 * @param text - 原始标题/场景描述。
 * @returns 平台 ID 前缀，未命中时返回空串。
 */
export function platformPrefix(text: string): string {
  const lower = text.toLowerCase()
  for (const hint of PLATFORM_HINTS) {
    if (hint.keys.some((key) => lower.includes(key.toLowerCase()))) return hint.id
  }
  return ''
}

/**
 * 生成规范的技能 ID（kebab-case）。
 *
 * 策略：平台前缀 + 英文词 + 中文术语映射，去重后截断。
 * 全程只产出 `[a-z0-9-]`，保证可以直接当目录名。
 * @param raw - 原始标题（可能是中文长句）。
 * @param fallbackSeed - 无可用词时的兜底种子（如序号）。
 * @returns 合法的 kebab-case ID。
 */
export function toSkillId(raw: string, fallbackSeed = ''): string {
  const text = String(raw ?? '')
  const parts: string[] = []

  const prefix = platformPrefix(text)
  if (prefix !== '') parts.push(prefix)

  // 保留原文里的英文词（miniapp / build / verify 等）。
  for (const word of text.toLowerCase().match(KEEP_ASCII) ?? []) {
    const cleaned = word.replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '')
    if (cleaned.length >= 2 && !parts.includes(cleaned)) parts.push(cleaned)
  }

  // 中文术语映射。
  for (const term of TERM_MAP) {
    if (term.keys.some((key) => text.toLowerCase().includes(key.toLowerCase())) && !parts.includes(term.slug)) {
      parts.push(term.slug)
    }
  }

  // 兜底：一个可用词都没有时用种子，避免产出空 ID。
  if (parts.length === 0) {
    const seed = String(fallbackSeed ?? '').replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-|-$/g, '')
    parts.push(seed !== '' ? seed : 'auto-skill')
  }

  // 截断到上限，且不切断在半个词上。
  let id = parts.join('-')
  while (id.length > MAX_SKILL_ID_LENGTH) {
    parts.pop()
    if (parts.length === 0) { id = parts.join('-') || 'auto-skill'; break }
    id = parts.join('-')
  }
  // 最后一道保险：不合规就退回兜底 ID。
  return SKILL_ID_PATTERN.test(id) ? id : 'auto-skill'
}

/**
 * 生成精简的中文展示名。
 *
 * 规则：去掉括号说明、斜杠并列、顿号罗列，取最核心的名词短语。
 * 目标长度 ≤ 18 字，超出时截断并保留可读性。
 * @param raw - 原始标题。
 * @returns 精简中文名。
 */
export function toDisplayName(raw: string): string {
  let text = String(raw ?? '').trim()
  if (text === '') return '未命名技能'

  // 去掉英文 ID 形态的整段（`llm-pipeline-debug（模型调用链路调试）` → 括号里的中文）。
  const paren = /[（(]([^）)]+)[）)]/.exec(text)
  if (paren?.[1] !== undefined && /[\u4e00-\u9fff]/.test(paren[1])) {
    text = paren[1]
  }

  // 去掉英文单词（展示名走中文）。
  text = text.replace(/[a-z][a-z0-9-]*/gi, ' ')
  // 斜杠并列只保留第一段（「抢单大厅/我的预约」→「抢单大厅」）。
  text = text.split('/')[0] ?? text
  // 顿号罗列只保留前两项，避免长串。
  const parts = text.split(/[、,，]/).map((part) => part.trim()).filter((part) => part !== '')
  if (parts.length > 2) text = parts.slice(0, 2).join('、')
  else text = parts.join('、')

  text = text.replace(/\s+/g, '').replace(/^[：:·、]+|[：:·、]+$/g, '')
  // 纯符号（`——`、`---`）不是名字，按未命名处理。
  if (text === '' || /^[-—–_~·.、:：]+$/.test(text)) return '未命名技能'

  if (text.length > MAX_DISPLAY_NAME_LENGTH) {
    text = text.slice(0, MAX_DISPLAY_NAME_LENGTH)
  }
  return text
}

/**
 * 把原始长句整理成技能描述。
 *
 * 原始标题里的业务细节（并列页面、约束条件）不该丢，只是不该占标题位。
 * @param raw - 原始标题。
 * @param scenario - 表格里的「适用场景」列（可选，补充细节）。
 * @returns 描述文本。
 */
export function toDescription(raw: string, scenario?: string): string {
  const title = String(raw ?? '').trim()
  const extra = String(scenario ?? '').trim()
  if (extra === '' || extra === title) return title
  if (title === '') return extra
  return title + ' —— ' + extra
}

/** 一次命名规范化的结果。 */
export interface NormalizedName {
  /** 规范化的 kebab-case 技能 ID。 */
  id: string
  /** 精简中文展示名。 */
  displayName: string
  /** 完整业务描述。 */
  description: string
}

/**
 * 把任意标题规范化成「ID + 展示名 + 描述」。
 * @param raw - 原始标题。
 * @param scenario - 适用场景列。
 * @param fallbackSeed - 兜底种子。
 * @returns 三个字段。
 */
export function normalizeName(raw: string, scenario = '', fallbackSeed = ''): NormalizedName {
  const text = String(raw ?? '').trim()
  // 已经是合法 kebab-case ID（模型偶尔直接给出规范名）：ID 原样保留，
  // 只补一个中文展示名与描述。不做二次规范化，否则会出现
  // `sports-coach-sports-coach-card-align-card-align` 这种重复拼接。
  if (SKILL_ID_PATTERN.test(text) && text.length <= MAX_SKILL_ID_LENGTH) {
    return {
      id: text,
      displayName: toDisplayName(scenario !== '' ? scenario : text),
      description: toDescription(raw, scenario),
    }
  }
  return {
    id: toSkillId(raw, fallbackSeed),
    displayName: toDisplayName(raw),
    description: toDescription(raw, scenario),
  }
}
