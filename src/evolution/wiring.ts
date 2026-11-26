/**
 * 把元代理接到宿主真实服务上。
 *
 * 只做接线：会话读取、模型调用、技能清单。任何异常都不抛回主循环 ——
 * 这是个后台分析器，不该影响用户对话。
 */
import type { Context } from '@deepseek-ai/cordis'
import { EvolutionEngine, type EvolutionModel, type EvolutionSessionReader } from './engine.ts'
import { EvolutionStore } from './store.ts'
import { clipText, emptyNoiseStats, formatNoiseStats, keepUserMessage, type NoiseFilterStats, type ReviewMessage } from './review.ts'
import { applyProposal } from './apply.ts'
import { reparseMarkdown } from './reparse.ts'
import { dshHome } from '../store/paths.ts'
import type { EvolutionRouteDeps } from '../routes/evolution.ts'
import type { EvolutionDecisionRecord, EvolutionProposal, EvolutionRunRecord, EvolutionTuningState } from '../protocol/evolution.ts'
import { bucketOf, computeTuning, defaultTuning, MAX_DECISIONS, type TuningKey } from './tuning.ts'

/** `ctx.sessionQuery` 里用到的两个方法（结构化视图，便于测试替身）。 */
export interface SessionQueryLike {
  listSessions(signal?: AbortSignal): Promise<Array<{ header: { id: string; cwd?: string; title?: string } }>>
  readSurface(sessionId: string): Promise<{ events: ReadonlyArray<{ type: string; data?: unknown }> }>
}

/**
 * `ctx.llm`（LlmRuntime）的最小视图。
 *
 * **重要**：`LlmRuntime.prepareCall` 与 `LlmAdapter.prepareCall` 签名不同 ——
 * 前者收 `(config, signal?, configure?)`，后者收 `(provider, model, signal?)`。
 * 把三个位置参数传给 LlmRuntime 时，字符串 provider 会被当成 config 对象，
 * 第二个参数（model 字符串）被当成 signal，运行库在它上面调用
 * `throwIfAborted()` 就抛「signal?.throwIfAborted is not a function」——
 * 这正是进化分析一直失败的真正原因。
 */
export interface LlmLike {
  /** 收 config 对象（不是三个位置参数）。 */
  prepareCall(config: { provider: string; model: string }, signal?: AbortSignal): Promise<{
    stream(options: Record<string, unknown>): AsyncIterable<unknown>
  }>
}

/** 接线依赖。 */
export interface EvolutionWiringDeps {
  sessionQuery?: SessionQueryLike
  llm?: LlmLike
  /** 默认模型路由（惰性读，启动时还没有请求）。 */
  route?: () => { provider: string; model: string } | undefined
  /** 现有技能清单。 */
  listSkills: () => Promise<Array<{ name: string; description: string }>>
  /** 读技能正文。 */
  readSkillBody?: (name: string) => Promise<string | undefined>
  /** 读技能的发现来源（归属目录标签用）。 */
  readSkillSource?: (name: string) => Promise<string | undefined>
  /** 技能运行统计（历史调用量 / 近 7 天 / 成功率）。 */
  listUsage?: () => Promise<Array<{ name: string; total: number; week: number; successRate?: number; lastUsed?: number }>>
  /** 回收站元数据。 */
  listTrash?: () => Promise<Array<{ name: string; movedAt: number; note?: string }>>
  /**
   * 让 provider 重建发现结果。
   *
   * 落地新技能后必须调用：否则工作区页要等下一次轮询才能看到新文件，
   * 用户会以为「落地没成功」。
   */
  invalidate?: () => void
  /**
   * 推断细分专项应该落到哪个业务工作区。
   *
   * 用于旧提案兜底：修复前生成的提案没有 targetRoot 字段（数据已存在
   * evolution.json 里），落地时补一次推断，避免继续落到用户目录。
   */
  guessBusinessWorkspace?: () => Promise<string | undefined>
  /** 是否开启。 */
  enabled: () => boolean
  /** 提案文件路径。 */
  file?: string
  /** DSH home（落地写技能时用；缺省 dshHome()）。 */
  home?: string
  /** 日志。 */
  log?: (message: string) => void
}

