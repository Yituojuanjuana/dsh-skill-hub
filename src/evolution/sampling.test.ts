/**
 * 取样策略：按用户消息数降序、过滤短会话、上限 12。
 *
 * 之前按 mtime 排序时，mnemon 微会话（1~3 条消息）占满名额，真正有价值的长
 * 会话进不来 —— 表现为「读到 6 个会话、24 条消息」。
 */
import { describe, expect, it } from 'vitest'
import { EvolutionEngine, MIN_USER_MESSAGES } from './engine.ts'

/** 造一个会话：n 条用户消息 + 1 条助手回复。 */
const conversation = (id: string, userCount: number) => ({
  id,
  messages: [
    ...Array.from({ length: userCount }, (_, index) => ({ role: 'user' as const, text: `${id} 的第 ${index + 1} 条` })),
    { role: 'assistant' as const, text: 'ok' },
  ],
})

/** 跑一次并记录模型收到的输入。 */
async function runWith(candidates: Array<{ id: string; userMessages?: number }>, maxSessions?: number): Promise<{
  input: string
  result: Awaited<ReturnType<EvolutionEngine['run']>>
}> {
  const store = new Map(candidates.map((item) => [item.id, conversation(item.id, item.userMessages ?? 0).messages]))
  let input = ''
  const engine = new EvolutionEngine({
    reader: {
      listSessions: async () => candidates,
      readMessages: async (id) => store.get(id) ?? [],
      readTitle: async (id) => id,
    },
    model: {
      complete: async (_system, user) => {
        input = user
        return '暂无技能进化提案'
      },
    },
    listSkills: async () => [],
    enabled: () => true,
    ...maxSessions === undefined ? {} : { maxSessions },
  })
  const result = await engine.run()
  return { input, result }
}

describe('session sampling', () => {
  it('orders candidates by user message count, not by list order', async () => {
    // 列表顺序故意把短会话排在前面（模拟 mtime 排序下的 mnemon 微会话）。
    const { input } = await runWith([
      { id: 'mnemon-1', userMessages: 1 },
      { id: 'mnemon-2', userMessages: 2 },
      { id: 'long-a', userMessages: 40 },
      { id: 'long-b', userMessages: 90 },
    ])
    // 长会话必须在，短会话必须被过滤。
    expect(input).toContain('long-b')
    expect(input).toContain('long-a')
    expect(input).not.toContain('mnemon-1')
    expect(input).not.toContain('mnemon-2')
  })

  it('drops sessions below the minimum user-message threshold', async () => {
    const { result, input } = await runWith([
      { id: 'tiny', userMessages: MIN_USER_MESSAGES - 1 },
      { id: 'ok', userMessages: MIN_USER_MESSAGES },
    ])
    expect(input).toContain('ok')
    expect(input).not.toContain('tiny')
    expect(result.sessions).toBe(1)
  })

  it('counts user messages itself when the hint is missing', async () => {
    // 不给 userMessages 提示，引擎必须自己读出来统计。
    const { input } = await runWith([
      { id: 'no-hint-long' },
      { id: 'no-hint-short' },
    ])
    // 两个都没提示 → 都是 0 条用户消息 → 全部被过滤，模型不该被调用。
    expect(input).toBe('')
  })

  it('caps the analysis at 12 sessions', async () => {
    const candidates = Array.from({ length: 20 }, (_, index) => ({ id: `s${index}`, userMessages: 100 - index }))
    const { result } = await runWith(candidates)
    expect(result.sessions).toBe(12)
  })

  it('honours a custom maxSessions', async () => {
    const candidates = Array.from({ length: 20 }, (_, index) => ({ id: `s${index}`, userMessages: 100 - index }))
    const { result } = await runWith(candidates, 3)
    expect(result.sessions).toBe(3)
  })

  it('explains that everything was filtered when no session qualifies', async () => {
    const { result } = await runWith([
      { id: 'a', userMessages: 1 },
      { id: 'b', userMessages: 2 },
    ])
    expect(result.sessions).toBe(0)
    expect(result.skipped).toContain('user messages')
  })

  it('keeps a single explicitly requested session even if it is short', async () => {
    const store = new Map([['only', conversation('only', 1).messages]])
    let input = ''
    const engine = new EvolutionEngine({
      reader: {
        listSessions: async () => [{ id: 'only', userMessages: 1 }],
        readMessages: async (id) => store.get(id) ?? [],
      },
      model: { complete: async (_s, user) => { input = user; return '暂无技能进化提案' } },
      listSkills: async () => [],
      enabled: () => true,
    })
    const result = await engine.run('only')
    expect(result.sessions).toBe(1)
    expect(input).toContain('only')
  })
})

