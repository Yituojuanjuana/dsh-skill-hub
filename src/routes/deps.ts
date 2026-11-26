/**
 * routes 共享层 · 依赖视图：路由依赖接口、配置解析与可写技能解析（HTTP
 * 围栏在 ./http.ts）。
 */

import type { ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import type { SkillDefinition, SkillSummary } from '@deepseek-ai/dsh-skill'
import { resolveHubConfig, type HubConfig, type WritableRoot } from '../protocol.ts'
import { rootOfPath } from '../skillfs.ts'
import { foreignRootOfPath } from '../skillfs/paths.ts'
import { dshHome } from '../store/paths.ts'
import { type SkillHubStore } from '../store.ts'
import { writeError, type RouteFence } from './http.ts'

/** Sources the hub may toggle (the user-level filesystem roots). */
export function isWritableSource(source: string): source is WritableRoot {
  return source === 'user-dsh' || source === 'user-agents'
}

/** Lookup options the hub forwards to the registry (cwd selects project roots). */
export interface SkillLookupLike {
  cwd?: string
}

/** Route family dependencies (narrow structural view of ctx.skills for tests). */
export interface SkillHubRouteDeps {
  skills: {
    snapshot(options?: SkillLookupLike): Promise<{ skills: SkillSummary[]; complete: boolean }>
    get(name: string, options?: SkillLookupLike): Promise<SkillDefinition | undefined>
  }
  store: SkillHubStore
  /**
   * Request fence for the whole family: returns the rejection status (401/403)
   * or `undefined` to proceed. Production passes the host's own `/api` fence
   * (`ctx.connection.requestRejection`); absent falls back to literal loopback.
   */
  fence?: RouteFence
  /** DSH home override (tests isolate the writable roots; defaults to ~/.dsh). */
  home?: string
  /**
   * 用户主目录覆盖（其他 agent 的 `~/.claude/skills` 等相对它解析）。
   * 与 `home` 是两个概念：`home` 是 DSH 自己的状态根（`~/.dsh`），
   * 这个才是 `/Users/<user>`。测试用它把外部扫描圈在临时目录里。
   */
  userHome?: string
  /** Invalidate the registry catalog cache after hub-driven mutations. */
  invalidate?: () => void
  /** Optional invocation-count reader; absent means the stats route reports unavailable. */
  /** Resolves the current plugin config; business routes honour the master switch. */
  config?: () => HubConfig
  /** Resolves the raw saved config layer (fields the user explicitly overrode). */
  saved?: () => Partial<HubConfig>
  /** Persist a config patch and re-sync plugin surfaces; resolves with the fresh config. */
  updateConfig?: (patch: Partial<HubConfig>) => Promise<HubConfig>
  /**
   * 当前对话所在的工作区路径。
   *
   * 用来给「工作区」页预选默认项：用户打开面板时最想看到的是自己正在用的
   * 那个工作区，而不是一串待选路径。缺省时前端退回「全部工作区」。
   */
  currentWorkspace?: () => Promise<string | undefined>
}

/** The resolved hub config a route sees (the shared resolver fills defaults). */
export function configOf(deps: SkillHubRouteDeps): HubConfig {
  return resolveHubConfig(deps.config?.() ?? {})
}

/**
 * The raw saved config layer as persisted in the sidecar, reported for display
 * only. Since dsh 0.1.7 the settings namespace is the one user layer, so this
 * is legacy data: nothing writes it any more and the effective config above
 * never merges it.
 */
export function savedOf(deps: SkillHubRouteDeps): Partial<HubConfig> {
  return deps.saved?.() ?? {}
}

/** Refuse business routes while the master switch is off (the config route stays up). */
export function disabledGate(deps: SkillHubRouteDeps, res: ServerResponse): boolean {
  if (configOf(deps).enabled) return false
  writeError(res, 503, 'plugin disabled: enable it from the settings card')
  return true
}

/** Resolve the home used for writable-root operations. */
export function homeOf(deps: SkillHubRouteDeps): string {
  return deps.home ?? dshHome()
}

/**
 * Resolve the user's home directory — the base every other agent's user-level
 * skill folder hangs off. Distinct from `homeOf` (the DSH state root).
 */
export function userHomeOf(deps: SkillHubRouteDeps): string {
  return deps.userHome ?? homedir()
}

/** A skill resolved as a hub-writable user-level file. */
export interface WritableSkill {
  skill: SkillDefinition
  /** Absolute discovery-file path (guaranteed present by the resolver). */
  path: string
  /** The writable root containing the file. */
  root: WritableRoot
}

/** A refusal with the exact HTTP error the caller should answer with. */
export interface WritableSkillRefusal {
  status: number
  error: string
}

export type WritableSkillResult = { ok: true } & WritableSkill | { ok: false } & WritableSkillRefusal

/**
 * Resolve a skill by name as something the hub may write, or the exact
 * refusal the caller should answer with. Owns the guard sequence shared by
 * toggle, toggle-batch, and skill/delete: registry lookup, writable source,
 * writable file, and path containment inside a user root.
 */
export async function resolveWritableSkill(deps: SkillHubRouteDeps, name: string, cwd?: string): Promise<WritableSkillResult> {
  const lookup = cwd !== undefined && cwd !== '' ? { cwd } : undefined
  const skill = await deps.skills.get(name, lookup)
  if (skill === undefined) return { ok: false, status: 404, error: 'skill not found: ' + name }
  if (!isWritableSource(skill.source)) {
    return { ok: false, status: 409, error: 'source "' + skill.source + '" is managed outside the hub (read-only)' }
  }
  if (skill.path === undefined) return { ok: false, status: 409, error: 'provider-managed skill has no writable file' }
  const root = rootOfPath(skill.path, homeOf(deps))
  if (root === undefined) return { ok: false, status: 409, error: 'skill path is outside the hub writable roots' }
  return { ok: true, skill, path: skill.path, root }
}

/** 一个被判定为「外部 Agent 技能」的目标（可停用、可删除，但不是 dsh 可写根）。 */
export interface ForeignSkillTarget {
  skill: SkillDefinition
  /** 发现文件绝对路径（SKILL.md 或扁平 <name>.md）。 */
  path: string
  /** 命中的外部根 id，如 `trae-cn`。 */
  agent: string
}

/**
 * 把名字解析成「已知外部 Agent 根里的技能」。
 *
 * 与 {@link resolveWritableSkill} 的区别：那个只认 dsh 自己的可写根；这个只认
 * `foreignRoots()` 列出的目录。两条路径都做严格包含判定，因此删除动作不可能
 * 被诱导到列表之外的任何位置。
 * @param deps - 路由依赖。
 * @param name - 技能名。
 * @param cwd - 可选工作区。
 * @returns 命中的外部目标，或带 HTTP 状态的拒绝。
 */
export async function resolveForeignSkill(deps: SkillHubRouteDeps, name: string, cwd?: string): Promise<{ ok: true } & ForeignSkillTarget | { ok: false; status: number; error: string }> {
  const lookup = cwd !== undefined && cwd !== '' ? { cwd } : undefined
  const skill = await deps.skills.get(name, lookup)
  if (skill === undefined) return { ok: false, status: 404, error: 'skill not found: ' + name }
  if (!skill.source.startsWith('agent-')) {
    return { ok: false, status: 409, error: 'source "' + skill.source + '" is not an external agent root' }
  }
  if (skill.path === undefined) return { ok: false, status: 409, error: 'provider-managed skill has no file' }
  const agent = foreignRootOfPath(skill.path, userHomeOf(deps))
  if (agent === undefined) return { ok: false, status: 409, error: 'skill path is outside the known external agent roots' }
  return { ok: true, skill, path: skill.path, agent }
}
