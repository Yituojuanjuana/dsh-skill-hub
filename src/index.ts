/**
 * dsh-skill-shelf — host half. Mounts the /api/skill-shelf route family (full
 * skill catalog from the official ctx.skills registry, skill detail,
 * enable/disable toggle, new-skill scaffold) plus a system-prompt
 * announcement. The browser half (./client) renders the sidebar entry and
 * the skill shelf panel. Everything rides official NPM SDK packages — no dsh
 * source changes.
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import type { SkillProviderControl } from '@deepseek-ai/dsh-skill'
import type { SettingsForms, SettingsNamespace, SettingsPathOp } from '@deepseek-ai/dsh-settings'
// dsh's own fork, NOT the plain `schemastery` package: `.volatile()` (and the
// loader's `fiber.runtime.Config` handling) only exist here. Every official
// plugin imports it under this name.
import z from '@deepseek-ai/schemastery'
// Type-only, for the `ctx.connection` augmentation (the `/api` trust fence).
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-settings'
import { CONFIG_FIELDS, HUB_CONFIG_DEFAULTS, HUB_ENTRY_ID, HEX_COLOR_RE, resolveHubConfig, type HubConfig } from './protocol.ts'
import { SkillHubProvider } from './provider.ts'
import { hostTrustFence, lazyEvolution, makeRoutes } from './routes.ts'
import { wireEvolution, routeFromContext } from './evolution/wiring.ts'
import { BUSINESS_WORKSPACE_HINTS } from './evolution/engine.ts'
import { workspaceEntries } from './routes/catalog-data.ts'
import { SkillHubStore } from './store.ts'
import { migrateRenamedDisabledSkills, reconcileDisabledSkills, pruneStaleDisabledSkills, pruneStaleTrash } from './reconcile.ts'
import { cleanupLeftoverImportDirs, setGithubToken } from './repo.ts'
import { dshHome } from './store/paths.ts'
import { createSkillCallHandler, type SessionLikeEvent } from './counter/recorder.ts'
import { appendEntry, readLedger } from './counter/ledger.ts'
import { aggregate } from './counter/aggregate.ts'
import { backfillFromSessionLogs } from './counter/backfill.ts'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { homedir } from 'node:os'

/** Stable cordis plugin name (matches cordis.patch.yml insert id). */
export const name = 'skill-shelf'

/**
 * Services required before the skill-shelf surfaces can mount. `settings` is deliberately NOT here: the plugin reads its own volatile config refs and only reaches for the settings service when it is present (issue #11).
 *
 * `webServer` is deliberately NOT here either. It only exists in the web
 * profile (`dsh-base` + `dsh-web-app`); declaring it required makes the plugin
 * sit in `pending (waiting for service: webServer)` forever in the headless /
 * acp / sdk profiles, and the host reports `1 entry did not activate` — on a
 * bare `dsh-base` profile that escalates to `plugin tree failed to load`.
 * HTTP routes are registered conditionally instead (see the routes effect).
 */
export const inject = ['skills', 'systemPrompt']

/**
 * Plugin config, validated by the same-named schemastery schema.
 *
 * dsh 0.1.7 replaced the "plugin registers a settings namespace" model with
 * "the Loader entry's Config IS the settings namespace", so this one schema is
 * both the composition config and the settings page. Every field is volatile:
 * the Loader re-resolves volatile values in place and re-enters apply()
 * instead of rebuilding the fiber, and only volatile fields are writable
 * through the settings transport.
 */
export interface Config {
  /** When true (default), a system-prompt section announces the hub to every agent. */
  announceToAgent: Volatile<boolean>
  /** Master switch for the plugin (routes, prompt section). */
  enabled: Volatile<boolean>
  /** Show per-skill invocation count chip. Default true. */
  showUseCount: Volatile<boolean>
  /** Show per-skill last-used relative time. Default true. */
  showUseTime: Volatile<boolean>
  /** Show group-header usage summaries (count + last used). Default true. */
  showGroupSummary: Volatile<boolean>
  /** 侧边栏是否显示技能书架入口。Default true。 */
  showSidebarCard: Volatile<boolean>
  /** 模型可调圆点颜色（#rrggbb）；缺省用面板默认色。 */
  dotModelColor: Volatile<string | undefined>
  /** 用户可调圆点颜色（#rrggbb）；缺省用面板默认色。 */
  dotUserColor: Volatile<string | undefined>
  /** GitHub token；`role('secret')` 让 settings 层统一脱敏，缺省为匿名。 */
  githubToken: Volatile<string | undefined>
  /** 技能进化：对话结束后在后台复盘并提出技能建议。默认关闭。 */
}

/**
 * The durable field schemas, plain (non-volatile) so the same definitions can
 * back both the live view below and the wire form the settings page renders
 * from `.toJSON()`. `description` is what the auto-generated page shows with
 * each row; `role('secret')` makes the settings layer redact the value on
 * every wire read.
 */
