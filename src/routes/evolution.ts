/**
 * 技能进化元代理的路由。
 *
 * 关键安全约束：**这里没有任何写技能文件的动作**。run 只产出提案文本，
 * decide 只改提案的 status，clear 只清提案。技能文件的修改永远由用户在
 * 技能页手动完成 —— 这是需求里「绝不自动读写技能文件」的落地点。
 */
import {
  SKILL_HUB_API,
  type EvolutionClearResponse,
  type EvolutionReparseResponse,
  type EvolutionDecideResponse,
  type EvolutionProposal,
  type EvolutionResponse,
  type EvolutionRunResponse,
} from '../protocol.ts'
import type {
  EvolutionTuningState, EvolutionRunResult, EvolutionRunStatus } from '../protocol/evolution.ts'
import { defaultTuningState } from '../protocol/evolution.ts'
import { errorText } from '../error-text.ts'
import { configOf, isWritableSource, readString, writeError, writeJson, type RouteSpec, type SkillHubRouteDeps } from './helpers.ts'

/** 路由对引擎的最小视图（便于测试替身）。 */
export interface EvolutionRouteDeps {
  /** 读当前提案与运行状态。 */
  read(): Promise<{
    markdown: string
    ranAt: number
    proposals: EvolutionProposal[]
    runs: EvolutionResponse['runs']
    rejections: EvolutionResponse['rejections']
    tuning: EvolutionTuningState
  }>
  /**
   * 锁定 / 解锁 / 恢复默认参数。
   *
   * 只改 tuning，不跑校准、不碰提案。
   */
  tuning(patch: { lock?: string; unlock?: string; reset?: boolean; probabilityEnabled?: boolean }): Promise<{ tuning: EvolutionTuningState }>
  /** 按裁决历史重算参数（确定性，不经模型）。 */
  recalibrate(): Promise<{ tuning: EvolutionTuningState }>
  /** 跑一次进化（会一直跑到结束；后台任务用）。 */
  run(sessionId?: string): Promise<EvolutionRunResult>
  /** 当前运行态（服务端真实状态，前端轮询读它）。 */
  status(): EvolutionRunStatus
  /**
   * 人工处理一条提案。
   *
   * accepted 会把提案落地成真实技能文件（替换时先备份）；rejected/deferred
   * 只改状态并记下原因（驳回原因用于抑制同类提案）。
   */
  decide(id: string, status: 'accepted' | 'rejected' | 'deferred', reason?: string, root?: 'user-dsh' | 'user-agents'): Promise<{
    found: boolean
    appliedName?: string
    appliedPath?: string
    backupPath?: string
    error?: string
  }>
  /** 清空提案。 */
  clear(): Promise<void>
  /**
   * 离线重新解析：用已存的模型输出重跑解析管线。
   *
   * 不调用模型、不读会话；失败或 0 条有效提案时不写入（保留上一版）。
   */
  reparse(): Promise<{
    ok: boolean
    error?: string
    proposals: number
    elapsedMs: number
    dropped?: { noDraft: number; invalid: number; rejected: number; duplicate: number }
    hasMarkdown: boolean
  }>
}

/** 没有执行器时的占位：队列空、运行回「不可用」。 */
export function unavailableEvolution(): EvolutionRouteDeps {
  return {
    read: async () => ({ markdown: '', ranAt: 0, proposals: [], runs: [], rejections: [], tuning: defaultTuningState() }),
    run: async () => ({ markdown: '', proposals: [], sessions: 0, messages: 0, skipped: 'evolution unavailable in this profile' }),
    status: () => ({ running: false, elapsedMs: 0 }),
    decide: async () => ({ found: false }),
    tuning: async () => ({ tuning: defaultTuningState() }),
    recalibrate: async () => ({ tuning: defaultTuningState() }),
    clear: async () => undefined,
    reparse: async () => ({ ok: false, error: 'evolution unavailable in this profile', proposals: 0, elapsedMs: 0, hasMarkdown: false }),
  }
}

