/**
 * 会话读取计数：不能把「宿主服务瞬时失败」记录成 sessions=0。
 *
 * 历史里出现过连续几条 sessions=0 的记录，而同一台机器上明明有 143 个会话文件。
 * 根因是 listSessions 抛错/返回空时被静默当成「没有会话」。现在要求：
 * 1) 瞬时失败要重试一次；
 * 2) 两次都拿不到才算真没有，且错误信息必须可读。
 */
import { describe, expect, it } from 'vitest'
import { EvolutionEngine } from './engine.ts'
import type { ReviewMessage } from './review.ts'

const messages: ReviewMessage[] = [
  { role: 'user', text: '第一条' },
  { role: 'user', text: '第二条' },
  { role: 'user', text: '第三条' },
]

describe('session counting', () => {
  it('reports the real session count when the reader works', async () => {
    const engine = new EvolutionEngine({
      reader: {
        listSessions: async () => [
          { id: 'a', userMessages: 5, cwd: 'E:\\work\\sports-coach' },
          { id: 'b', userMessages: 4, cwd: 'E:\\work\\other' },
          { id: 'c', userMessages: 3 },
        ],
        readMessages: async () => messages,
      },
      model: { complete: async () => '暂无技能进化提案' },
      listSkills: async () => [],
      enabled: () => true,
    })
    const result = await engine.run()
    expect(result.sessions).toBe(3)
    expect(result.messages).toBe(9)
  })

  it('retries once when the first listSessions call throws', async () => {
    let calls = 0
    const engine = new EvolutionEngine({
      reader: {
        listSessions: async () => {
          calls += 1
          if (calls === 1) throw new Error('index not ready')
          return [{ id: 'a', userMessages: 5 }]
        },
        readMessages: async () => messages,
      },
      model: { complete: async () => '暂无技能进化提案' },
      listSkills: async () => [],
      enabled: () => true,
    })
    const result = await engine.run()
    // 重试成功 —— 不该把瞬时故障记成 0 个会话。
    expect(result.sessions).toBe(1)
    expect(calls).toBe(2)
    expect(result.error).toBeUndefined()
  })

  it('retries once when the first listSessions call returns empty', async () => {
    let calls = 0
    const engine = new EvolutionEngine({
      reader: {
        listSessions: async () => {
          calls += 1
          if (calls === 1) return []
          return [{ id: 'a', userMessages: 5 }]
        },
        readMessages: async () => messages,
      },
      model: { complete: async () => '暂无技能进化提案' },
      listSkills: async () => [],
      enabled: () => true,
    })
    const result = await engine.run()
    expect(result.sessions).toBe(1)
    expect(calls).toBe(2)
  })

  it('reports a readable error when both attempts fail', async () => {
    const engine = new EvolutionEngine({
      reader: {
        listSessions: async () => { throw new Error('sessionQuery unavailable') },
        readMessages: async () => messages,
      },
      model: { complete: async () => '暂无技能进化提案' },
      listSkills: async () => [],
      enabled: () => true,
    })
    const result = await engine.run()
    expect(result.sessions).toBe(0)
    // 错误必须说清是「读会话列表失败」，不能含糊成「没有会话」。
    expect(result.error).toContain('读取会话列表失败')
    expect(result.error).toContain('sessionQuery unavailable')
  })

  it('says the list was empty rather than pretending there are no sessions', async () => {
    const engine = new EvolutionEngine({
      reader: {
        listSessions: async () => [],
        readMessages: async () => messages,
      },
      model: { complete: async () => '暂无技能进化提案' },
      listSkills: async () => [],
      enabled: () => true,
    })
    const result = await engine.run()
    expect(result.sessions).toBe(0)
    expect(result.error).toContain('会话列表为空')
  })
})