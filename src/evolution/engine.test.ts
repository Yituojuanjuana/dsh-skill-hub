/** 提案解析：固定格式的 Markdown 能否抽出结构化提案。 */
import { describe, expect, it } from 'vitest'
import { NO_PROPOSAL_TEXT, parseProposals, renderEvolutionInput, EVOLUTION_SYSTEM_PROMPT } from './engine.ts'

describe('EVOLUTION_SYSTEM_PROMPT', () => {
  it('carries the fixed output format and all five hard constraints', () => {
    expect(EVOLUTION_SYSTEM_PROMPT).toContain('# 技能进化提案汇总')
    expect(EVOLUTION_SYSTEM_PROMPT).toContain('## 一、新建技能推荐清单')
    expect(EVOLUTION_SYSTEM_PROMPT).toContain('## 二、已有技能优化提案')
    // 五条强制约束，逐条锁住 —— 它们是产品承诺，任何改动都不能悄悄丢。
    expect(EVOLUTION_SYSTEM_PROMPT).toContain('绝不自动读写、修改本地任何技能文件')
    expect(EVOLUTION_SYSTEM_PROMPT).toContain(NO_PROPOSAL_TEXT)
    expect(EVOLUTION_SYSTEM_PROMPT).toContain('草稿技能必须写清楚触发条件')
    expect(EVOLUTION_SYSTEM_PROMPT).toContain('当用户驳回提案时，记住驳回理由')
    expect(EVOLUTION_SYSTEM_PROMPT).toContain('不要输出多余闲聊')
  })

  it('carries the judgement rules for both duties', () => {
    expect(EVOLUTION_SYSTEM_PROMPT).toContain('同类任务出现 ≥3 次')
    expect(EVOLUTION_SYSTEM_PROMPT).toContain('只出现一次的临时需求')
    expect(EVOLUTION_SYSTEM_PROMPT).toContain('触发条件不准')
    expect(EVOLUTION_SYSTEM_PROMPT).toContain('至少3条正向用例 + 1条边界异常case')
  })
})

describe('parseProposals', () => {
  it('returns nothing for the fixed no-proposal answer', () => {
    expect(parseProposals(NO_PROPOSAL_TEXT)).toEqual([])
    expect(parseProposals('')).toEqual([])
  })

  it('parses a new-skill row with its draft', () => {
    const md = [
      '# 技能进化提案汇总',
      '## 一、新建技能推荐清单',
      '序号｜优先级｜技能名称｜适用场景｜出现次数｜收益｜潜在风险｜建议',
      '1｜高｜release-notes｜发布说明整理｜5｜减少重复说明｜可能过时｜新建',
      '> 【候选技能草稿】',
      '名称：release-notes',
      '描述：整理发布说明',
      '触发条件：用户要求整理发布说明',
      '',
      '## 二、已有技能优化提案',
    ].join('\n')
    const proposals = parseProposals(md, 1000)
    expect(proposals).toHaveLength(1)
    expect(proposals[0]?.kind).toBe('new-skill')
    expect(proposals[0]?.skillName).toBe('release-notes')
    expect(proposals[0]?.priority).toBe('high')
    expect(proposals[0]?.occurrences).toBe(5)
    expect(proposals[0]?.recommendation).toBe('create')
    expect(proposals[0]?.draft).toContain('触发条件')
  })

  it('keeps observe rows without a draft', () => {
    const md = [
      '## 一、新建技能推荐清单',
      '1｜低｜maybe-skill｜偶发场景｜2｜一般｜不确定｜继续观察',
      '## 二、已有技能优化提案',
    ].join('\n')
    const proposals = parseProposals(md, 1)
    expect(proposals[0]?.recommendation).toBe('observe')
    expect(proposals[0]?.draft).toBeUndefined()
  })

  it('parses an optimization block', () => {
    const md = [
      '## 一、新建技能推荐清单',
      '## 二、已有技能优化提案',
      '变更类型：修改',
      '目标技能：github',
      '痛点总结：缺少异常分支',
      '新版技能源码：---\nname: github\n---\n正文',
      '测试用例：正向 3 条 + 异常 1 条',
      '风险评估：低',
      '收益对比：减少误调用',
    ].join('\n')
    const proposals = parseProposals(md, 2)
    expect(proposals).toHaveLength(1)
    expect(proposals[0]?.kind).toBe('optimize')
    expect(proposals[0]?.changeType).toBe('modify')
    expect(proposals[0]?.skillName).toBe('github')
    expect(proposals[0]?.painPoints).toContain('缺少异常分支')
  })

  it('maps merge and archive change types', () => {
    // 优化提案必须带新版源码，否则会被丢弃（新规则）。
    const merge = parseProposals('## 二、已有技能优化提案\n变更类型：合并\n目标技能：a\n新版技能源码：---\nname: a\n---\n正文\n', 3)
    expect(merge[0]?.changeType).toBe('merge')
    const archive = parseProposals('## 二、已有技能优化提案\n变更类型：下线归档\n目标技能：b\n新版技能源码：---\nname: b\n---\n正文\n', 4)
    expect(archive[0]?.changeType).toBe('archive')
  })
})

