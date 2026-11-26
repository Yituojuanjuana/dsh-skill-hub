/**
 * 后台任务语义：POST 立即返回、并发保护、运行态可读。
 *
 * 改造前 POST /run 会 `await` 整个跑批（1~4 分钟），浏览器一刷新请求就断，
 * 前端显示「没反应」，而服务端 running 还卡着，再点永远回 alreadyRunning。
 */
import { describe, expect, it } from 'vitest'
import { EvolutionEngine } from './engine.ts'
import type { ReviewMessage } from './review.ts'

/** 造一个可控的模型：resolve 由测试手动触发。 */
function deferredModel(): {
  complete: (system: string, user: string, signal: AbortSignal) => Promise<string>
  resolve: (text: string) => void
  reject: (error: Error) => void
  started: () => boolean
} {
  let resolveFn: ((text: string) => void) | undefined
  let rejectFn: ((error: Error) => void) | undefined
  let started = false
  const promise = new Promise<string>((resolve, reject) => {
    resolveFn = resolve
    rejectFn = reject
  })
  return {
    complete: () => { started = true; return promise },
    resolve: (text) => { resolveFn?.(text) },
    reject: (error) => { rejectFn?.(error) },
    started: () => started,
  }
}

const messages: ReviewMessage[] = [
  { role: 'user', text: '帮我改游泳馆排课' },
  { role: 'user', text: '教练分配也要改' },
  { role: 'user', text: '会员卡页面加个字段' },
]

function engineWith(model: ReturnType<typeof deferredModel>): EvolutionEngine {
  return new EvolutionEngine({
    reader: {
      listSessions: async () => [{ id: 's1', userMessages: 3, cwd: 'E:\\work\\sports-coach' }],
      readMessages: async () => messages,
      readTitle: async () => '游泳馆业务',
    },
    model: { complete: model.complete },
    listSkills: async () => [],
    enabled: () => true,
  })
}

describe('background run status', () => {
  it('reports running=true and elapsedMs while the model is in flight', async () => {
    const model = deferredModel()
    const engine = engineWith(model)

    // 不 await：模拟后台 fire-and-forget。
    const pending = engine.run()
    // 等模型真的被调用（说明已进入 running 状态）。
    for (let i = 0; i < 50 && !model.started(); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }

    const status = engine.status()
    expect(status.running).toBe(true)
    expect(status.startedAt).toBeGreaterThan(0)
    expect(status.elapsedMs).toBeGreaterThanOrEqual(0)

    model.resolve('暂无技能进化提案')
    await pending

    // 跑完后 running 归位，elapsedMs 保留总耗时。
    const after = engine.status()
    expect(after.running).toBe(false)
    expect(after.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('rejects a second run with a skip reason instead of queueing', async () => {
    const model = deferredModel()
    const engine = engineWith(model)
    const first = engine.run()
    for (let i = 0; i < 50 && !model.started(); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }

    // 第二次调用必须立刻返回「已有分析在跑」，不能挂住。
    const second = await engine.run()
    expect(second.skipped).toBe('another run is in progress')
    expect(second.sessions).toBe(0)

    model.resolve('暂无技能进化提案')
    await first
  })

  it('exposes the failure reason through status()', async () => {
    const model = deferredModel()
    const engine = engineWith(model)
    const pending = engine.run()
    for (let i = 0; i < 50 && !model.started(); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    model.reject(new Error('rate limited by provider'))
    await pending

    const status = engine.status()
    expect(status.running).toBe(false)
    // 失败原文必须能从 status 读到 —— 前端面板顶部显示它，不能只写日志。
    expect(status.lastError).toContain('rate limited by provider')
  })

  it('records a skip reason when nothing qualifies', async () => {
    const engine = new EvolutionEngine({
      reader: {
        listSessions: async () => [{ id: 'tiny', userMessages: 1, cwd: 'E:\\x' }],
        readMessages: async () => [{ role: 'user', text: 'hi' }],
      },
      model: { complete: async () => '暂无技能进化提案' },
      listSkills: async () => [],
      enabled: () => true,
    })
    await engine.run()
    expect(engine.status().lastSkip).toContain('user messages')
  })

  it('reports an explicit timeout error instead of silently aborting', async () => {
    const engine = new EvolutionEngine({
      reader: {
        listSessions: async () => [{ id: 's1', userMessages: 3 }],
        readMessages: async () => messages,
      },
      // 模型尊重 abort 信号（真实适配器也这样），超时后应抛错。
      model: {
        complete: (_system, _user, signal) => new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
        }),
      },
      listSkills: async () => [],
      enabled: () => true,
      timeoutMs: 30,
    })
    const result = await engine.run()
    expect(result.error).toContain('分析超时')
    expect(engine.status().lastError).toContain('分析超时')
  })

  it('treats an empty model reply as a failure, not as no-proposal', async () => {
    const engine = new EvolutionEngine({
      reader: {
        listSessions: async () => [{ id: 's1', userMessages: 3 }],
        readMessages: async () => messages,
      },
      model: { complete: async () => '   ' },
      listSkills: async () => [],
      enabled: () => true,
    })
    const result = await engine.run()
    expect(result.error).toContain('模型返回空内容')
  })
})