const ConfigFields = {
  enabled: z.boolean().default(HUB_CONFIG_DEFAULTS.enabled).description('关闭后技能书架的路由、入口与公告全部下线。'),
  announceToAgent: z.boolean().default(HUB_CONFIG_DEFAULTS.announceToAgent).description('在系统提示中加入本插件说明，用户提到技能管理时 Agent 知道如何协作。'),
  dotModelColor: z.string().pattern(HEX_COLOR_RE).description('技能行与聊天「/」菜单中「模型可调」圆点的颜色（#rrggbb）。'),
  dotUserColor: z.string().pattern(HEX_COLOR_RE).description('技能行与聊天「/」菜单中「仅用户可调」圆点的颜色（#rrggbb）。'),
  showUseCount: z.boolean().default(HUB_CONFIG_DEFAULTS.showUseCount).description('在技能名旁显示调用次数。'),
  showUseTime: z.boolean().default(HUB_CONFIG_DEFAULTS.showUseTime).description('在技能名行显示最近调用时间。'),
  evolution: z.boolean().default(HUB_CONFIG_DEFAULTS.evolution).description('启用技能进化元代理：分析历史轨迹，产出新建/优化提案（只提案，落地需人工审核）。'),
  showGroupSummary: z.boolean().default(HUB_CONFIG_DEFAULTS.showGroupSummary).description('在分组标题后汇总调用次数与最近调用时间。'),
  showSidebarCard: z.boolean().default(HUB_CONFIG_DEFAULTS.showSidebarCard).description('在左侧栏显示「技能书架」入口卡片；关闭后侧边栏不再出现该入口（设置页里仍可打开面板）。'),
  githubToken: z.string().role('secret').description('市场/来源走 GitHub API：匿名每小时 60 次，填 token 后 5000 次。留空即匿名（或跟随 GITHUB_TOKEN 环境变量）。'),
}

/**
 * The live plugin config the settings page edits. Field order here is the row
 * order the auto-generated page renders.
 */
export const Config = z.object({
  enabled: ConfigFields.enabled.volatile(),
  announceToAgent: ConfigFields.announceToAgent.volatile(),
  dotModelColor: ConfigFields.dotModelColor.volatile(),
  dotUserColor: ConfigFields.dotUserColor.volatile(),
  showUseCount: ConfigFields.showUseCount.volatile(),
  showUseTime: ConfigFields.showUseTime.volatile(),
  showGroupSummary: ConfigFields.showGroupSummary.volatile(),
  showSidebarCard: ConfigFields.showSidebarCard.volatile(),
  evolution: ConfigFields.evolution.volatile(),
  githubToken: ConfigFields.githubToken.volatile(),
})

/**
 * The settings namespace this plugin's config lives under, narrowed to the
 * settings package's branded type. The browser half resolves the same form
 * through `ctx.configForms.get(HUB_ENTRY_ID)`.
 */
export const ENTRY_ID = HUB_ENTRY_ID as SettingsNamespace

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 152

/**
 * The host's scoped duplicate-name rejection, thrown by dsh-skill's
 * `SkillLayer` / `NamedEntries` when a layer already holds a provider under
 * the same name. Only the scoped variant is matched — the unscoped one comes
 * from the global layer and means something genuinely different.
 */
function isDuplicateProviderError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('already registered in this scope')
}

/**
 * Register the hub's provider once more into every live agent's own skill
 * layer, and keep following agents as they come and go.
 *
 * Why a second registration is REQUIRED for invocation overrides: an agent's
 * skill catalog comes from the preset layer's own filesystem provider, which
 * is nearer than the global layer. dsh-skill merges layers in order and the
 * LAST write of a duplicate name wins, so a global-layer override can never
 * outrank it — the override entry must exist in a layer nearer than the
 * preset's. Registering the same shared instance per agent does exactly that
 * (the shared instance keeps a single watch timer; only the per-layer
 * controls differ, and each control invalidates its own layer's cache).
 *
 * Everything is defensive: the host may expose none of `ctx.on` / `ctx.get`,
 * an agent may carry no skills service, and the event names may change —
 * in every case this degrades to "no agent-layer override" (the global
 * catalog still applies it) instead of breaking the plugin load.
 *
 * The returned disposer MUST be bound to the plugin fibre by the caller
 * (`ctx.effect`). Unlike the global layer, an agent layer outlives a plugin
 * reload — the host replays the profile in-process while agents stay alive —
 * so a registration released only on `agent/disposed` or the next `sync()`
 * survives its fibre and makes the replaying fibre throw "already registered
 * in this scope" (issue #24).
 *
 * That leak is also why a duplicate rejection is swallowed rather than thrown
 * (see `install`): the fibre being unloaded during a self-update is the *old*
 * one, so on the upgrade out of 0.3.36 or earlier the conflict is guaranteed
 * no matter what this version does on teardown. Failing here would roll the
 * update back and make the fix impossible to install.
 */
