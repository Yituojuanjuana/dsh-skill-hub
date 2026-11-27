/**
 * 运行与连接路由：状态卡、三个动作、连接信息。
 *
 * 设计约束（0.7.0 需求）：
 *  - **唯一执行体**是 `~/.dsh/cloudflared/dsh-control.ps1`。本文件只负责调用它、
 *    解析它输出的 JSON、把结果翻成 HTTP。插件里不出现任何 cloudflared 命令行、
 *    不出现任何「关闭进程 / 重新拉起」的实现 —— 那些只在脚本里有一份。
 *  - 所有路由都走既有的 route fence（loopback + bind + trusted-host + browser
 *    session，见 ./http.ts 与 ./routes.ts 的 createRoute 包装），新路由不会漏围栏。
 *  - restart 前先查有没有正在跑的 turn：有就拒绝（返回 409 + 人话原因），
 *    不排队。查询用 `ctx.agents.list()` + `turnBoundaryOf`，`openTurnStartSeq`
 *    非 null 即「该 Session 正在 turn 内」。
 *  - restart 是 detached 的：脚本立刻返回，这里回 202，不让请求悬着。
 *  - 冷却 5 分钟（脚本侧是唯一真源，这里只读它报回来的剩余秒数）。
 *  - 审计日志由脚本统一写（固定路径 dsh-control.log）；本文件不写第二份，
 *    也**绝不**把 token / 配对码写进日志或响应体。
 */
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  SKILL_HUB_API,
  type OpsAction,
  type OpsActionResponse,
  type OpsConnectionResponse,
  type OpsStatusResponse,
} from '../protocol.ts'
import { readString, writeError, writeJson, type RouteContext, type RouteSpec, type SkillHubRouteDeps } from './helpers.ts'

/** 执行体的固定路径（唯一真源，不在别处再拼一次）。 */
export function controlScriptPath(home?: string): string {
  return join(home ?? join(homedir(), '.dsh'), 'cloudflared', 'dsh-control.ps1')
}

/** 隧道 endpoint 的本地副本（两处任一存在即用）。 */
function endpointPaths(home?: string): string[] {
  const root = join(home ?? join(homedir(), '.dsh'), 'cloudflared')
  return [join(root, 'dsh-endpoint'), join(root, 'endpoint-repo', 'endpoint.txt')]
}

/** 最近一次成功的状态采样：失败时用它兜底，前端据此显示「上次成功 xx 秒前」。 */
interface StatusCache {
  value: OpsStatusResponse | null
  lastSuccessAt: number | null
}

export interface OpsRouteDeps extends SkillHubRouteDeps {
  /**
   * 当前是否有正在进行的 turn。
   *
   * 生产实现读 `ctx.agents`：`list()` 拿到所有活 Agent，对每个
   * `turnBoundaryOf(agent.session).openTurnStartSeq !== null` 即视为在跑。
   * 缺省（宿主没有 agents 服务）时返回 false —— 但这只影响「是否额外拦一次」，
   * 脚本侧仍会做同样的检查。
   */
  hasRunningTurn?: () => boolean
  /** 插件自身版本（状态卡显示）。 */
  pluginVersion?: () => string
  /** 冷却剩余秒数（由脚本的 status 报回，这里只做转发；测试可注入）。 */
  now?: () => number
  /**
   * Cordis 层热重载。
   *
   * 这是「热重载插件」按钮的**真实**执行路径：宿主 `ctx.hmr.reconcileProfile()`
   * 重新解析 profile 的插件层并替换活的 Cordis fiber，不重启进程。
   * 缺省（没有 hmr 服务）时退回脚本的 reload 子命令 —— 它只写一个请求标记，
   * 那不等于热重载本身，所以此时 message 会如实说明「未真正重载」。
   */
  reconcile?: () => Promise<{ reloaded: string[]; skipped: string[] } | undefined>
}

/** 执行 dsh-control.ps1，解析它 stdout 的那一行 JSON。 */
async function runControl(script: string, args: readonly string[], timeoutMs = 120_000): Promise<Record<string, unknown>> {  return await new Promise((resolve, reject) => {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已退出 */ }
      reject(new Error('dsh-control timed out after ' + timeoutMs + 'ms'))
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { err += chunk.toString('utf8') })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', () => {
      clearTimeout(timer)
      // stdout 只应有一行 JSON；PowerShell 的警告可能混进来，从第一个 { 截到最后一个 }。
      const start = out.indexOf('{')
      const end = out.lastIndexOf('}')
      if (start < 0 || end <= start) {
        reject(new Error('dsh-control produced no JSON. stdout=' + out.slice(0, 300) + ' stderr=' + err.slice(0, 300)))
        return
      }
      try {
        const parsed: unknown = JSON.parse(out.slice(start, end + 1))
        resolve(typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {})
      } catch (error) {
        reject(new Error('dsh-control returned unparseable JSON: ' + String(error)))
      }
    })
  })
}

