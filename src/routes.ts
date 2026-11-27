/**
 * The /api/skill-shelf route family: full catalog (enabled skills from the
 * official registry + hub-disabled skills + discovery diagnostics), skill
 * detail, enable/disable toggle, new-skill scaffold, user groups (tags +
 * origin collections), and upstream source tracking (check/sync/follow
 * upstream deletion into a restorable trash). Every route carries the host's
 * own `/api` trust fence (loopback, the listener's bind address, each
 * `--trusted-host` authority, then the browser session) — these endpoints
 * rename files under the user's skill roots, so they must never be laxer than
 * the GUI around them (issue #17).
 *
 * 按域拆分后的聚合入口：各域 handler 在 ./routes/<domain>.ts，共享围栏在
 * ./routes/helpers.ts，节流/任务状态在 ./routes/route-state.ts。
 * 老 `from './routes.ts'`（makeRoutes + SkillHubRouteDeps）保持可用。
 */

import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { SKILL_HUB_API_ROOT } from './protocol.ts'
import { createRoute, writeError, type SkillHubRouteDeps } from './routes/helpers.ts'
import { loopbackOnlyFence, type RouteFence } from './routes/http.ts'
import { catalogRoutes } from './routes/catalog.ts'
import { configRoutes } from './routes/config.ts'
import { marketRoutes } from './routes/market.ts'
import { repoImportRoutes } from './routes/repo-import.ts'
import { groupRoutes } from './routes/groups.ts'
import { sourceRoutes } from './routes/sources.ts'
import { foreignRoutes } from './routes/foreign.ts'
import { zipImportRoutes } from './routes/zip-import.ts'
import { usageRoutes } from './routes/usage.ts'
import { evolutionRoutes, unavailableEvolution, type EvolutionRouteDeps } from './routes/evolution.ts'
import { opsRoutes, type OpsRouteDeps } from './routes/ops.ts'

export type { SkillHubRouteDeps, SkillLookupLike } from './routes/helpers.ts'
export type { EvolutionRouteDeps } from './routes/evolution.ts'
export type { OpsRouteDeps } from './routes/ops.ts'
export { unavailableEvolution, lazyEvolution } from './routes/evolution.ts'
export type { RouteFence } from './routes/http.ts'

/**
 * Build the family's trust fence from the host's `/api` model.
 *
 * `ctx.connection.requestRejection` is the documented hook for fencing another
 * Web route; with no Connection service (a webserver-only composition, or a
 * unit test) the literal-loopback check stands in, so the fallback is the old
 * behaviour rather than an open route family.
 *
 * The service is read **per request**, not once at mount: plugins start in
 * composition order, so a one-shot read at `apply()` time would latch the
 * fallback whenever this plugin happens to come up before Connection. A
 * persistent absence is almost certainly an upstream composition change rather
 * than a transient startup order, so the first miss fires `onMissing` once —
 * without that signal the fallback would silently reproduce issue #17 after
 * any future upstream rename of the service.
 * @param read - resolves `ctx.connection`, or `undefined` when absent.
 * @param onMissing - called once, the first time the service reads absent.
 * @returns the fence every route in this family runs first.
 */
export function hostTrustFence(_read: () => HostConnectionHandle | undefined, onMissing?: () => void): RouteFence {
  // The hub routes are served by the local Desktop GUI on loopback only.
  // ctx.connection's source-filter API is version-fragile (requestRejection
  // removed in 0.2.3; admit() rejects same-origin GUI requests in some
  // compositions). A self-contained loopback check (remoteAddress + Host +
  // Origin) is correct here and has no cross-version coupling.
  let missingReported = false
  return (request) => {
    if (!missingReported) { missingReported = true; onMissing?.() }
    return loopbackOnlyFence(request)
  }
}

/**
 * Build every /api/skill-shelf route.
 * @param deps - skill registry view + sidecar store + trust fence.
 * @returns the exact-path routes plus the family's 404 catch-all.
 */
export function makeRoutes(deps: SkillHubRouteDeps, evolution?: EvolutionRouteDeps, ops?: OpsRouteDeps): WebRoute[] {
  // 各域返回裸 spec，统一在这里包上请求围栏（信任栅栏 → 方法 → 总开关
  // → JSON 体 → 统一错误映射），新路由不会漏掉围栏。
  const specs = [
    ...catalogRoutes(deps),
    ...configRoutes(deps),
    ...marketRoutes(deps),
    ...repoImportRoutes(deps),
    ...groupRoutes(deps),
    ...sourceRoutes(deps),
    ...foreignRoutes(deps),
    ...zipImportRoutes(deps),
    ...usageRoutes(deps),
    ...evolutionRoutes(deps, evolution ?? unavailableEvolution()),
    // 「运行与连接」：状态卡 + 三个动作 + 连接信息。执行体只有 dsh-control.ps1。
    ...opsRoutes(ops ?? { ...deps }),
    // 进化路由始终存在（否则「声明了没注册」的漂移检测会报警）；
    // 执行器缺失时它们回空队列，面板不需要区分「路由不存在」与「功能不可用」。
  ]
  return [
    ...specs.map((spec) => createRoute(deps, spec)),
    // 兜底：本族的未知路径。插件只注册精确路径，未命中的请求会落到宿主的
    // SPA fallback，那里对 /api/* 统一回 401，排查时极易被误判成鉴权/令牌
    // 问题，而真实原因是路径写错。这个 prefix 路由把整族纳入命名路由表，
    // 于是未知路径在宿主侧变成「已命中」→ 由我们回一个写明路径的 404。
    // 匹配顺序保证安全：宿主先查精确表、再按最长前缀命中，本路由不可能
    // 抢走任何已注册的精确路由。
    createRoute(deps, {
      kind: 'prefix',
      path: SKILL_HUB_API_ROOT,
      methods: ['GET', 'POST'],
      skipGate: true,
      // 不写盘，且它的价值就是「告诉你路径写错了」：被缺头拦成 403 会把
      // 拼写问题误导成鉴权问题，正是这条兜底要消除的误判。
      skipCsrf: true,
      handler: async ({ res, url }) => {
        writeError(res, 404, 'unknown skill-hub route: ' + url.pathname)
      },
    }),
  ]
}
