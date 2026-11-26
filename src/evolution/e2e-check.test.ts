/** 端到端：用真实的轨迹读取逻辑 + 假模型，验证引擎能跑出提案。 */
import { describe, expect, it } from 'vitest'
import { EvolutionEngine } from './engine.ts'
import { messagesFromSurface } from './wiring.ts'

const surface = [
  { type: 'user/message', data: { content: [{ type: 'text', text: '帮我整理发布说明' }] } },
  { type: 'tool/call', data: { callId: 'c1', name: 'bash' } },
  { type: 'tool/result', data: { callId: 'c1', content: [{ type: 'text', text: 'boom' }], error: 'exit 1' } },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好的' }] } } },
]

describe('evolution end-to-end (fake model)', () => {
  it('reads a trajectory and produces parsed proposals', async () => {
    const messages = messagesFromSurface(surface)
    // 失败的工具结果必须被标记，否则反思看不到「报错」这类缺陷。
    expect(messages.find((m) => m.role === 'tool')?.failed).toBe(true)
    expect(messages.find((m) => m.role === 'tool')?.tool).toBe('bash')
    expect(messages.some((m) => m.role === 'user')).toBe(true)

    const engine = new EvolutionEngine({
      reader: {
        listSessions: async () => [{ id: 's1', userMessages: 3 }],
        readMessages: async () => messages,
        readTitle: async () => '整理发布说明',
      },
      model: {
        complete: async () => [
          '# 技能进化提案汇总',
          '## 一、新建技能推荐清单',
          '序号｜优先级｜技能名称｜适用场景｜出现次数｜收益｜潜在风险｜建议',
          '1｜高｜release-notes｜发布说明整理｜4｜减少重复说明｜可能过时｜新建',
          '> 【候选技能草稿】',
          '名称：release-notes',
          // 草稿必须够「重」才能通过价值评分：业务规则 + ≥5 个步骤。
          '描述：发布说明整理流程固定，每次都要重复交代大量业务规范，跨多个页面通用',
          '触发条件：用户要求整理发布说明时',
          '执行步骤：',
          '1. 收集本次改动清单',
          '2. 按模块归类变更',
          '3. 生成面向用户的说明',
          '4. 核对版本号与日期',
          '5. 校验链接与截图',
          '6. 输出最终文档',
          '## 二、已有技能优化提案',
        ].join('\n'),
      },
      listSkills: async () => [{ name: 'github', description: 'GitHub 操作' }],
      listRejections: async () => [{ skillName: 'old-idea', reason: '太不稳定' }],
      enabled: () => true,
    })

    const result = await engine.run()
    expect(result.error).toBeUndefined()
    expect(result.sessions).toBe(1)
    expect(result.proposals).toHaveLength(1)
    expect(result.proposals[0]?.skillName).toBe('release-notes')
    // 新建提案的技能还没落地，0 调用是必然的 —— 不再因此降级或建议回收。
    expect(result.proposals[0]?.recommendation).toBe('create')
    expect(result.proposals[0]?.metrics?.reason).toContain('尚未落地')
    expect(result.markdown).toContain('技能进化提案汇总')
  })

  it('passes rejection history into the model input (constraint 4)', async () => {
    let captured = ''
    const engine = new EvolutionEngine({
      reader: { listSessions: async () => [{ id: 's1', userMessages: 3 }], readMessages: async () => [{ role: 'user', text: 'x' }, { role: 'user', text: 'y' }, { role: 'user', text: 'z' }, { role: 'assistant', text: 'ok' }] },
      model: { complete: async (_system, user) => { captured = user; return '暂无技能进化提案' } },
      listSkills: async () => [],
      listRejections: async () => [{ skillName: 'old-idea', reason: '太不稳定' }],
      enabled: () => true,
    })
    await engine.run()
    expect(captured).toContain('历史驳回记录')
    expect(captured).toContain('太不稳定')
  })

  it('reports skipped when disabled instead of silently doing nothing', async () => {
    const engine = new EvolutionEngine({
      reader: { listSessions: async () => [], readMessages: async () => [] },
      model: { complete: async () => '' },
      listSkills: async () => [],
      enabled: () => false,
    })
    expect((await engine.run()).skipped).toBeDefined()
  })
})