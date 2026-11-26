/**
 * 命名规范化 + 草稿强制。
 *
 * 两个真实问题：
 * 1. 模型把长句业务描述当技能名（「抢单大厅/我的预约卡片对齐、窄屏」），
 *    这种字符串不能当目录名，也不该当卡片标题；
 * 2. 草稿经常丢（模型没按模板写，或写在 `## 二、` 之后被切走），
 *    导致提案「没有附带草稿」无法落地。
 */
import { describe, expect, it } from 'vitest'
import { MAX_SKILL_ID_LENGTH, normalizeName, SKILL_ID_PATTERN, toDisplayName, toSkillId } from './naming.ts'
import { parseProposals } from './engine.ts'

describe('toSkillId', () => {
  it('turns a long Chinese sentence into a kebab-case id', () => {
    const id = toSkillId('抢单大厅/我的预约卡片对齐、窄屏')
    expect(id).toMatch(SKILL_ID_PATTERN)
    expect(id).toContain('sports-coach')
    expect(id).toContain('card')
    expect(id).toContain('align')
  })

  it('never emits Chinese characters', () => {
    for (const raw of ['学员卡片/详情页字段增删与入口迁移', '工作台', 'C 盘清理扫描与提权执行', '无头浏览器截图预览']) {
      const id = toSkillId(raw)
      expect(id, raw).toMatch(SKILL_ID_PATTERN)
      expect(id, raw).not.toMatch(/[\u4e00-\u9fff]/)
    }
  })

  it('keeps useful ascii words from the raw title', () => {
    expect(toSkillId('sports-coach-miniapp 改动验证闭环')).toContain('miniapp')
    expect(toSkillId('llm-pipeline-debug（模型调用链路调试）')).toContain('llm')
  })

  it('stays within the length budget', () => {
    const id = toSkillId('sports-coach 教练端抢单大厅我的预约学员档案工作台信息层级卡片对齐窄屏响应式构建验证闭环')
    expect(id.length).toBeLessThanOrEqual(MAX_SKILL_ID_LENGTH)
    expect(id).toMatch(SKILL_ID_PATTERN)
  })

  it('falls back to a seed when no usable term exists', () => {
    const id = toSkillId('——', '7')
    expect(id).toMatch(SKILL_ID_PATTERN)
    expect(id.length).toBeGreaterThan(0)
  })

  it('produces stable, distinct ids for distinct scenarios', () => {
    const a = toSkillId('抢单大厅卡片对齐')
    const b = toSkillId('学员档案字段维护')
    expect(a).not.toBe(b)
  })
})

describe('toDisplayName', () => {
  it('shortens a long action sentence to a noun phrase', () => {
    const name = toDisplayName('抢单大厅/我的预约卡片对齐、窄屏')
    expect(name.length).toBeLessThanOrEqual(18)
    // 不能还是原来那一整串。
    expect(name).not.toBe('抢单大厅/我的预约卡片对齐、窄屏')
    expect(name).toContain('抢单大厅')
  })

  it('prefers the Chinese part of a parenthesised title', () => {
    expect(toDisplayName('llm-pipeline-debug（模型调用链路调试）')).toBe('模型调用链路调试')
  })

  it('strips ascii ids from the display name', () => {
    expect(toDisplayName('sports-coach-miniapp 改动验证闭环')).not.toMatch(/[a-z]{3,}/i)
  })

  it('never returns an empty string', () => {
    expect(toDisplayName('')).toBe('未命名技能')
    expect(toDisplayName('——')).toBe('未命名技能')
  })

  it('keeps at most two comma-separated items', () => {
    const name = toDisplayName('甲、乙、丙、丁')
    expect(name.split('、').length).toBeLessThanOrEqual(2)
  })
})

describe('normalizeName', () => {
  it('returns id, display name and description together', () => {
    const named = normalizeName('抢单大厅/我的预约卡片对齐、窄屏', '抢单大厅与我的预约卡片几何统一')
    expect(named.id).toMatch(SKILL_ID_PATTERN)
    expect(named.displayName.length).toBeLessThanOrEqual(18)
    // 原始长句完整保留在描述里，没有丢信息。
    expect(named.description).toContain('抢单大厅/我的预约卡片对齐、窄屏')
    expect(named.description).toContain('几何统一')
  })
})

describe('parseProposals naming', () => {
  const md = (name: string): string => [
    '## 一、新建技能推荐清单',
    `| 1 | 中 | ${name} | 抢单大厅/我的预约卡片对齐、窄屏 | 4 | 收益 | 风险 | 【细分专项】 |`,
    `### 【候选技能草稿 1】${name}`,
    '**名称**：x',
    '**触发条件**：当用户要求时',
    '## 二、已有技能优化提案',
  ].join('\n')

  it('rewrites a long Chinese title into id + display name', () => {
    const proposals = parseProposals(md('抢单大厅/我的预约卡片对齐、窄屏'), 1)
    expect(proposals).toHaveLength(1)
    const first = proposals[0]!
    expect(first.skillName).toMatch(SKILL_ID_PATTERN)
    expect(first.displayName).toBeDefined()
    expect((first.displayName ?? '').length).toBeLessThanOrEqual(18)
    // 原始长句落到描述里。
    expect(first.scenario).toContain('抢单大厅/我的预约卡片对齐、窄屏')
  })

  it('keeps an already-valid kebab id untouched as the id', () => {
    const proposals = parseProposals(md('sports-coach-card-align'), 2)
    expect(proposals[0]?.skillName).toBe('sports-coach-card-align')
  })
})

describe('draft enforcement across both kinds', () => {
  it('drops a new-skill proposal with no draft', () => {
    const md = [
      '## 一、新建技能推荐清单',
      '| 1 | 中 | `no-draft-skill` | 场景 | 3 | 收益 | 风险 | 新建 |',
      '## 二、已有技能优化提案',
    ].join('\n')
    expect(parseProposals(md, 3)).toHaveLength(0)
  })

  it('drops an optimize proposal with no new source', () => {
    const md = [
      '## 一、新建技能推荐清单',
      '## 二、已有技能优化提案',
      '变更类型：修改',
      '目标技能：some-skill',
      '痛点总结：缺少异常分支',
      '测试用例：3 正向 + 1 异常',
    ].join('\n')
    // 没有「新版技能源码」= 无法落地 = 丢弃。
    expect(parseProposals(md, 4)).toHaveLength(0)
  })

  it('keeps an optimize proposal that carries new source, and mirrors it into draft', () => {
    const md = [
      '## 一、新建技能推荐清单',
      '## 二、已有技能优化提案',
      '变更类型：修改',
      '目标技能：some-skill',
      '痛点总结：缺少异常分支',
      '新版技能源码：---\nname: some-skill\n---\n正文',
      '测试用例：3 正向 + 1 异常',
      '风险评估：低',
      '收益对比：减少误调用',
    ].join('\n')
    const proposals = parseProposals(md, 5)
    expect(proposals).toHaveLength(1)
    expect(proposals[0]?.kind).toBe('optimize')
    expect(proposals[0]?.skillName).toBe('some-skill')
    // draft 与 newSource 一致，UI 展开能看到完整内容。
    expect((proposals[0]?.draft ?? '').length).toBeGreaterThan(0)
    expect(proposals[0]?.draft).toBe(proposals[0]?.newSource)
  })
})