/** 接线产物。 */
export interface EvolutionWiring {
  /** 供 makeRoutes 的路由依赖。 */
  routes: EvolutionRouteDeps
  /** 停掉（插件卸载时）。 */
  dispose: () => void
  /** 服务是否齐备。 */
  available: boolean
}

/** 从 surface 事件里取展示文本。 */
function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const b = block as { type?: unknown; text?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('\n')
}

/** 消息体：user/message 放 data.content，assistant/tool 放 data.message。 */
function messageBodyOf(data: Record<string, unknown>): Record<string, unknown> {
  const message = data.message
  return typeof message === 'object' && message !== null && !Array.isArray(message)
    ? message as Record<string, unknown>
    : data
}


/**
 * 把 surface 事件序列转成分析用的消息序列。
 *
 * 用户消息经过 {@link keepUserMessage} 的噪声过滤：运行时时间戳、插件上下文、
 * 子代理汇报、记忆快照、审批变更、后台任务通知都会被剔除，只留纯业务对话。
 * @param events - surface 事件。
 * @param stats - 过滤统计累加器（可选；传入时原地累加）。
 * @returns 按时序的消息。
 */
export function messagesFromSurface(
  events: ReadonlyArray<{ type: string; data?: unknown }>,
  stats?: NoiseFilterStats,
): ReviewMessage[] {
  const out: ReviewMessage[] = []
  const toolNames = new Map<string, string>()
  const counter = stats ?? emptyNoiseStats()
  for (const event of events) {
    const data = (event.data ?? {}) as Record<string, unknown>
    if (event.type === 'tool/call') {
      const callId = typeof data.callId === 'string' ? data.callId : undefined
      const name = typeof data.name === 'string' ? data.name : undefined
      if (callId !== undefined && name !== undefined) toolNames.set(callId, name)
      continue
    }
    if (event.type !== 'user/message' && event.type !== 'assistant/message' && event.type !== 'tool/result') continue
    const body = messageBodyOf(data)
    const text = clipText(textOfContent(body.content))
    if (text === '') continue
    if (event.type === 'user/message') {
      // 噪声过滤：只保留纯用户业务对话。
      const kept = keepUserMessage(text, counter)
      if (kept !== undefined) out.push({ role: 'user', text: kept })
      continue
    }
    if (event.type === 'assistant/message') {
      out.push({ role: 'assistant', text })
      continue
    }
    const callId = typeof data.callId === 'string' ? data.callId : undefined
    const tool = callId === undefined ? undefined : toolNames.get(callId)
    const failed = typeof data.error === 'string' || data.isError === true || data.failed === true
    out.push({ role: 'tool', text, ...tool === undefined ? {} : { tool }, ...failed ? { failed: true } : {} })
  }
  return out
}

/** 从模型输出里取纯文本增量。 */
function chunkText(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk
  if (typeof chunk !== 'object' || chunk === null) return ''
  const c = chunk as Record<string, unknown>
  if (typeof c.text === 'string') return c.text
  const delta = c.delta
  if (typeof delta === 'object' && delta !== null) {
    const d = delta as Record<string, unknown>
    if (typeof d.text === 'string') return d.text
  }
  return ''
}

/**
 * 安全地检查取消状态。
 *
 * `signal` 可能完全不存在、可能是没有 `throwIfAborted` 的旧实现，也可能
 * `throwIfAborted` 存在但不是函数 —— 三种都要挡住，否则整个模型调用会抛
 * 「signal?.throwIfAborted is not a function」。
 * @param signal - 调用方传入的取消信号（可能不规范）。
 * @returns 是否已取消。
 */
function isAborted(signal: unknown): boolean {
  if (signal === null || signal === undefined) return false
  if (typeof signal !== 'object') return false
  const candidate = (signal as { aborted?: unknown }).aborted
  if (candidate === true) return true
  const thrower = (signal as { throwIfAborted?: unknown }).throwIfAborted
  if (typeof thrower !== 'function') return false
  try {
    ;(thrower as () => void).call(signal)
    return false
  } catch {
    return true
  }
}