describe('business workspace priority', () => {
  /** 造候选会话：带 cwd。 */
  const conv = (id: string, users: number) => ({
    id,
    messages: [
      ...Array.from({ length: users }, (_, i) => ({ role: 'user' as const, text: `${id} 第 ${i + 1} 条` })),
      { role: 'assistant' as const, text: 'ok' },
    ],
  })

  async function run(candidates: Array<{ id: string; userMessages: number; cwd: string }>): Promise<string> {
    const store = new Map(candidates.map((item) => [item.id, conv(item.id, item.userMessages).messages]))
    let input = ''
    const engine = new EvolutionEngine({
      reader: {
        listSessions: async () => candidates,
        readMessages: async (id) => store.get(id) ?? [],
        readTitle: async (id) => id,
      },
      model: { complete: async (_s, user) => { input = user; return '暂无技能进化提案' } },
      listSkills: async () => [],
      enabled: () => true,
    })
    await engine.run()
    return input
  }

  it('prefers sports-coach sessions over bigger generic ones', async () => {
    const input = await run([
      { id: 'generic-big', userMessages: 200, cwd: 'E:\\work\\default-workspace' },
      { id: 'sports-small', userMessages: 5, cwd: 'E:\\work\\sports-coach' },
    ])
    // 业务会话即使消息更少也必须入选。
    expect(input).toContain('sports-small')
  })

  it('also recognises sports-coach-miniapp', async () => {
    const input = await run([
      { id: 'generic-big', userMessages: 200, cwd: 'E:\\work\\default-workspace' },
      { id: 'miniapp-small', userMessages: 4, cwd: 'E:\\work\\sports-coach-miniapp' },
    ])
    expect(input).toContain('miniapp-small')
  })

  it('still orders by message count inside the same tier', async () => {
    const input = await run([
      { id: 'biz-small', userMessages: 4, cwd: 'E:\\work\\sports-coach' },
      { id: 'biz-big', userMessages: 40, cwd: 'E:\\work\\sports-coach' },
      { id: 'gen', userMessages: 300, cwd: 'E:\\work\\default-workspace' },
    ])
    // 同层内多的在前：biz-big 应出现在 biz-small 之前。
    expect(input.indexOf('biz-big')).toBeLessThan(input.indexOf('biz-small'))
  })

  it('keeps the 12-session cap even with many business sessions', async () => {
    const candidates = Array.from({ length: 30 }, (_, i) => ({
      id: `sports-${i}`,
      userMessages: 50 - i,
      cwd: 'E:\\work\\sports-coach',
    }))
    const store = new Map(candidates.map((item) => [item.id, conv(item.id, item.userMessages).messages]))
    const engine = new EvolutionEngine({
      reader: {
        listSessions: async () => candidates,
        readMessages: async (id) => store.get(id) ?? [],
      },
      model: { complete: async () => '暂无技能进化提案' },
      listSkills: async () => [],
      enabled: () => true,
    })
    const result = await engine.run()
    expect(result.sessions).toBe(12)
  })

  it('still enforces the >=3 message floor for business sessions', async () => {
    const input = await run([
      { id: 'biz-tiny', userMessages: 1, cwd: 'E:\\work\\sports-coach' },
      { id: 'gen-ok', userMessages: 10, cwd: 'E:\\work\\default-workspace' },
    ])
    expect(input).not.toContain('biz-tiny')
    expect(input).toContain('gen-ok')
  })
})