/**
 * 惰性解析的执行器代理。
 *
 * 为什么必须惰性：`makeRoutes` 在 sync() 里**同步**执行，而进化执行器要等
 * `ctx.inject(['sessionQuery','llm'])` 的回调才会被赋值。直接把
 * `evolutionWiring?.routes` 传进去，那一刻拿到的永远是 undefined，路由就
 * 永久绑定到占位实现 —— 界面上点「运行分析」于是毫无反应（只回一个
 * skipped，看起来像没点）。
 *
 * 代理在**每次调用时**才去读真正的执行器，服务晚到也能用上。
 * @param resolve - 取当前执行器（可能还是 undefined）。
 * @returns 稳定的路由依赖。
 */
export function lazyEvolution(resolve: () => EvolutionRouteDeps | undefined): EvolutionRouteDeps {
  const pick = (): EvolutionRouteDeps => resolve() ?? unavailableEvolution()
  return {
    read: async () => pick().read(),
    run: async (sessionId) => pick().run(sessionId),
    // status 必须同步读：它是「现在跑没跑」，异步包装会让前端拿到过期值。
    status: () => pick().status(),
    decide: async (id, status, reason, root) => pick().decide(id, status, reason, root),
    clear: async () => pick().clear(),
    reparse: async () => pick().reparse(),
    tuning: async (patch) => pick().tuning(patch),
    recalibrate: async () => pick().recalibrate(),
  }
}

