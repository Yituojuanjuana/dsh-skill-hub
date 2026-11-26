/**
 * 真实链路验证：模拟宿主 llm 服务的**残缺 signal** 行为，确认模型调用能跑通。
 *
 * 这个测试直接复刻线上故障场景：宿主把一个只有 `aborted` 字段的对象当
 * AbortSignal 传进来，旧代码在 stream 循环里调用 `signal.throwIfAborted()`
 * 直接崩溃。现在必须能正常拿到模型内容。
 */
import { describe, expect, it } from 'vitest'
import { llmModel, type LlmLike } from './wiring.ts'

/** 复刻宿主真实行为：内部会调用 signal.throwIfAborted 的适配器。 */
function adapterThatCallsThrowIfAborted(): LlmLike {
  return {
    async prepareCall(_config, signal) {
      return {
        async *stream() {
          // 真实适配器就是这么写的：它信任 signal 是标准 AbortSignal。
          // 如果我们把残缺 signal 透传进来，这里就抛异常。
          const s = signal as unknown as { throwIfAborted?: () => void } | undefined
          if (s !== undefined && typeof s.throwIfAborted === 'function') {
            s.throwIfAborted()
          } else if (s !== undefined) {
            // 残缺 signal：适配器直接调用 → 抛「is not a function」
            ;(s.throwIfAborted as unknown as () => void)()
          }
          yield { delta: { text: '这是模型返回的提案文本' } }
        },
      }
    },
  }
}

describe('full call chain against a host-like adapter', () => {
  it('does not forward the broken signal, so the adapter never crashes', async () => {
    const broken = { aborted: false } as unknown as AbortSignal
    const lines: string[] = []
    const text = await llmModel(adapterThatCallsThrowIfAborted(), { provider: 'deepseek', model: 'v4' }, (m) => lines.push(m))
      .complete('system prompt', 'user prompt', broken)
    // 拿到模型返回内容 —— 这就是修复的最终验收标准。
    expect(text).toBe('这是模型返回的提案文本')
    const trace = lines.join('\n')
    expect(trace).toContain('signal usable=false')
    expect(trace).toContain('stream done')
  })

  it('still works end to end with a proper AbortSignal', async () => {
    const lines: string[] = []
    const text = await llmModel(adapterThatCallsThrowIfAborted(), { provider: 'deepseek', model: 'v4' }, (m) => lines.push(m))
      .complete('system prompt', 'user prompt', new AbortController().signal)
    expect(text).toBe('这是模型返回的提案文本')
    expect(lines.join('\n')).toContain('signal usable=true')
  })

  it('collects multiple chunks into one string', async () => {
    const llm: LlmLike = {
      async prepareCall() {
        return {
          async *stream() {
            yield { text: '第一段' }
            yield { delta: { text: '第二段' } }
            yield { text: '第三段' }
          },
        }
      },
    }
    const lines: string[] = []
    const text = await llmModel(llm, { provider: 'p', model: 'm' }, (m) => lines.push(m))
      .complete('s', 'u', new AbortController().signal)
    expect(text).toBe('第一段第二段第三段')
    expect(lines.join('\n')).toContain('chunks=3')
  })
})

describe('LlmRuntime signature contract', () => {
  it('passes a config object, never positional (provider, model, signal)', async () => {
    // 这是线上真实故障：把三个位置参数传给 ctx.llm（LlmRuntime）时，
    // 字符串 provider 被当成 config、model 字符串被当成 signal，
    // 运行库在它上面调用 throwIfAborted() → 「is not a function」。
    let receivedConfig: unknown
    let receivedSignal: unknown
    const llm = {
      async prepareCall(config: unknown, signal?: unknown) {
        receivedConfig = config
        receivedSignal = signal
        return {
          async *stream() { yield { text: 'ok' } },
        }
      },
    }
    await llmModel(llm as never, { provider: 'deepseek', model: 'v4' })
      .complete('s', 'u', new AbortController().signal)

    // config 必须是对象，且带 provider/model（现在是完整的 GenerateOptions，
    // 因为宿主 0.2.3 会深比较 prepareCall 与 stream 的配置）。
    expect(typeof receivedConfig).toBe('object')
    expect(receivedConfig).toMatchObject({ provider: 'deepseek', model: 'v4' })
    // 第二个参数必须是真正的 AbortSignal，不是字符串。
    expect(receivedSignal).toBeInstanceOf(AbortSignal)
  })

  it('omits the signal argument entirely when it is not usable', async () => {
    let argCount = -1
    const llm = {
      async prepareCall(_config: unknown, signal?: unknown) {
        argCount = signal === undefined ? 1 : 2
        return { async *stream() { yield { text: 'ok' } } }
      },
    }
    const broken = { aborted: false } as unknown as AbortSignal
    await llmModel(llm as never, { provider: 'p', model: 'm' }).complete('s', 'u', broken)
    expect(argCount).toBe(1)
  })
})