/** 用宿主 llm 服务构造一个「无工具一次性调用」的模型。 */
export function llmModel(llm: LlmLike, route: { provider: string; model: string }, log?: (message: string) => void): EvolutionModel {
  const trace = (message: string): void => { log?.('[dsh-skill-shelf] evolution model ' + message) }
  return {
    async complete(system: string, user: string, signal: AbortSignal): Promise<string> {
      trace(`prepareCall start provider=${route.provider} model=${route.model} signal=${signal === undefined ? 'undefined' : typeof signal}`)
      // 签名照 dsh-llm 的真实契约：prepareCall 收三个位置参数，stream 收一个
      // GenerateOptions。以前传成 `prepareCall({provider, model})` 会直接抛
      // 类型/运行错误，「运行分析」看起来就毫无反应。
      // 同一份 GenerateOptions 既用于 prepareCall 也用于 stream。
      //
      // 宿主 0.2.3 的 LlmRuntime 会**深比较** stream 收到的配置与 prepareCall
      // 冻结下来的配置，不一致就报错。所以这里只构造一次 options，两处共用；
      // stream 优先用 `call.config`（prepareCall 物化默认值后的版本），
      // 拿不到时才回退到原始 options。
      const options = {
        provider: route.provider,
        model: route.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
        system,
        maxTokens: 8192,
      }
      let call: Awaited<ReturnType<LlmLike['prepareCall']>>
      try {
        // 只在 signal 看起来是合规的 AbortSignal 时才传它。
        // 宿主某些路径传进来的 signal 只有 `aborted` 字段、没有 throwIfAborted，
        // 直接透传会让下游适配器在内部调用该方法时抛异常。
        const usable = signal !== undefined && typeof (signal as { addEventListener?: unknown }).addEventListener === 'function'
        trace(`prepareCall signal usable=${String(usable)}`)
        // 注意参数形状：LlmRuntime 收 config 对象，不是 (provider, model, signal)。
        call = usable
          ? await llm.prepareCall(options, signal)
          : await llm.prepareCall(options)
      } catch (error) {
        trace('prepareCall FAILED: ' + describeError(error))
        throw new Error('【模型调用signal兼容异常】prepareCall 失败: ' + describeError(error))
      }
      trace('prepareCall ok, streaming…')
      const stream = call.stream((call as { config?: Record<string, unknown> }).config ?? options)
      const parts: string[] = []
      let chunks = 0
      try {
        for await (const chunk of stream) {
          chunks += 1
          // 取消检查走安全封装：不直接碰 signal.throwIfAborted。
          if (isAborted(signal)) {
            trace('aborted by caller after ' + String(chunks) + ' chunks')
            break
          }
          const text = chunkText(chunk)
          if (text !== '') parts.push(text)
        }
      } catch (error) {
        trace('stream FAILED after ' + String(chunks) + ' chunks: ' + describeError(error))
        const message = describeError(error)
        // signal 相关异常单独标注，便于一眼区分是环境问题还是模型问题。
        if (/throwIfAborted|signal|abort/i.test(message)) {
          throw new Error('【模型调用signal兼容异常】stream 阶段: ' + message)
        }
        throw error
      }
      const joined = parts.join('')
      trace(`stream done chunks=${String(chunks)} chars=${String(joined.length)}`)
      return joined
    },
  }
}

