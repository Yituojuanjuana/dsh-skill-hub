/**
 * 模型调用的 signal 兼容性。
 *
 * 真实故障：宿主传进来的 signal 有时不是标准 AbortSignal（只有 `aborted`
 * 字段、没有 `throwIfAborted` 方法），代码里写 `signal.throwIfAborted()`
 * 就会抛「signal?.throwIfAborted is not a function」，整个进化分析静默失败。
 *
 * 这组测试锁住三种情况：标准 signal、残缺 signal、完全没有 signal。
 */
import { describe, expect, it } from 'vitest'
import { llmModel, type LlmLike } from './wiring.ts'

/** 造一个假的 llm 服务：记录收到的 signal，并吐出给定文本。 */
function fakeLlm(reply: string, options: { failWith?: Error } = {}): {
  llm: LlmLike
  received: { provider: string; model: string; signal?: unknown }
  options: { streamOptions?: Record<string, unknown> }
} {
  const received: { provider: string; model: string; signal?: unknown } = { provider: '', model: '' }
  const holder: { streamOptions?: Record<string, unknown> } = {}
  const llm: LlmLike = {
    async prepareCall(config, signal) {
      received.provider = config.provider
      received.model = config.model
      received.signal = signal
      return {
        async *stream(streamOptions: Record<string, unknown>) {
          holder.streamOptions = streamOptions
          if (options.failWith !== undefined) throw options.failWith
          yield { text: reply }
        },
      }
    },
  }
  return { llm, received, options: holder }
}

const route = { provider: 'deepseek', model: 'deepseek-v4.1-flash' }

describe('llmModel signal compatibility', () => {
  it('works with a standard AbortSignal', async () => {
    const { llm, received } = fakeLlm('模型返回内容')
    const text = await llmModel(llm, route).complete('sys', 'user', new AbortController().signal)
    expect(text).toBe('模型返回内容')
    expect(received.provider).toBe('deepseek')
    expect(received.signal).toBeInstanceOf(AbortSignal)
  })

  it('survives a signal that has no throwIfAborted method', async () => {
    // 这正是线上报错的形态：有 aborted 字段，但 throwIfAborted 不是函数。
    const broken = { aborted: false } as unknown as AbortSignal
    const { llm } = fakeLlm('仍然拿到内容')
    const text = await llmModel(llm, route).complete('sys', 'user', broken)
    expect(text).toBe('仍然拿到内容')
  })

  it('does not forward a non-standard signal to the adapter', async () => {
    // 残缺 signal 不该透传给 prepareCall —— 下游适配器可能内部调用该方法。
    const broken = { aborted: false } as unknown as AbortSignal
    const { llm, received } = fakeLlm('ok')
    await llmModel(llm, route).complete('sys', 'user', broken)
    expect(received.signal).toBeUndefined()
  })

  it('works when signal is undefined', async () => {
    const { llm } = fakeLlm('无 signal 也能跑')
    const text = await llmModel(llm, route).complete('sys', 'user', undefined as unknown as AbortSignal)
    expect(text).toBe('无 signal 也能跑')
  })

  it('stops early when the caller aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const { llm } = fakeLlm('不该拿到')
    const text = await llmModel(llm, route).complete('sys', 'user', controller.signal)
    // 已取消：不产出内容，但也不抛异常。
    expect(text).toBe('')
  })

  it('labels signal-related stream failures clearly', async () => {
    const broken = { aborted: false } as unknown as AbortSignal
    const { llm } = fakeLlm('x', { failWith: new Error('signal?.throwIfAborted is not a function') })
    await expect(llmModel(llm, route).complete('sys', 'user', broken))
      .rejects.toThrow('【模型调用signal兼容异常】')
  })

  it('passes non-signal failures through unchanged', async () => {
    const { llm } = fakeLlm('x', { failWith: new Error('rate limited') })
    await expect(llmModel(llm, route).complete('sys', 'user', undefined as unknown as AbortSignal))
      .rejects.toThrow('rate limited')
  })

  it('emits a full call-chain trace through the log hook', async () => {
    const lines: string[] = []
    const { llm } = fakeLlm('内容')
    await llmModel(llm, route, (message) => lines.push(message))
      .complete('sys', 'user', new AbortController().signal)
    const joined = lines.join('\n')
    expect(joined).toContain('prepareCall start')
    expect(joined).toContain('prepareCall ok')
    expect(joined).toContain('stream done')
    expect(joined).toContain('chars=2')
  })

  it('records prepareCall failures in the trace', async () => {
    const lines: string[] = []
    const llm: LlmLike = {
      async prepareCall() { throw new Error('provider not registered') },
    }
    await expect(llmModel(llm, route, (message) => lines.push(message))
      .complete('sys', 'user', new AbortController().signal))
      .rejects.toThrow('【模型调用signal兼容异常】')
    expect(lines.join('\n')).toContain('prepareCall FAILED')
    expect(lines.join('\n')).toContain('provider not registered')
  })
})