/** 从 endpoint 本地副本读隧道地址（脚本读不到时的兜底）。 */
async function readEndpointFile(home?: string): Promise<string | null> {
  for (const path of endpointPaths(home)) {
    try {
      const text = (await readFile(path, 'utf8')).trim()
      if (text !== '') return text
    } catch { /* 下一个 */ }
  }
  return null
}

/** 把脚本的 status JSON 规范化成响应体。 */
function toStatus(raw: Record<string, unknown>, pluginVersion: string, at: number): OpsStatusResponse {
  const dsh = (raw.dsh ?? {}) as Record<string, unknown>
  const ingress = (raw.ingress ?? {}) as Record<string, unknown>
  const tunnel = (raw.tunnel ?? {}) as Record<string, unknown>
  const bundle = (raw.bundle ?? {}) as Record<string, unknown>
  return {
    ok: true,
    at,
    fresh: true,
    lastSuccessAt: at,
    dsh: {
      running: dsh.running === true,
      pid: typeof dsh.pid === 'number' ? dsh.pid : null,
      startedAt: typeof dsh.startedAt === 'string' ? dsh.startedAt : null,
    },
    ingress: {
      port: typeof ingress.port === 'number' ? ingress.port : 0,
      listening: ingress.listening === true,
    },
    tunnel: {
      address: typeof tunnel.address === 'string' ? tunnel.address : null,
      published: typeof tunnel.published === 'string' ? tunnel.published : null,
      healthy: tunnel.healthy === true,
      status: typeof tunnel.status === 'number' ? tunnel.status : 0,
      note: typeof tunnel.note === 'string' ? tunnel.note : null,
      processes: typeof tunnel.processes === 'number' ? tunnel.processes : 0,
    },
    bundle: {
      liveMtime: typeof bundle.liveMtime === 'string' ? bundle.liveMtime : null,
      repoMtime: typeof bundle.repoMtime === 'string' ? bundle.repoMtime : null,
      upToDate: bundle.upToDate === true,
    },
    cooldownRemainingSec: typeof raw.cooldownRemainingSec === 'number' ? raw.cooldownRemainingSec : 0,
    pluginVersion,
  }
}

/**
 * 状态卡的 handler。10 秒轮询由前端驱动；这里每次调用都真跑一次脚本。
 *
 * 采样失败**不清空旧值**：把上一次成功的快照原样返回，`fresh=false`、
 * `lastSuccessAt` 保留上次成功时刻，前端据此显示「上次成功 xx 秒前」。
 */
export function makeOpsStatusHandler(deps: OpsRouteDeps, cache: StatusCache) {
  const now = deps.now ?? Date.now
  return async (ctx: RouteContext): Promise<void> => {
    const at = now()
    const script = controlScriptPath(deps.home)
    try {
      const raw = await runControl(script, ['status', '-Actor', 'panel'], 45_000)
      const value = toStatus(raw, deps.pluginVersion?.() ?? '', at)
      // 脚本读不到地址时用本地 endpoint 副本兜底。
      if (value.tunnel.address === null) value.tunnel.address = await readEndpointFile(deps.home)
      cache.value = value
      cache.lastSuccessAt = at
      writeJson(ctx.res, 200, value)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (cache.value === null) {
        // 从未成功过：给一个明确的全空态，前端显示「不可用」而不是一片空白。
        const empty: OpsStatusResponse = {
          ok: false,
          at,
          fresh: false,
          lastSuccessAt: null,
          dsh: { running: false, pid: null, startedAt: null },
          ingress: { port: 0, listening: false },
          tunnel: { address: null, published: null, healthy: false, status: 0, note: null, processes: 0 },
          bundle: { liveMtime: null, repoMtime: null, upToDate: false },
          cooldownRemainingSec: 0,
          pluginVersion: deps.pluginVersion?.() ?? '',
          error: reason,
        }
        writeJson(ctx.res, 200, empty)
        return
      }
      writeJson(ctx.res, 200, { ...cache.value, at, fresh: false, lastSuccessAt: cache.lastSuccessAt, error: reason })
    }
  }
}