/** 把异常压成一句可读文本。 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** 用宿主 sessionQuery 构造会话读取器。 */
export function sessionReader(query: SessionQueryLike, log?: (message: string) => void): EvolutionSessionReader {
  /** 会话消息缓存：取样排序和正式读取共用，避免同一会话读两遍。 */
  const cache = new Map<string, ReviewMessage[]>()
  /** 全局过滤统计：一次运行结束后汇总成一行日志。 */
  const noiseStats = emptyNoiseStats()

  const load = async (sessionId: string): Promise<ReviewMessage[]> => {
    const hit = cache.get(sessionId)
    if (hit !== undefined) return hit
    const surface = await query.readSurface(sessionId)
    const messages = messagesFromSurface(surface.events, noiseStats)
    cache.set(sessionId, messages)
    return messages
  }
  return {
    async listSessions(): Promise<Array<{ id: string; userMessages?: number; cwd?: string }>> {
      const sessions = await query.listSessions()
      // 带上用户消息数与工作区：前者用于排序，后者用于「业务工作区优先」。
      // 读不出来的会话跳过（不影响其余候选）。
      const out: Array<{ id: string; userMessages?: number; cwd?: string }> = []
      for (const session of sessions) {
        const id = session.header.id
        const cwd = session.header.cwd
        try {
          const messages = await load(id)
          out.push({
            id,
            userMessages: messages.filter((message) => message.role === 'user').length,
            ...typeof cwd === 'string' && cwd !== '' ? { cwd } : {},
          })
        } catch {
          out.push({ id, ...typeof cwd === 'string' && cwd !== '' ? { cwd } : {} })
        }
      }
      return out
    },
    async readMessages(sessionId: string): Promise<ReviewMessage[]> {
      return load(sessionId)
    },
    async readTitle(sessionId: string): Promise<string | undefined> {
      const sessions = await query.listSessions()
      const hit = sessions.find((session) => session.header.id === sessionId)
      const title = hit?.header.title
      return typeof title === 'string' && title !== '' ? title : undefined
    },
    /** 把累计的噪声过滤统计写成一行日志（一次运行结束后调用）。 */
    flushNoiseStats(): string {
      const line = formatNoiseStats(noiseStats)
      log?.('[dsh-skill-shelf] evolution ' + line)
      return line
    },
  }
}

/**
 * 组装元代理。
 * @param deps - 宿主能力。
 * @returns 路由依赖与生命周期；服务不齐时 available 为 false。
 */
