/** 惰性代理：服务晚到时路由仍能用上真正的执行器。 */
import { describe, expect, it } from 'vitest'
import { lazyEvolution, unavailableEvolution, type EvolutionRouteDeps } from '../routes/evolution.ts'

const stub = (): EvolutionRouteDeps => ({
  read: async () => ({ markdown: 'm', ranAt: 5, proposals: [], runs: [], rejections: [] }),
  run: async () => ({ markdown: 'ok', proposals: [], sessions: 2, messages: 9 }),
  status: () => ({ running: false, elapsedMs: 0 }),
  reparse: async () => ({ ok: false, proposals: 0, elapsedMs: 0, hasMarkdown: false }),
  decide: async () => ({ found: true }),
  clear: async () => undefined,
})

describe('lazyEvolution', () => {
  it('falls back to unavailable while the real executor is not ready', async () => {
    const lazy = lazyEvolution(() => undefined)
    const result = await lazy.run()
    expect(result.skipped).toBeDefined()
    expect((await lazy.read()).markdown).toBe('')
  })

  it('picks up the executor once it is assigned later', async () => {
    let wiring: EvolutionRouteDeps | undefined
    const lazy = lazyEvolution(() => wiring)
    // 第一次调用时还没就绪 —— 这正是 makeRoutes 早于 ctx.inject 回调的场景。
    expect((await lazy.run()).skipped).toBeDefined()
    wiring = stub()
    const result = await lazy.run()
    expect(result.sessions).toBe(2)
    expect((await lazy.read()).markdown).toBe('m')
    expect((await lazy.decide('x', 'rejected', 'r')).found).toBe(true)
  })

  it('keeps the unavailable contract shape', async () => {
    const unavailable = unavailableEvolution()
    const read = await unavailable.read()
    expect(read.rejections).toEqual([])
    expect((await unavailable.decide('x', 'accepted')).found).toBe(false)
  })
})