describe('renderEvolutionInput', () => {
  it('includes the existing skill list and the trajectory', () => {
    const text = renderEvolutionInput(
      [{ name: 'github', description: 'GitHub 操作' }],
      [{ id: 'sess-1', title: '整理发布说明', messages: [{ role: 'user', text: '帮我整理发布说明' }] }],
    )
    expect(text).toContain('## 现有技能')
    expect(text).toContain('github: GitHub 操作')
    expect(text).toContain('## 历史轨迹')
    expect(text).toContain('整理发布说明')
    expect(text).toContain('帮我整理发布说明')
  })

  it('marks failed tool calls so the meta-agent can spot defects', () => {
    const text = renderEvolutionInput([], [
      { id: 's', messages: [{ role: 'tool', text: 'boom', tool: 'bash', failed: true }] },
    ])
    expect(text).toContain('工具 bash（失败）')
  })
})

describe('niche (细分专项) recommendations', () => {
  const nicheMarkdown = [
    '# 技能进化提案汇总',
    '## 一、新建技能推荐清单',
    '序号｜优先级｜技能名称｜适用场景｜出现次数｜收益｜潜在风险｜建议',
    '1｜低｜sports-coach-swim｜游泳馆排课业务｜2｜免去重复交代业务规则｜业务调整需同步｜细分专项',
    '> 【候选技能草稿】',
    '名称：sports-coach-swim',
    '描述：sports-coach 运动陪练平台的游泳馆业务子场景，依赖已有通用基础技能 frontend-skill',
    '触发条件：用户要求改 sports-coach 的游泳馆页面或字段时',
    '## 二、已有技能优化提案',
  ].join('\n')

  it('parses 细分专项 into the niche recommendation', () => {
    const proposals = parseProposals(nicheMarkdown, 10)
    expect(proposals).toHaveLength(1)
    expect(proposals[0]?.recommendation).toBe('niche')
    // 细分专项同样带草稿。
    expect(proposals[0]?.draft).toContain('依赖已有通用基础技能')
    expect(proposals[0]?.occurrences).toBe(2)
  })

  it('forces priority to medium for niche regardless of what the model wrote', () => {
    // 模型写「低」，规则要求「中」——必须按规则覆盖。
    const proposals = parseProposals(nicheMarkdown, 11)
    expect(proposals[0]?.priority).toBe('medium')
  })

  it('keeps plain 新建 separate from 细分专项', () => {
    // 新规则：create/niche 必须带草稿，否则被丢弃 —— 这里两条都补上草稿。
    const md = [
      '## 一、新建技能推荐清单',
      '1｜高｜plain-skill｜通用场景｜5｜收益｜风险｜新建',
      '2｜中｜niche-skill｜业务场景｜2｜收益｜风险｜细分专项',
      '### 【候选技能草稿 1】plain-skill',
      '**名称**：plain-skill',
      '### 【候选技能草稿 2】niche-skill',
      '**名称**：niche-skill',
      '## 二、已有技能优化提案',
    ].join('\n')
    const proposals = parseProposals(md, 12)
    expect(proposals.map((item) => item.recommendation)).toEqual(['create', 'niche'])
  })

  it('documents the >=2 threshold and dependency rule in the prompt', () => {
    expect(EVOLUTION_SYSTEM_PROMPT).toContain('细分专项')
    expect(EVOLUTION_SYSTEM_PROMPT).toContain('≥2 次')
    expect(EVOLUTION_SYSTEM_PROMPT).toContain('该技能是游泳馆业务专属')
    // 放宽条款：已有技能覆盖不再构成跳过理由。
    expect(EVOLUTION_SYSTEM_PROMPT).toContain('即使现有通用技能可以覆盖')
    expect(EVOLUTION_SYSTEM_PROMPT).toContain('不得以「已有技能覆盖」为由跳过')
    expect(EVOLUTION_SYSTEM_PROMPT).toContain('优先级固定为「中」')
    expect(EVOLUTION_SYSTEM_PROMPT).toContain('sports-coach')
  })
})
describe('subtask decomposition requirement', () => {
  it('requires decomposing each session into minimal business subtasks first', () => {
    expect(EVOLUTION_SYSTEM_PROMPT).toContain('第一步：逐会话拆解最小业务子任务')
    expect(EVOLUTION_SYSTEM_PROMPT).toContain('第二步：统计子任务出现次数并跨会话归并')
    expect(EVOLUTION_SYSTEM_PROMPT).toContain('第三步：执行细分专项判定')
    // 明确「优化后台管理页面」不算子任务，防止模型停在粗粒度。
    expect(EVOLUTION_SYSTEM_PROMPT).toContain('不是子任务')
    expect(EVOLUTION_SYSTEM_PROMPT).toContain('游泳馆排课表的课时字段调整')
  })

  it('names the sports-coach swim business flows explicitly', () => {
    for (const flow of ['排课', '教练分配', '学员档案', '会员卡', '预约抢单', '支付退款', '体验课成交率']) {
      expect(EVOLUTION_SYSTEM_PROMPT).toContain(flow)
    }
  })
})