export function wireEvolution(deps: EvolutionWiringDeps): EvolutionWiring {
  const store = new EvolutionStore(deps.file)
  const log = deps.log ?? (() => undefined)

  const unavailable = (reason: string): EvolutionWiring => ({
    available: false,
    routes: {
      read: async () => {
        const state = await store.read()
        return { markdown: state.markdown, ranAt: state.ranAt, proposals: state.proposals, runs: state.runs, rejections: state.rejections, tuning: state.tuning ?? defaultTuning() }
      },
      run: async () => ({ markdown: '', proposals: [], sessions: 0, messages: 0, skipped: reason }),
      status: () => ({ running: false, elapsedMs: 0 }),
      reparse: async () => ({ ok: false, error: reason, proposals: 0, elapsedMs: 0, hasMarkdown: false }),
      decide: async () => ({ found: false }),
      tuning: async () => ({ tuning: defaultTuning() }),
      recalibrate: async () => ({ tuning: defaultTuning() }),
      clear: async () => undefined,
    },
    dispose: () => undefined,
  })

  if (deps.sessionQuery === undefined || deps.llm === undefined || deps.route === undefined) {
    return unavailable('evolution unavailable in this profile (sessionQuery / llm missing)')
  }

  const reader = sessionReader(deps.sessionQuery)
  const llm = deps.llm
  const readRoute = deps.route
  const model: EvolutionModel = {
    async complete(system, user, signal) {
      const route = readRoute()
      if (route === undefined) throw new Error('no model route available yet (send one message first)')
      return llmModel(llm, route, log).complete(system, user, signal)
    },
  }

  const engine = new EvolutionEngine({
    reader,
    model,
    listSkills: deps.listSkills,
    ...deps.readSkillBody === undefined ? {} : { readSkillBody: deps.readSkillBody },
    ...deps.readSkillSource === undefined ? {} : { readSkillSource: deps.readSkillSource },
    enabled: deps.enabled,
    // 约束 4：把历史驳回理由喂回模型，同类场景不再重复生成相同提案。
    listRejections: async () => (await store.read()).rejections.map((item) => ({ skillName: item.skillName, reason: item.reason })),
    // 统计维度：技能运行指标与回收站状态。两个都是可选注入，缺了不影响主流程。
    ...deps.listUsage === undefined ? {} : { listUsage: deps.listUsage },
    ...deps.listTrash === undefined ? {} : { listTrash: deps.listTrash },
    log,
  })

  return {
    available: true,
    routes: {
      read: async () => {
        const state = await store.read()
        return { markdown: state.markdown, ranAt: state.ranAt, proposals: state.proposals, runs: state.runs, rejections: state.rejections, tuning: state.tuning ?? defaultTuning() }
      },
      run: async (sessionId) => {
        const result = await engine.run(sessionId)
        const record: EvolutionRunRecord = {
          at: Date.now(),
          sessions: result.sessions,
          messages: result.messages,
          proposals: result.proposals.length,
          ...result.error === undefined ? {} : { error: result.error },
          ...result.skipped === undefined ? {} : { skipped: result.skipped },
        }
        // 只有真的跑出内容才覆盖 markdown：失败/跳过不该把上一次的提案清空。
        await store.update((current) => ({
          ...current,
          ...result.error !== undefined || result.skipped !== undefined ? {} : { markdown: result.markdown, ranAt: record.at },
          proposals: result.proposals.length === 0
            ? current.proposals
            : capMerge(current.proposals, result.proposals),
          runs: [record, ...current.runs].slice(0, 50),
        })).catch((error: unknown) => {
          log('[dsh-skill-shelf] evolution persist failed: ' + (error instanceof Error ? error.message : String(error)))
        })
        return result
      },
      // 运行态直接读引擎：前端轮询 GET 时拿到的是服务端真实进度。
      status: () => engine.status(),
      /**
       * 离线重新解析：用已存的模型输出重跑同一条解析管线。
       *
       * 三个安全点：
       * 1. 只读 `state.markdown`，绝不改它（原始运行记录永久保留）；
       * 2. 替换 proposals 前把旧列表备份到 `previousProposals`，可回滚；
       * 3. 解析失败或 0 条有效提案时**不写入**，保留上一版数据。
       */
      reparse: async () => {
        const state = await store.read()
        const sources = {
          usage: await deps.listUsage?.().catch(() => []) ?? [],
          trash: await deps.listTrash?.().catch(() => []) ?? [],
          rejections: state.rejections.map((item) => ({ skillName: item.skillName, reason: item.reason })),
    tuning: state.tuning ?? defaultTuning(),
        }
        const result = reparseMarkdown(state.markdown, sources, Date.now())
        if (!result.ok || result.proposals.length === 0) {
          // 失败不落盘 —— 保留上一版有效数据，不写半拉结果。
          return {
            ok: false,
            ...result.error === undefined ? { error: '重新解析未产出有效提案' } : { error: result.error },
            proposals: 0,
            elapsedMs: result.elapsedMs,
            dropped: result.dropped,
            hasMarkdown: state.markdown.trim() !== '',
          }
        }
        await store.update((current) => ({
          ...current,
          // 备份上一版，支持回滚到解析前状态。
          previousProposals: current.proposals,
          proposals: result.proposals,
          // 注意：markdown / ranAt / runs 一律不动 —— 原始运行记录永久保留。
        }))
        log('[dsh-skill-shelf] evolution reparse produced ' + String(result.proposals.length) + ' proposal(s) in ' + String(result.elapsedMs) + 'ms')
        return {
          ok: true,
          proposals: result.proposals.length,
          elapsedMs: result.elapsedMs,
          dropped: result.dropped,
          hasMarkdown: true,
        }
      },
      /**
       * 锁定 / 解锁 / 恢复默认。
       *
       * 只改 `tuning` 这一块，不跑校准、不碰提案 —— 恢复默认不会让任何提案
       * 状态变化，也不会写技能文件。
       */
      tuning: async (patch: { lock?: string; unlock?: string; reset?: boolean }) => {
        let next: EvolutionTuningState | undefined
        await store.update((current) => {
          const base = current.tuning ?? defaultTuning()
          let tuning = base
          if (patch.reset === true) {
            tuning = defaultTuning()
          } else {
            const locked = new Set(base.locked)
            if (patch.lock !== undefined) locked.add(patch.lock as TuningKey)
            if (patch.unlock !== undefined) locked.delete(patch.unlock as TuningKey)
            tuning = { ...base, locked: [...locked] }
          }
          next = tuning
          return { ...current, tuning }
        })
        return { tuning: next ?? defaultTuning() }
      },

      decide: async (id, status, reason, root) => {
        const state = await store.read()
        const proposal = state.proposals.find((item) => item.id === id)
        if (proposal === undefined) return { found: false }

        /**
         * 记一条裁决。
         *
         * 三种动作都要落盘：以前只有 rejected 留痕（且只用于去重），accepted
         * 和 deferred 完全不记录，于是自适应校准没有任何样本可学。这里统一
         * 写进 `decisions`，并按类型把理由归桶（自由文本归 freeform，只计数
         * 不驱动参数）。
         */
        const recordDecision = (action: 'accepted' | 'rejected' | 'deferred'): EvolutionDecisionRecord => ({
          id,
          kind: proposal.kind,
          skillName: proposal.skillName,
          action,
          reason: reason ?? '',
          reasonBucket: bucketOf(proposal.kind, reason ?? ''),
          at: Date.now(),
        })

        // rejected / deferred：只改状态 + 记原因。
        if (status !== 'accepted') {
          await store.update((current) => ({
            ...current,
            proposals: current.proposals.map((item) => item.id === id ? { ...item, status: status as EvolutionProposal['status'] } : item),
            // 驳回记录仍单独保留：它是「同类不再重复生成」的抑制名单，
            // 语义与全量裁决台账不同，两者不能合并。
            rejections: status === 'rejected' && reason !== undefined && reason !== ''
              ? [
                  { id, skillName: proposal.skillName, reason, at: Date.now(), kind: proposal.kind },
                  ...current.rejections,
                ].slice(0, 200)
              : current.rejections,
            decisions: [recordDecision(status), ...(current.decisions ?? [])].slice(0, MAX_DECISIONS),
          }))
          return { found: true }
        }

        // accepted：先落地成真实技能文件，成功后再改状态。
        //
        // 目标目录按提案自带的 targetRoot 决定：细分专项写进对应工作区的
        // `.dsh/skills`，其余仍走用户可写根。调用方显式传 root 时以调用方为准。
        //
        // **旧提案兜底**：修复前生成的提案没有 targetRoot 字段（数据已存在
        // evolution.json 里）。这类细分专项如果直接按默认落到用户目录，
        // 工作区页永远看不到它 —— 所以在落地时再推断一次。
        let effectiveRoot = root ?? proposal.targetRoot
        let targetWorkspace = proposal.targetWorkspace
        if (effectiveRoot === undefined) {
          if (proposal.kind === 'new-skill' && proposal.recommendation === 'niche') {
            const guessed = await deps.guessBusinessWorkspace?.().catch(() => undefined)
            if (guessed !== undefined && guessed !== '') {
              effectiveRoot = 'project'
              targetWorkspace = guessed
            }
          }
          effectiveRoot ??= 'user-dsh'
        }
        // 已经是 project 但缺路径（旧数据）：补一次推断，补不上就明确报错。
        if (effectiveRoot === 'project' && (targetWorkspace === undefined || targetWorkspace === '')) {
          targetWorkspace = await deps.guessBusinessWorkspace?.().catch(() => undefined)
        }
        const outcome = await applyProposal(
          proposal,
          deps.home ?? dshHome(),
          effectiveRoot,
          Date.now(),
          targetWorkspace,
        )
        if (!outcome.ok) {
          // 落地失败时提案保持 pending，用户可以修正后重试。
          return { found: true, error: outcome.error }
        }
        await store.update((current) => ({
          ...current,
          proposals: current.proposals.map((item) => item.id === id ? { ...item, status: 'accepted' } : item),
          // 采纳也要留痕 —— 「用户大量采纳」是校准里唯一能反向放宽门槛的信号。
          decisions: [recordDecision('accepted'), ...(current.decisions ?? [])].slice(0, MAX_DECISIONS),
        }))
        // 落地后立刻让 provider 重建发现结果：不刷新的话，工作区页要等下一次
        // 5 秒轮询才会出现新技能，用户会以为「落地没成功」。
        deps.invalidate?.()
        return {
          found: true,
          ...outcome.name === undefined ? {} : { appliedName: outcome.name },
          ...outcome.path === undefined ? {} : { appliedPath: outcome.path },
          ...outcome.backupPath === undefined ? {} : { backupPath: outcome.backupPath },
        }
      },
      /**
       * 按裁决历史重算参数（确定性，不经模型）。
       *
       * 只写 `tuning`，不碰提案、不碰技能文件。进化总开关关闭时直接返回当前
       * 状态 —— 参数保留但不再变化。
       */
      recalibrate: async () => {
        if (!deps.enabled()) return { tuning: (await store.read()).tuning ?? defaultTuning() }
        let next: EvolutionTuningState | undefined
        await store.update((current) => {
          const base = current.tuning ?? defaultTuning()
          const decisions = (current.decisions ?? []).map((item) => ({
            ...item,
            reasonBucket: item.reasonBucket as never,
          }))
          const out = computeTuning({ decisions: decisions as never, current: base })
          if (out.applied.length === 0) { next = base; return current }
          const tuning: EvolutionTuningState = {
            params: out.params,
            updatedAt: Date.now(),
            basis: out.basis as never,
            applied: out.applied,
            adjustedAt: out.adjustedAt as never,
            locked: base.locked,
          }
          next = tuning
          return { ...current, tuning }
        })
        return { tuning: next ?? defaultTuning() }
      },
      clear: async () => {
        await store.update((current) => ({ ...current, markdown: '', proposals: [], ranAt: 0 }))
      },
    },
    dispose: () => undefined,
  }
}