/** 进化域的全部路由。 */
export function evolutionRoutes(deps: SkillHubRouteDeps, evolution: EvolutionRouteDeps): RouteSpec[] {
  return [
    // --------------------------------------------------------------- read
    {
      path: SKILL_HUB_API.evolution,
      methods: ['GET'],
      handler: async ({ res }) => {
        const state = await evolution.read()
        // 运行态来自引擎的真实状态，前端不猜。
        const status = evolution.status()
        writeJson(res, 200, {
          ok: true,
          enabled: configOf(deps).evolution === true,
          markdown: state.markdown,
          ranAt: state.ranAt,
          proposals: state.proposals,
          runs: state.runs,
          rejections: state.rejections,
          running: status.running,
          ...status.startedAt === undefined ? {} : { startedAt: status.startedAt },
          elapsedMs: status.elapsedMs,
          ...status.lastError === undefined ? {} : { lastError: status.lastError },
          ...status.lastSkip === undefined ? {} : { lastSkip: status.lastSkip },
        } satisfies EvolutionResponse)
      },
    },
    // ---------------------------------------------------------------- run
    // 后台任务：立即返回 {started} 或 {alreadyRunning}，不再把 HTTP 请求挂几分钟。
    //
    // 之前是 `await evolution.run(...)`，一次分析要 1~4 分钟，浏览器一刷新/切页
    // 请求就断，前端看到「没反应」；而服务端的 this.running 还卡着，再点就永远
    // 返回「another run is in progress」。改成 fire-and-forget 后，进度靠 GET
    // 轮询读引擎的真实状态。
    {
      path: SKILL_HUB_API.evolutionRun,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        if (configOf(deps).evolution !== true) { writeError(res, 400, 'skill evolution is turned off in the settings card'); return }
        // 并发保护：已经在跑就直接告诉前端，不当作错误吞掉。
        const current = evolution.status()
        if (current.running) {
          writeJson(res, 200, {
            ok: true,
            started: false,
            alreadyRunning: true,
            startedAt: current.startedAt,
            elapsedMs: current.elapsedMs,
          } satisfies EvolutionRunResponse)
          return
        }
        const sessionId = readString(body, 'sessionId')
        // 不 await：立刻返回，让 HTTP 请求结束。后台自己跑完并写 evolution.json。
        void evolution.run(sessionId === '' ? undefined : sessionId).catch((error: unknown) => {
          // run 内部已经把失败写进 lastError；这里只兜住未捕获的异常，避免
          // unhandled rejection 把进程日志刷满。
          void error
        })
        writeJson(res, 200, { ok: true, started: true } satisfies EvolutionRunResponse)
      },
    },
    // ------------------------------------------------------------- decide
    {
      path: SKILL_HUB_API.evolutionDecide,
      methods: ['POST'],
      jsonBody: true,
      serialize: true,
      handler: async ({ res, body }) => {
        const id = readString(body, 'id')
        const status = readString(body, 'status')
        const reason = readString(body, 'reason')
        if (id === '') { writeError(res, 400, 'id is required'); return }
        if (status !== 'accepted' && status !== 'rejected' && status !== 'deferred') {
          writeError(res, 400, 'status must be accepted, rejected or deferred'); return
        }
        // 驳回必须给原因：它同时是「同类场景不再重复生成」的依据。
        if (status === 'rejected' && reason === '') {
          writeError(res, 400, 'reason is required when rejecting (it suppresses the same scenario next run)'); return
        }
        const rootText = readString(body, 'root')
        if (rootText !== '' && !isWritableSource(rootText)) {
          writeError(res, 400, 'root must be user-dsh or user-agents'); return
        }
        let outcome
        try {
          outcome = await evolution.decide(id, status, reason, rootText === '' ? undefined : rootText)
        } catch (error) {
          writeError(res, 500, errorText(error)); return
        }
        if (!outcome.found) { writeError(res, 404, 'proposal not found: ' + id); return }
        writeJson(res, 200, {
          ok: true,
          ...outcome.appliedName === undefined ? {} : { appliedName: outcome.appliedName },
          ...outcome.appliedPath === undefined ? {} : { appliedPath: outcome.appliedPath },
          ...outcome.backupPath === undefined ? {} : { backupPath: outcome.backupPath },
          ...outcome.error === undefined ? {} : { error: outcome.error },
        } satisfies EvolutionDecideResponse)
      },
    },
    // -------------------------------------------------------------- clear
    {
      path: SKILL_HUB_API.evolutionClear,
      methods: ['POST'],
      jsonBody: true,
      serialize: true,
      handler: async ({ res }) => {
        await evolution.clear()
        writeJson(res, 200, { ok: true } satisfies EvolutionClearResponse)
      },
    },
    // ------------------------------------------------------------ reparse
    // 用已存的模型输出重新解析：不调用模型、不读会话，纯本地文本处理。
    {
      path: SKILL_HUB_API.evolutionReparse,
      methods: ['POST'],
      jsonBody: true,
      serialize: true,
      handler: async ({ res }) => {
        let outcome
        try {
          outcome = await evolution.reparse()
        } catch (error) {
          writeError(res, 500, errorText(error)); return
        }
        writeJson(res, 200, {
          ok: outcome.ok,
          proposals: outcome.proposals,
          elapsedMs: outcome.elapsedMs,
          hasMarkdown: outcome.hasMarkdown,
          ...outcome.error === undefined ? {} : { error: outcome.error },
          ...outcome.dropped === undefined ? {} : { dropped: outcome.dropped },
        } satisfies EvolutionReparseResponse)
      },
    },
    /**
     * 自适应参数的锁定 / 恢复默认。
     *
     * 只写 `tuning.locked` 与 `tuning.params`，**不触发校准本身** —— 校准按
     * 裁决历史在分析时跑，这里只是让用户能钉住某个参数或整体复位。
     */
    {
      path: SKILL_HUB_API.evolutionTuning,
      methods: ['POST'],
      jsonBody: true,
      serialize: true,
      handler: async ({ res, body }) => {
        const patch = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
        let outcome
        try {
          outcome = await evolution.tuning({
            ...typeof patch.lock === 'string' ? { lock: patch.lock } : {},
            ...typeof patch.unlock === 'string' ? { unlock: patch.unlock } : {},
            ...patch.reset === true ? { reset: true } : {},
            ...typeof patch.probabilityEnabled === 'boolean' ? { probabilityEnabled: patch.probabilityEnabled } : {},
          })
        } catch (error) {
          writeError(res, 500, errorText(error)); return
        }
        writeJson(res, 200, { ok: true, tuning: outcome.tuning })
      },
    },
  ]
}