function registerAgentSkillPolicy(
  ctx: Context,
  ensureProvider: (control: SkillProviderControl) => SkillHubProvider,
): () => void {
  interface AgentLike {
    id?: unknown
    ctx?: unknown
  }
  type AgentEvent = { agent?: AgentLike }
  type SkillsLike = { registerProvider?: (factory: (control: SkillProviderControl) => SkillHubProvider) => (() => void) | undefined }
  const host = ctx as unknown as {
    on?: (event: string, listener: (payload: AgentEvent) => void) => (() => void) | undefined
    get?: (key: string) => unknown
  }
  if (typeof host.on !== 'function') {
    ctx.logger.warn('[dsh-skill-shelf] ctx.on unavailable: agent-layer invocation overrides are disabled (global catalog still applies them)')
    return () => {}
  }
  const disposers = new Map<string, () => void>()

  const install = (agent: AgentLike | undefined): void => {
    if (agent === undefined || typeof agent.id !== 'string' || disposers.has(agent.id)) return
    const agentCtx = agent.ctx as { get?: (key: string) => unknown; skills?: unknown } | undefined
    const skills = (agentCtx !== undefined && typeof agentCtx.get === 'function'
      ? agentCtx.get('skills')
      : agentCtx?.skills) as SkillsLike | undefined
    if (skills === undefined || typeof skills.registerProvider !== 'function') {
      ctx.logger.warn('[dsh-skill-shelf] agent layer has no skills service; skipping agent-layer registration for ' + String(agent.id))
      return
    }
    const id = agent.id
    let dispose: (() => void) | undefined
    try {
      dispose = skills.registerProvider((control) => ensureProvider(control))
    } catch (error) {
      // Versions up to 0.3.36 kept the agent-layer registration in a plain map
      // that a fibre teardown never released (issue #24). A market
      // self-update replays the profile in-process, so the OLD — unfixed —
      // fibre is the one that just died and its "skill-shelf" registration is
      // still there; the host rejects ours as a scoped duplicate.
      //
      // This must never bubble: a failed entry activation makes reloadProfile
      // roll the whole update back, which would leave users permanently unable
      // to install the version that fixes it. Skipping this one agent layer is
      // harmless — the leaked provider instance serves the same store, so
      // invocation overrides still resolve; the next process start has no
      // leaked registration at all.
      if (isDuplicateProviderError(error)) {
        ctx.logger.warn(
          '[dsh-skill-shelf] agent layer ' + id + ' already holds a skill-shelf provider left by the previous version; skipping agent-layer override until the next restart',
        )
        return
      }
      throw error
    }
    if (dispose !== undefined) {
      // Idempotent: releasing drops the bookkeeping entry FIRST, so a later
      // teardown pass cannot dispose the same registration twice, and a
      // re-install for the same agent is never blocked by a stale entry
      // (issue #24).
      const release = (): void => {
        if (disposers.get(id) !== release) return
        disposers.delete(id)
        dispose()
      }
      disposers.set(id, release)
      ctx.logger.info('[dsh-skill-shelf] invocation-override provider registered into agent layer ' + id)
    }
  }
  const uninstall = (agent: AgentLike | undefined): void => {
    if (agent === undefined || typeof agent.id !== 'string') return
    // `release` removes itself from the map, so no manual delete here.
    disposers.get(agent.id)?.()
  }

  const stopCreated = host.on('agent/created', (payload) => install(payload.agent))
  const stopDisposed = host.on('agent/disposed', (payload) => uninstall(payload.agent))
  const agents = typeof host.get === 'function' ? host.get('agents') : undefined
  if (agents !== undefined && typeof (agents as { list?: unknown }).list === 'function') {
    for (const agent of (agents as { list: () => AgentLike[] }).list()) install(agent)
  }

  return () => {
    if (stopCreated !== undefined) stopCreated()
    if (stopDisposed !== undefined) stopDisposed()
    // Snapshot: each `release` deletes itself from the map while iterating.
    for (const release of [...disposers.values()]) release()
    disposers.clear()
  }
}

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const SKILL_HUB_GUIDANCE =
  "本机已安装 dsh-skill-shelf 插件（DSH Web GUI 技能书架）：管理主页在 设置 →「技能书架」（通用 / 工作区 / 市场 / 回收站），配置卡片在插件管理页（折叠，点标题展开）。能力：全量技能目录的浏览与搜索（项目 / 用户 / 内置及第三方）、按来源 / 目录 / 角色整组启停、市场安装、来源跟踪与同步、跨 agent 与 ZIP 导入、调用统计、诊断与内容审计。限制：只有用户级技能能写能删；所有开关都只写 sidecar 覆盖（关闭模型自动调用，「/技能名」仍可用，源文件不动），内置与运行时技能只读，即时生效无需重启。用户提到「技能管理 / 技能列表 / 技能开关 / 技能同步 / 技能市场 / 更新技能 / 新建技能」时即指本插件，请据此协作。"