/** 合并新旧提案：同 id 覆盖，其余保留，最后截断。 */
function capMerge(existing: readonly import('../protocol/evolution.ts').EvolutionProposal[], incoming: readonly import('../protocol/evolution.ts').EvolutionProposal[]): import('../protocol/evolution.ts').EvolutionProposal[] {
  const byId = new Map<string, import('../protocol/evolution.ts').EvolutionProposal>()
  for (const proposal of [...incoming, ...existing]) {
    if (!byId.has(proposal.id)) byId.set(proposal.id, proposal)
  }
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 200)
}

/**
 * 取当前的模型路由。
 *
 * 依次尝试三个来源，因为没有一个在**所有**时机都可用：
 * 1. `agentDefaultModel.currentSelection()` —— 最可靠，它就是「默认模型」的持有者；
 * 2. 最近一个会话的 requestContext —— 用户可能给当前会话指定过别的模型；
 * 3. `agentLoop.config` —— 兜底的部署默认值。
 *
 * 以前只试了第 2 条且用了不存在的 `sessions.list()`，于是永远返回 undefined，
 * 「运行分析」直接抛「没有可用模型路由」。
 * @param ctx - 宿主上下文。
 * @returns provider/model，取不到则 undefined。
 */
export function routeFromContext(ctx: Context): { provider: string; model: string } | undefined {
  const pick = (provider: unknown, model: unknown): { provider: string; model: string } | undefined =>
    typeof provider === 'string' && provider !== '' && typeof model === 'string' && model !== ''
      ? { provider, model }
      : undefined

  // 1) 默认模型持有者。
  try {
    const defaults = ctx.get('agentDefaultModel') as { currentSelection?: () => { provider?: unknown; model?: unknown } } | undefined
    const selection = defaults?.currentSelection?.()
    const hit = pick(selection?.provider, selection?.model)
    if (hit !== undefined) return hit
  } catch {
    // 服务缺失就换下一个来源。
  }

  // 2) 最近会话显式指定过的模型。
  try {
    const sessions = ctx.get('sessions') as { list?: () => Array<{ requestContext?: () => unknown }> } | undefined
    const list = sessions?.list?.() ?? []
    for (const session of [...list].reverse()) {
      const context = session.requestContext?.()
      if (typeof context !== 'object' || context === null) continue
      const c = context as { provider?: unknown; model?: unknown }
      const hit = pick(c.provider, c.model)
      if (hit !== undefined) return hit
    }
  } catch {
    // 同上。
  }

  // 3) 部署默认值。
  try {
    const loop = ctx.get('agentLoop') as { config?: { provider?: unknown; model?: unknown } } | undefined
    return pick(loop?.config?.provider, loop?.config?.model)
  } catch {
    return undefined
  }
}