/** 动作 handler：restart 前查 turn、冷却转发、detached 202。 */
export function makeOpsActionHandler(deps: OpsRouteDeps) {
  return async (ctx: RouteContext): Promise<void> => {
    const action = readString(ctx.body, 'action') as OpsAction
    if (action !== 'reload' && action !== 'restart' && action !== 'tunnel-restart') {
      writeError(ctx.res, 400, 'unknown ops action: ' + action)
      return
    }

    // restart 的 turn 闸门：有对话在跑就拒绝，不排队。
    if (action === 'restart' && deps.hasRunningTurn?.() === true) {
      const body: OpsActionResponse = {
        ok: false,
        action,
        status: 409,
        message: '有对话在进行，先等它结束',
        rejectedReason: '有对话在进行，先等它结束',
      }
      writeJson(ctx.res, 409, body)
      return
    }

    // reload 走宿主真实的 Cordis 层热重载，不经过脚本的标记文件路径。
    if (action === 'reload' && deps.reconcile !== undefined) {
      try {
        const outcome = await deps.reconcile()
        const reloaded = outcome?.reloaded.length ?? 0
        const skipped = outcome?.skipped.length ?? 0
        const body: OpsActionResponse = {
          ok: true,
          action: 'reload',
          status: 200,
          message: '插件层已重新解析（重载 ' + reloaded + ' 项，跳过 ' + skipped + ' 项）；按 Ctrl+Shift+R 刷新界面',
        }
        writeJson(ctx.res, 200, body)
        return
      } catch (error) {
        // 热重载失败要说清是「重载失败」，不能伪装成成功。
        const reason = error instanceof Error ? error.message : String(error)
        writeJson(ctx.res, 500, {
          ok: false,
          action: 'reload',
          status: 500,
          message: '热重载失败：' + reason,
          rejectedReason: '热重载失败：' + reason,
        } satisfies OpsActionResponse)
        return
      }
    }

    const script = controlScriptPath(deps.home)
    const args = action === 'reload'
      ? ['reload', '-Actor', 'panel']
      : action === 'restart'
        ? ['restart', '-Actor', 'panel']
        : ['tunnel-restart', '-Actor', 'panel']

    try {
      const raw = await runControl(script, args, action === 'tunnel-restart' ? 150_000 : 60_000)
      const ok = raw.ok === true
      const cooldown = typeof raw.cooldownRemainingSec === 'number' ? raw.cooldownRemainingSec : undefined
      const address = typeof raw.address === 'string' ? raw.address : undefined
      const message = typeof raw.message === 'string' ? raw.message : (ok ? '已执行' : '执行失败')

      // restart 成功 = 已接受（脚本 detached，立刻返回）；回 202 让浏览器不必悬着。
      const status = action === 'restart' && ok ? 202 : ok ? 200 : 409
      const body: OpsActionResponse = {
        ok,
        action,
        status,
        message,
        ...(cooldown !== undefined ? { cooldownRemainingSec: cooldown } : {}),
        ...(address !== undefined ? { address } : {}),
        ...(ok ? {} : { rejectedReason: message }),
      }
      writeJson(ctx.res, status, body)
    } catch (error) {
      writeJson(ctx.res, 500, {
        ok: false,
        action,
        status: 500,
        message: error instanceof Error ? error.message : String(error),
        rejectedReason: error instanceof Error ? error.message : String(error),
      } satisfies OpsActionResponse)
    }
  }
}

/**
 * 连接信息 handler。
 *
 * token 默认遮罩：只有请求体显式 `revealToken: true` 才返回明文。明文只出现在
 * 这一个响应里，不写日志、不进遥测、不进状态卡。
 */
export function makeOpsConnectionHandler(deps: OpsRouteDeps) {
  return async (ctx: RouteContext): Promise<void> => {
    const reveal = ctx.body.revealToken === true
    const tunnelUrl = await readEndpointFile(deps.home)
    const token = await readDeviceToken()
    const body: OpsConnectionResponse = {
      ok: true,
      tunnelUrl,
      pairCode: await readPairCode(),
      deviceToken: token === null ? null : reveal ? token : maskToken(token),
      revealed: reveal && token !== null,
      ...(tunnelUrl === null ? { note: '隧道地址尚未发布' } : {}),
    }
    writeJson(ctx.res, 200, body)
  }
}

/** 遮罩：保留前 4 位与后 4 位，中间固定 8 个点（不泄露长度）。 */
export function maskToken(token: string): string {
  if (token.length <= 8) return '••••••••'
  return token.slice(0, 4) + '••••••••' + token.slice(-4)
}

/** 设备 token 的存放位置（宿主远程连接页写的那一份）。 */
async function readDeviceToken(): Promise<string | null> {
  const candidates = [
    join(homedir(), '.dsh', 'remote', 'device-token'),
    join(homedir(), '.dsh', 'device-token'),
  ]
  for (const path of candidates) {
    try {
      const text = (await readFile(path, 'utf8')).trim()
      if (text !== '') return text
    } catch { /* 下一个 */ }
  }
  return null
}

/** 配对码：宿主把当前配对码写在 remote/pair-code。 */
async function readPairCode(): Promise<string | null> {
  const candidates = [
    join(homedir(), '.dsh', 'remote', 'pair-code'),
    join(homedir(), '.dsh', 'pair-code'),
  ]
  for (const path of candidates) {
    try {
      const text = (await readFile(path, 'utf8')).trim()
      if (text !== '') return text
    } catch { /* 下一个 */ }
  }
  return null
}

/**
 * 构造三条 ops 路由。
 * @param deps - 路由依赖 + turn 查询 + 版本。
 * @returns 三条 RouteSpec（由 makeRoutes 统一包围栏）。
 */
export function opsRoutes(deps: OpsRouteDeps): RouteSpec[] {
  const cache: StatusCache = { value: null, lastSuccessAt: null }
  return [
    { path: SKILL_HUB_API.opsStatus, methods: ['GET'], handler: makeOpsStatusHandler(deps, cache) },
    { path: SKILL_HUB_API.opsAction, methods: ['POST'], handler: makeOpsActionHandler(deps) },
    { path: SKILL_HUB_API.opsConnection, methods: ['POST'], handler: makeOpsConnectionHandler(deps) },
  ]
}