/**
 * Mount the skill shelf routes and announcement.
 * @param ctx - host plugin context carrying webServer/skills/systemPrompt/settings.
 */
export function apply(ctx: Context, config?: Config): void {
  /**
   * Read the runtime config out of our own volatile config refs.
   *
   * This is the whole point of `volatile()`: the Loader updates those values
   * **in place** (`ConfigEditor.edit` → `resolveConfig(fiber.runtime, next)` →
   * `updateVolatile`) without rebuilding the fiber, so a held reference always
   * answers `.get()` with the current value. Consequences worth remembering:
   *   - no `settings.describe()` per request (it walks and projects every entry
   *     in the profile — the reason this used to be slow);
   *   - no subscription or watcher is needed for *reading*;
   *   - the plugin keeps working when the Settings service is absent
   *     (issue #11: business logic must not depend on Settings).
   */
  const readConfig = (): Partial<HubConfig> => {
    const out: Record<string, unknown> = {}
    for (const field of CONFIG_FIELDS) {
      const ref = (config as unknown as Record<string, { get?: () => unknown } | undefined> | undefined)?.[field]
      const value = ref !== undefined && typeof ref.get === 'function' ? ref.get() : ref
      if (value !== undefined) out[field] = value
    }
    return out as Partial<HubConfig>
  }
  const current = (): HubConfig => resolveHubConfig(readConfig())

  /** The Settings service, when this deployment mounts it. Absent ⇒ no user layer to read or write. */
  const settingsOf = (): SettingsForms | undefined => ctx.get('settings') as SettingsForms | undefined

  const store = new SkillHubStore()
  let disposeRoutes: (() => void) | undefined
  let disposeSection: (() => void) | undefined
  /** 技能进化元代理的接线；配置变化时重建。 */
  let evolutionWiring: ReturnType<typeof wireEvolution> | undefined
  /** 等 `sessionQuery`/`llm` 就绪的那个 fiber；重建时先拆它。 */
  let evolutionFiber: { dispose: () => unknown } | undefined
  // The hub's own provider contributes user/project skills to the registry's
  // GLOBAL layer — the web app deliberately keeps that layer empty (presets
  // own per-scope discovery), and the GUI needs a session-independent view.
  let disposeProvider: (() => void) | undefined
  // The SAME provider instance is registered once more into every live agent's
  // own skill layer (nearer than the preset layer) so an invocation override
  // can outrank the preset's native filesystem provider — see
  // registerAgentSkillPolicy below.
  let disposeAgentProviders: (() => void) | undefined
  let providerInstance: SkillHubProvider | undefined
  /** One control per skill layer (global + each live agent): an override change must invalidate all of them. */
  const providerControls = new Set<SkillProviderControl>()

  /** Legacy settings namespace used before the dsh-skill-shelf rename. */
  const LEGACY_ENTRY_ID = HUB_ENTRY_ID.replace('skill-shelf', 'skill-hub') as SettingsNamespace

  // The raw saved config layer (fields the user explicitly overrode); the
  // config route reports it so callers can mark overridden fields. Empty when
  // the deployment has no Settings service — the plugin still runs.
  //
  // 改名迁移：新命名空间 `skill-shelf` 优先；它还没有用户覆盖时回退读旧
  // 命名空间 `skill-hub`，并把旧值复制进新命名空间（旧值不删）。
  const saved = (): Partial<HubConfig> => {
    const describe = settingsOf()?.describe()
    const find = (ns: SettingsNamespace): Record<string, unknown> | undefined =>
      describe?.find((entry) => entry.ns === ns)?.user as Record<string, unknown> | undefined
    const next = find(ENTRY_ID)
    if (next !== undefined && Object.keys(next).length > 0) return next as Partial<HubConfig>
    const legacy = find(LEGACY_ENTRY_ID)
    if (legacy !== undefined && Object.keys(legacy).length > 0) {
      // 只复制，不删旧值；写回新命名空间由 settings.mutate 完成。
      void settingsOf()?.mutate(ENTRY_ID, Object.entries(legacy).map(([path, value]) => ({ op: 'set' as const, path: [path], value })))
        .then(() => logInfo('[dsh-skill-shelf] migrated settings namespace ' + LEGACY_ENTRY_ID + ' -> ' + ENTRY_ID + ' (legacy kept)'))
        .catch((error: unknown) => logWarn('[dsh-skill-shelf] settings namespace migration failed (legacy kept)', error))
      return legacy as Partial<HubConfig>
    }
    return (next as Partial<HubConfig> | undefined) ?? {}
  }

  // Persist a config patch through the settings transport. A patch value of
  // undefined clears the saved override — expressed as a path `unset`, which
  // makes the field fall back to its inherited value instead of writing a
  // literal undefined (the old sidecar's reset semantics). The write reloads
  // this Loader entry, so apply() re-runs and re-syncs every surface below.
  const updateConfig = async (patch: Partial<HubConfig>): Promise<HubConfig> => {
    const ops: SettingsPathOp[] = []
    for (const [field, value] of Object.entries(patch)) {
      if (value === undefined) ops.push({ op: 'unset', path: [field] })
      else ops.push({ op: 'set', path: [field], value })
    }
    const settings = settingsOf()
    if (settings === undefined) throw new Error('this deployment does not mount the settings service; config is read-only')
    if (ops.length > 0) {
      await settings.mutate(ENTRY_ID, ops)
      // A settings write updates this entry's values in place WITHOUT
      // re-entering apply() (see `current`), so the section / provider / routes
      // registered from the old values would otherwise keep serving them until
      // a restart. Re-evaluate here, where we know the write landed.
      sync()
    }
    return current()
  }

  // Register (or drop) every surface to match the current config. Each
  // group is kept under one disposer: re-registering first tears the old
  // one down so duplicate-name registrations never throw. The route family
  // (including the config route) stays mounted even with the master switch
  // off so the settings card can always read and re-enable the hub; the
  // business routes answer 503 while disabled.
  /**
   * Whether this plugin's fiber is still mounted.
   *
   * Async work started from `apply()` — the stats wiring and the persistence
   * probe — can settle after the fiber unloaded: a config rewrite reloads the
   * plugin, and disable/enable tears it down. Service reads on an inactive
   * context throw instead of returning undefined, so every continuation
   * re-checks this before touching `ctx` (issue #19: a cold-start abort with
   * `cannot get required service "systemPrompt" in inactive context`).
   *
   * The generation counters cannot cover this: they only invalidate a build
   * superseded by a *newer* build, and teardown does not bump them.
   */
  const mounted = (): boolean => {
    // `fiber` has always been public on a Cordis context, but stay tolerant of
    // a host whose Cordis predates it: absent means "we cannot tell", and the
    // pre-#19 behaviour is the safer answer there.
    const fiber = (ctx as { fiber?: { uid: number | null } }).fiber
    return fiber === undefined || fiber.uid !== null
  }

  /** Logger for continuations that may outlive the fiber (#19). */
  const logInfo = (message: string): void => {
    if (mounted()) ctx.logger.info(message)
  }
  const logWarn = (message: string, error?: unknown): void => {
    if (!mounted()) return
    if (error === undefined) ctx.logger.warn(message)
    else ctx.logger.warn(message, error)
  }

  const sync = (): void => {
    // A late stats continuation may still reach here after teardown (#19).
    if (!mounted()) return
    if (disposeSection !== undefined) {
      disposeSection()
      disposeSection = undefined
    }
    if (disposeProvider !== undefined) {
      disposeProvider()
      disposeProvider = undefined
    }
    if (disposeAgentProviders !== undefined) {
      disposeAgentProviders()
      disposeAgentProviders = undefined
    }
    providerInstance = undefined
    const value = current()
    // GitHub auth for market/source API calls: env GITHUB_TOKEN/GH_TOKEN is the
    // fallback (read at module load); an explicit settings value wins and is
    // applied by re-running this sync from updateConfig after the write lands.
    setGithubToken(value.githubToken)
    if (value.announceToAgent) {
      disposeSection = ctx.systemPrompt.section({
        name: 'plugin:dsh-skill-shelf',
        order: SECTION_ORDER,
        text: SKILL_HUB_GUIDANCE,
      })
    }
    if (value.enabled) {
      // registerProvider returns the exact cordis effect disposer: the fiber
      // unregisters the provider and invalidates catalog caches on teardown.
      providerControls.clear()
      providerInstance = undefined
      const overrides = async (): Promise<ReadonlySet<string>> => new Set(await store.listInvocationOverrides())
      // 惰性创建：global 与各 agent 层的 factory 共享同一实例（watch 定时器
      // 只起一个），但每个注册的 control 都收进集合 —— override 变化必须
      // 让所有层的缓存一起失效，只刷 global 会让 agent 视角仍旧看到旧状态。
      const ensureProvider = (control: SkillProviderControl): SkillHubProvider => {
        providerControls.add(control)
        if (providerInstance === undefined) {
          // global 层 = 管理面板视角：并入外部 Agent 技能根，一处看全本机技能。
          providerInstance = new SkillHubProvider(control, dshHome(), overrides, undefined, true)
        }
        return providerInstance
      }
      disposeProvider = ctx.effect(
        () => ctx.skills.registerProvider((control) => ensureProvider(control)),
        'dsh-skill-shelf: provider',
      )
      // Must be fibre-bound like the global provider above: a market
      // self-update replays the profile in-process, the old fibre is torn
      // down while agents stay alive, and an agent-layer registration that
      // outlived its fibre would make the new fibre's registerProvider throw
      // "already registered in this scope" — the update then rolls back
      // (issue #24).
      //
      // agent 层**不并入外部根**：这一层比 preset 更近，把别的 agent 的技能
      // 塞进来会遮蔽 preset 原生技能，而它们又不可写——结果就是「面板看得见、
      // 模型调不动」。agent 层只服务 dsh 自己的根（用于 invocation 覆盖）。
      const ensureAgentProvider = (control: SkillProviderControl): SkillHubProvider => {
        providerControls.add(control)
        return new SkillHubProvider(control, dshHome(), overrides, undefined, true)
      }
      disposeAgentProviders = ctx.effect(() => {
        const dispose = registerAgentSkillPolicy(ctx, ensureAgentProvider)
        return () => {
          dispose()
        }
      }, 'dsh-skill-shelf: agent providers')
    }
    if (disposeRoutes !== undefined) {
      disposeRoutes()
      disposeRoutes = undefined
    }
    // 路由必须等 `webServer` 真的就绪后再注册。
    //
    // 旧写法在 `ctx.effect` 里一次性 `ctx.get('webServer')`：插件按组合顺序启动，
    // 它很可能比 webServer 先起来，于是读到 undefined、打一行日志就永远放弃，
    // 而 fiber 仍显示 active——界面上就是整个 /api/skill-shelf 族返回 404。
    // `ctx.inject` 是官方的「等服务就绪再跑」入口：服务永远不到的
    // 非 web profile 里回调根本不执行，也就不会拖住启动。
    disposeRoutes = ctx.effect(
      () => {
        const fiber = ctx.inject(['webServer'], (injected) => {
          const webServer = injected.get('webServer')
          if (webServer === undefined) return
          // 技能进化元代理的接线。
  //
  // 用 `ctx.inject` 等服务就绪：插件可能比 session-query / llm 先起来，一次性
  // `ctx.get` 会把 undefined 锁死，进化就永远走不可用分支。
  // 配置变化会重跑 sync，所以旧 fiber 先拆，避免堆出一排执行器。
  if (evolutionFiber !== undefined) {
    void evolutionFiber.dispose()
    evolutionFiber = undefined
  }
  if (evolutionWiring !== undefined) {
    evolutionWiring.dispose()
    evolutionWiring = undefined
  }
  evolutionFiber = ctx.inject(['sessionQuery', 'llm'], (injected) => {
    const sessionQuery = injected.get('sessionQuery')
    const llm = injected.get('llm')
    // 诊断探针：把「注入回调有没有跑到、两个服务在不在」写到磁盘。
    // 进化不可用只有一种原因（服务缺失），但「服务缺失」与「注入回调根本没
    // 触发」在界面上长得一模一样，靠这段文件就能一眼分开。
    try {
      writeFileSync(join(dshHome(), 'skill-usage-manager', 'evolution-probe.json'), JSON.stringify({
        injected: true,
        sessionQuery: sessionQuery !== undefined,
        llm: llm !== undefined,
        at: Date.now(),
      }, null, 2), 'utf8')
    } catch { /* 诊断写入失败不影响插件 */ }
    if (sessionQuery === undefined || llm === undefined) return
    evolutionWiring = wireEvolution({
      sessionQuery: sessionQuery as never,
      llm: llm as never,
      // 储备函数，不是值：启动时还没有任何请求。
      route: () => routeFromContext(ctx),
      listSkills: async () => {
        const snapshot = await ctx.skills.snapshot()
        return snapshot.skills.map((skill) => ({ name: skill.name, description: skill.description }))
      },
      // 反思需要看正文（步骤冗余 / 校验缺失），所以带上。
      readSkillBody: async (name: string) => {
        const skill = await ctx.skills.get(name).catch(() => undefined)
        return skill?.content
      },
      // 归属目录：与通用页「按目录」视图同一套分类（DSH / 公共 Agent / Trae …）。
      readSkillSource: async (name: string) => {
        const skill = await ctx.skills.get(name).catch(() => undefined)
        return skill?.source
      },
      // 统计维度 ①：技能运行指标（历史调用量 / 近 7 天 / 成功率）。
      //
      // 成功率由账本条目算出；账本只记调用不记结果时省略该字段 ——
      // 不能用 0 冒充「全失败」。
      listUsage: async () => {
        try {
          const { entries } = await readLedger(join(dshHome(), 'skill-usage-manager', 'usage-ledger.jsonl'))
          const aggregated = aggregate(entries, Date.now())
          return [...aggregated.entries()].map(([name, value]) => ({
            name,
            total: value.total,
            week: value.week,
            lastUsed: value.lastUsed,
            ...value.successRate === undefined ? {} : { successRate: value.successRate },
          }))
        } catch {
          return []
        }
      },
      // 统计维度 ②：回收站元数据（是否在回收站、移入时间、备注）。
      listTrash: async () => {
        try {
          const entries = await store.listTrash()
          return entries.map((entry) => ({
            name: entry.name,
            movedAt: entry.movedAt,
            ...typeof entry.note === 'string' && entry.note !== '' ? { note: entry.note } : {},
          }))
        } catch {
          return []
        }
      },
      // 落地新技能后让 provider 重建发现结果，工作区页才能立刻看到它。
      invalidate: () => {
        for (const control of providerControls) control.invalidate()
      },
      // 旧提案兜底：从已登记工作区里找业务工作区（sports-coach 等）。
      guessBusinessWorkspace: async () => {
        const entries = await workspaceEntries(dshHome())
        const hit = entries.find((entry) => BUSINESS_WORKSPACE_HINTS.some((hint) => entry.path.toLowerCase().includes(hint.toLowerCase())))
        return hit?.path
      },
      enabled: () => current().evolution === true,
      log: logInfo,
    })
    return () => { evolutionWiring?.dispose(); evolutionWiring = undefined }
  })

  const disposers = makeRoutes({
            skills: ctx.skills,
            store,
            // The host's own `/api` trust fence (loopback ∪ bind address ∪
            // --trusted-host ∪ browser session). Read per request: Connection
            // may be provided after this plugin starts, and a one-shot read here
            // would latch the literal-loopback fallback for the whole process.
            fence: hostTrustFence(
              () => ctx.get('connection'),
              () => ctx.logger.warn('[dsh-skill-shelf] Connection service absent: routes fall back to literal-loopback; reverse-proxy deployments will 403 until it mounts'),
            ),
            invalidate: () => {
              for (const control of providerControls) control.invalidate()
            },
            config: current,
            saved,
            updateConfig,
            // 当前对话的工作区：给「工作区」页预选默认项。
            //
            // 服务按请求现取（`ctx.get`），因为插件可能比 session-query 先起来；
            // 取不到就返回 undefined，前端退回「全部工作区」而不是报错。
            currentWorkspace: async () => {
              const query = ctx.get('sessionQuery') as { listSessions?: () => Promise<Array<{ header?: { cwd?: unknown } }>> } | undefined
              if (query?.listSessions === undefined) return undefined
              try {
                const sessions = await query.listSessions()
                for (const record of sessions) {
                  const cwd = record.header?.cwd
                  if (typeof cwd === 'string' && cwd !== '') return cwd
                }
              } catch {
                // 读不到会话不影响面板，前端会退回「全部工作区」。
              }
              return undefined
            },
          }, lazyEvolution(() => evolutionWiring?.routes)).map((route) => webServer.register(route))
          // 回调返回的是这个内层 fiber 的清理函数。
          return () => {
            for (const dispose of disposers) dispose()
          }
        })
        return () => {
          void fiber.dispose()
        }
      },
      'dsh-skill-shelf: routes',
    )
  }

  // Initial registration from the composition entry. Later changes — the
  // settings page, the config route, the Host document editor — rewrite this
  // Loader entry, which re-enters apply(), so no in-process watcher is needed.
  sync()

  // Permanent skill-invocation counter: subscribe to post-commit session events
  // and append each skill call to the durable ledger. Task 0 verified that
  // `session/event` listeners receive TWO arguments (session, event) and that
  // the event object shape is {type, seq, time, data}; the SECOND argument is
  // the event. Registering onSkillCall directly would wrongly treat the session
  // as the event. The effect binds the listener's disposer to this fibre.
  ctx.effect(() => {
    const ledgerFile = join(dshHome(), 'skill-usage-manager', 'usage-ledger.jsonl')
    const onSkillCall = createSkillCallHandler(ledgerFile)
    const off = ctx.on('session/event', (_session, sessionEvent) => {
      // Cordis types `sessionEvent` as its own SessionEvent union; the recorder
      // only needs {type, time, data}. Normalise via unknown to bridge the two.
      void onSkillCall(sessionEvent as unknown as SessionLikeEvent)
    })
    return () => off()
  }, 'dsh-skill-shelf: skill call recorder')

  // 历史回填：账本从安装那一刻才开始记，之前的调用不在里面。启动后扫一次
  // 已有会话日志，把 (name, ts) 尚未入账的调用补进去。幂等，重复启动不会重复计数；
  // 异步执行且失败只记日志，绝不阻塞插件启动。
  void (async () => {
    try {
      const ledgerFile = join(dshHome(), 'skill-usage-manager', 'usage-ledger.jsonl')
      const { entries } = await readLedger(ledgerFile)
      const sessionsRoot = join(dshHome(), 'sessions')
      const result = await backfillFromSessionLogs(sessionsRoot, entries, (entry) => appendEntry(ledgerFile, entry))
      if (result.appended > 0) {
        logInfo(`[dsh-skill-shelf] backfilled ${result.appended} historical skill call(s) from ${result.files} session log(s)`)
      }
    } catch (error) {
      logWarn('[dsh-skill-shelf] history backfill failed', error)
    }
  })()

  // One-time migration: an install upgraded from the sidecar-configured
  // build seeds the settings namespace from the saved sidecar config when the
  // namespace has no user section yet. Later edits live only in the settings
  // document; the sidecar keeps its (now-stale) copy untouched.
  // Startup: 清理 Issue #3 遗留的 .*.import-* 临时目录（尽早回收，不阻塞）
  void (async () => {
    const home = dshHome()
    const configuredAgentsHome = process.env.DSH_AGENTS_HOME?.trim()
    const agentsHome = configuredAgentsHome !== undefined && configuredAgentsHome !== '' ? configuredAgentsHome : join(homedir(), '.agents')
    for (const root of [join(home, 'skills'), join(agentsHome, 'skills')]) {
      try {
        const c = await cleanupLeftoverImportDirs(root)
        if (c > 0) logInfo(`[dsh-skill-shelf] startup cleaned ${c} leftover import temp dir(s) in ${root}`)
      } catch (error) {
        logWarn('[dsh-skill-shelf] startup cleanup failed', error)
      }
    }
    // 一次性迁移：旧版本靠把 SKILL.md 改名成 SKILL.md.disabled 来停用，新版
    // 改成写策略、文件不动。必须最先跑，否则老用户升级后停用技能会全部复活。
    try {
      const migrated = await migrateRenamedDisabledSkills(store, home)
      if (migrated.length > 0) logInfo(`[dsh-skill-shelf] startup migrated ${migrated.length} renamed disabled skill(s) to policy overrides`)
    } catch (error) {
      logWarn('[dsh-skill-shelf] startup disabled-skill migration failed', error)
    }
    // 对账：迁移后处理残留的 .disabled、sidecar 缺记录等历史情况。
    try {
      const reconciled = await reconcileDisabledSkills(store, home)
      if (reconciled.length > 0) {
        logInfo(`[dsh-skill-shelf] startup reconciled ${reconciled.length} disabled skill record(s): ${reconciled.map((entry) => entry.name).join(', ')}`)
      }
    } catch (error) {
      logWarn('[dsh-skill-shelf] startup disabled-skill reconcile failed', error)
    }
    // 反向对账：记录还在、文件已不在 → 修路径或删记录。不做这一步，那条记录会
    // 把名字永久锁死（启用/新建/删除三条路都失败）。
    try {
      const pruned = await pruneStaleDisabledSkills(store, home)
      if (pruned.repaired.length > 0 || pruned.removed.length > 0) {
        logInfo(`[dsh-skill-shelf] startup pruned disabled records: repaired ${pruned.repaired.length} (${pruned.repaired.map((entry) => entry.name).join(', ') || '-'}), removed ${pruned.removed.length} (${pruned.removed.join(', ') || '-'})`)
      }
    } catch (error) {
      logWarn('[dsh-skill-shelf] startup disabled-record prune failed', error)
    }
    // 回收站对账：记录还在、目录已不在 → 删记录。不做这一步，「恢复」按钮会
    // 永远失败（rename ENOENT），而「永久删除」因为 rm --force 反而成功 ——
    // 同一条记录的两条撤销路径表现相反。
    try {
      const prunedTrash = await pruneStaleTrash(store)
      if (prunedTrash.length > 0) {
        logInfo(`[dsh-skill-shelf] startup pruned ${prunedTrash.length} stale trash record(s): ${prunedTrash.map((entry) => entry.name).join(', ')}`)
      }
    } catch (error) {
      logWarn('[dsh-skill-shelf] startup trash-record prune failed', error)
    }
  })()

  void (async () => {
    try {
      const legacy = await store.getConfig()
      // The read is awaited; the plugin may have unloaded meanwhile (#19).
      if (!mounted()) return
      if (Object.keys(legacy).length > 0 && Object.keys(saved()).length === 0) {
        const settings = settingsOf()
        if (settings !== undefined) await settings.update(ENTRY_ID, legacy as Record<string, unknown>)
      }
    } catch (error) {
      logWarn('[dsh-skill-shelf] sidecar config migration into the settings namespace failed', error)
    }
  })()

}
