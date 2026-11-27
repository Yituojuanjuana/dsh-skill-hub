/**
 * routes 共享层 · 目录装配：已知工作区清单、完整目录响应（时间戳/interface
 * 元数据/重名诊断）与详情映射。从 helpers.ts 原样搬出，行为不变。
 */

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SkillDefinition, SkillSummary } from '@deepseek-ai/dsh-skill'
import {
  computeAnnouncementBudget,
  isProjectSource,
  type CatalogResponse,
  type CatalogSkill,
  type SkillDetail,
  type WritableRoot,
} from '../protocol.ts'
import { rootPath, readSkillInterface, scanDiagnostics, type SkillInterface } from '../skillfs.ts'
import { CURRENT_VERSION } from '../update.ts'
import { homeOf, isWritableSource, type SkillHubRouteDeps } from './deps.ts'
import { canWriteInvocation } from './invocation-writable.ts'

/**
 * 目录中存在的技能名集合。默认（`includeDisabled` 未显式关闭）为「启用目录 ∪
 * 已禁用名单」——tag 成员校验用：技能被禁用后不该从 tag 里掉出去。
 *
 * 导入去重必须传 `{ includeDisabled: false }`：禁用只意味着「暂不启用」，把它
 * 算作「已存在」会让一次禁用产生「永久占名」的副作用，真技能再也导不进来
 * （issue #16）。
 */
export async function knownSkillNames(
  deps: SkillHubRouteDeps,
  options?: { includeDisabled?: boolean },
): Promise<Set<string>> {
  const snapshot = await deps.skills.snapshot()
  const names = new Set(snapshot.skills.map((skill) => skill.name))
  if (options?.includeDisabled === false) return names
  for (const disabled of await deps.store.listDisabled()) names.add(disabled.name)
  return names
}

/** 已知工作区条目（dsh 的 workspace.json 表）。 */
export interface WorkspaceEntry {
  path: string
  title: string
}

/**
 * 读取 dsh 的已知工作区清单（~/.dsh/storages/workspace.json 的
 * tables.workspaces 表）。面板默认视图据此合并所有工作区的项目技能；
 * 文件缺失/损坏时返回空清单（回退为仅用户级视图）。
 */
export async function workspaceEntries(home: string): Promise<WorkspaceEntry[]> {
  try {
    const raw = await readFile(join(home, 'storages', 'workspace.json'), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    const tables = typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>).tables as Record<string, unknown> | undefined
      : undefined
    const workspaces = tables !== undefined && typeof tables === 'object'
      ? (tables as Record<string, unknown>).workspaces as Record<string, unknown> | undefined
      : undefined
    const entries: WorkspaceEntry[] = []
    if (workspaces !== undefined && typeof workspaces === 'object') {
      for (const record of Object.values(workspaces)) {
        const entry = record as { path?: unknown; title?: unknown } | null
        if (entry !== null && typeof entry === 'object' && typeof entry.path === 'string' && entry.path !== '') {
          entries.push({
            path: entry.path,
            title: typeof entry.title === 'string' && entry.title !== '' ? entry.title : entry.path,
          })
        }
      }
    }
    return entries
  } catch {
    return []
  }
}

/**
 * Build the full catalog response (shared by catalog/toggle/create handlers).
 * 显式 cwd 只看该工作区；否则合并所有已知工作区（workspace.json）的项目技能
 * + 用户级技能，同名技能先到先得；没有任何工作区时回退为仅用户级视图。
 */
export async function buildCatalog(deps: SkillHubRouteDeps, cwd?: string): Promise<CatalogResponse> {
  const home = homeOf(deps)
  // 工作区清单**永远返回全部已登记工作区**，与 cwd 无关。
  //
  // 曾经这里是 `cwd ? [{path: cwd}] : 全部`：一旦面板传了 cwd（默认就是当前
  // 对话的工作区），下拉就只剩那一项 —— 用户看到「看不到其他工作区」，而
  // 切换工作区的控件因此永远只有一个选项。cwd 只影响**扫哪些项目技能**，
  // 不该影响**能选哪些工作区**。
  const allWorkspaces = await workspaceEntries(home)
  const workspaces: WorkspaceEntry[] = allWorkspaces
  /** 只用于项目技能扫描的目录：显式 cwd 优先，否则扫描全部工作区。 */
  const scanTargets: WorkspaceEntry[] = cwd !== undefined && cwd !== ''
    ? [{ path: cwd, title: allWorkspaces.find((entry) => entry.path === cwd)?.title ?? cwd }]
    : allWorkspaces
  // Project skills with same name but different workspace are distinct entries (grouped by workspace in SourcesView), so key includes workspace for project sources.
  const byKey = new Map<string, { skill: SkillSummary; workspace?: string; workspaceTitle?: string }>()
  // Distinct identities per logical key: the same skill reappearing across
  // workspace snapshots (same source+provider) is one skill, not a duplicate.
  // Only different source/provider identities sharing a name are ambiguous.
  const identitiesByKey = new Map<string, Set<string>>()
  let complete = true

  /** 把一份快照里的技能并入 byKey（同名先到先得）。 */
  const absorb = (skills: readonly SkillSummary[], ws?: WorkspaceEntry): void => {
    for (const skill of skills) {
      const inProject = ws !== undefined && isProjectSource(skill.source)
      const logicalKey = inProject ? `${skill.name}\0${ws.path}\0${skill.source}` : skill.name
      // Duplicate detection is by name + workspace for project skills: the two
      // project roots (.dsh/.agents) of one workspace are the same identity
      // namespace even though they are separate rows in `byKey`.
      const identityKey = inProject ? `${skill.name}\0${ws.path}` : skill.name
      let identities = identitiesByKey.get(identityKey)
      if (identities === undefined) {
        identities = new Set()
        identitiesByKey.set(identityKey, identities)
      }
      identities.add(skill.source + '\0' + skill.provider)
      if (byKey.has(logicalKey)) continue
      byKey.set(logicalKey, {
        skill,
        ...(inProject ? { workspace: ws.path, workspaceTitle: ws.title } : {}),
      })
    }
  }

  // 用户级技能单独取一次：不带 cwd 的快照才是「全局层」的权威视图。
  //
  // 为什么不能只靠工作区快照：带 cwd 的 `skills.snapshot()` 面向的是「该工作区
  // 视角」，不保证把 global 层原样带回来。之前只在「没有任何工作区」时才读一次
  // 不带 cwd 的快照，于是**一旦存在工作区，用户级技能就可能整片消失**——表现
  // 就是「有目录却检测不到」。这里先无条件取一次全局层，工作区快照只用来补项目
  // 技能，两者互不覆盖。
  const globalSnapshot = await deps.skills.snapshot(undefined)
  if (!globalSnapshot.complete) complete = false
  absorb(globalSnapshot.skills)

  for (const ws of scanTargets) {
    const lookup = ws.path !== '' ? { cwd: ws.path } : undefined
    if (lookup === undefined) continue
    const snapshot = await deps.skills.snapshot(lookup)
    if (!snapshot.complete) complete = false
    // 只吸收项目来源：用户级技能已经由上面的全局快照覆盖，重复吸收会让
    // 同一份技能因 source 不同被当成两个身份。
    absorb(snapshot.skills.filter((skill) => isProjectSource(skill.source)), ws)
  }
  const disabled = await deps.store.listDisabled()
  const overridden = new Set(await deps.store.listInvocationOverrides())
  const byName = byKey
  // Disabled records are user intent (a paused local skill), not another
  // active identity. A disabled sidecar can coexist with an active copy from
  // a different root (e.g. a CC Switch install); counting it here would flag
  // a perfectly normal active row as a duplicate. Only active providers count.
  //
  // 外部 Agent 根（`agent-*`）同样不算重复：那些目录是只读的别人的家目录，
  // 同一个技能同时装在 dsh 与 Trae/Claude 下是**正常状态**，把它标成「重复」
  // 只会让每一行都亮警告。它们由 source 标签区分，不需要重复告警。
  const duplicateNames = [...identitiesByKey.entries()]
    .filter(([, identities]) => identities.size > 1)
    .map(([key]) => key.split('\0')[0])
    .filter((name, idx, arr) => arr.indexOf(name) === idx)
    .filter((name) => {
      const identities = identitiesByKey.get(name)
      if (identities === undefined) return true
      // 只保留「同一个技能名在多个 dsh 自有根里各有一份」的真重复。
      const own = [...identities].filter((identity) => !identity.startsWith('agent-'))
      return own.length > 1
    })
    .sort((a, b) => a.localeCompare(b))
  // 添加/更新时间 = 技能发现文件的创建/修改时间（排序与详情展示用）。
  //
  // 优先用 `skill.path`（provider 给的绝对路径），它对**所有**来源都成立 ——
  // 包括只读的外部 Agent 根。以前只按可写根拼路径，外部技能因此永远没有
  // 安装时间，列表里那一列是空的。路径缺失时才回退到按可写根推断。
  // 全部技能并发收集（面板每 5 秒轮询一次，逐个串行 stat 会让响应随技能
  // 数量线性变慢）。
  // 调用权限可写性：与路由共用判据。每个技能一次 access(W_OK)，并发收集。
  const invocationWritableByName = new Map<string, boolean>()
  await Promise.all([...byName.entries()].map(async ([logicalKey, { skill }]) => {
    invocationWritableByName.set(logicalKey, await canWriteInvocation(skill.path, deps))
  }))
  const timesByName = new Map<string, { addedAt: number; updatedAt: number }>()
  /** 本次观测到的「路径 → birthtime」，交给 store 登记 firstSeenAt（只补新键）。 */
  const observed = new Map<string, number>()
  await Promise.all([...byName.entries()].map(async ([logicalKey, { skill }]) => {
    const candidates: string[] = []
    if (skill.path !== undefined) candidates.push(skill.path)
    if (isWritableSource(skill.source)) {
      const base = rootPath(skill.source as WritableRoot, home)
      candidates.push(join(base, skill.name, 'SKILL.md'), join(base, skill.name), join(base, skill.name + '.md'))
    }
    for (const candidate of candidates) {
      try {
        const times = await stat(candidate)
        if (times.birthtimeMs > 0) observed.set(candidate, times.birthtimeMs)
        timesByName.set(logicalKey, { addedAt: times.birthtimeMs, updatedAt: times.mtimeMs })
        return
      } catch {
        // 目录/文件不存在则尝试下一个候选路径。
      }
    }
  }))
  // 首次观测时间落盘（只补新键，绝不覆盖）；这是「安装时间不被写回/替换打坏」
  // 的第二道防线。失败不能影响目录返回 —— best-effort。
  if (observed.size > 0) {
    await deps.store.recordFirstSeen([...observed].map(([path, at]) => ({ path, at }))).catch(() => false)
  }
  // addedAt 口径：持久化的 firstSeenAt 优先，且与当前 birthtime 取较小值。
  // 「较小值」是折中：firstSeenAt 记录了首次观测（可能晚于真实安装），而
  // birthtime 若被 rename 重置会变大 —— 取较小者能挡住「安装时间变刚刚」。
  // 旧状态文件没有 firstSeenAt 时全部回落 birthtime，不因升级清空任何人的时间。
  const firstSeen: Record<string, number> = await deps.store.listFirstSeen().catch(() => ({}))
  for (const [logicalKey, times] of timesByName) {
    const skill = byName.get(logicalKey)?.skill
    const path = skill?.path
    const persisted = path !== undefined ? firstSeen[path] : undefined
    if (persisted !== undefined && persisted > 0) {
      times.addedAt = Math.min(persisted, times.addedAt)
    }
  }
  // UI metadata from agents/openai.yaml (codex SkillInterface) — best-effort, no error if missing.
  // 按逻辑键（name[+workspace+source]）而非技能名缓存：两个工作区的同名项目
  // 技能是不同的行，否则会互相串显示最后读到的那份 interface。
  const interfaceByName = new Map<string, SkillInterface>()
  await Promise.all([...byName.entries()].map(async ([logicalKey, { skill, workspace }]) => {
    const candidates: string[] = []
    if (isWritableSource(skill.source as WritableRoot)) {
      candidates.push(join(rootPath(skill.source as WritableRoot, home), skill.name))
    } else if (isProjectSource(skill.source) && workspace !== undefined) {
      candidates.push(join(workspace, skill.source === 'project-dsh' ? '.dsh/skills' : '.agents/skills', skill.name))
    } else if (isProjectSource(skill.source)) {
      for (const ws of workspaces) if (ws.path !== '') candidates.push(join(ws.path, skill.source === 'project-dsh' ? '.dsh/skills' : '.agents/skills', skill.name))
    }
    for (const dir of candidates) {
      try {
        const iface = await readSkillInterface(dir)
        if (iface !== undefined) {
          interfaceByName.set(logicalKey, iface)
          return
        }
      } catch {
        // ignore
      }
    }
  }))
  const skills: CatalogSkill[] = [...byName.entries()].map(([logicalKey, { skill, workspace, workspaceTitle }]) => {
    const row: CatalogSkill = {
      name: skill.name,
      description: skill.description,
      ...(skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {}),
      invocation: {
        modelInvocable: skill.invocation.modelInvocable,
        userInvocable: skill.invocation.userInvocable,
      },
      provider: skill.provider,
      // 外部 Agent 技能也算「可操作」：它们能停用（invocation 覆盖）也能删除
      // （移入回收站），只是不写 dsh 的可写根。面板据 writable 显示删除按钮，
      // 所以这里必须为 true，否则用户看到的是只读行。
      writable: isWritableSource(skill.source) || skill.source.startsWith('agent-'),
      // 有发现路径的技能都可开关（invocation 覆盖，不动文件）；可写根的技能由 writable 蕴含开关能力。
      ...(skill.path !== undefined ? { toggleable: true } : {}),
      // hub 关掉的模型调用（项目技能停用）：UI 据此显示开关状态与提示。
      ...(skill.path !== undefined && overridden.has(skill.path) ? { modelOverride: true } : {}),
      source: skill.source,
      // 调用权限能否修改：与 /skill/invocation 路由共用同一判据，
      // 前端据此显示可点按钮或静态文字，杜绝「能点但后端 403」。
      invocationWritable: invocationWritableByName.get(logicalKey) ?? false,
      ...(workspace !== undefined ? { workspace, workspaceTitle: workspaceTitle ?? workspace } : {}),
    }
    const times = timesByName.get(logicalKey)
    if (times !== undefined) {
      row.addedAt = times.addedAt
      row.updatedAt = times.updatedAt
    }
    const iface = interfaceByName.get(logicalKey)
    if (iface !== undefined) applyInterface(row, iface)
    return row
  })
  // 两个 root 的诊断扫描互不依赖：面板每 5 秒轮询一次 /catalog，串行会让响应
  // 随技能数量线性变慢。扫描内部的逐条读盘也已是并发的（见 scanDiagnostics）。
  const [userDshDiagnostics, userAgentsDiagnostics] = await Promise.all([
    scanDiagnostics('user-dsh', home),
    scanDiagnostics('user-agents', home),
  ])
  const diagnostics = [...userDshDiagnostics, ...userAgentsDiagnostics]
  return {
    ok: true,
    pluginVersion: CURRENT_VERSION,
    complete,
    skills,
    disabled,
    diagnostics,
    announcement: computeAnnouncementBudget(skills),
    workspaces,
    // 当前对话的工作区：前端用它预选下拉默认项（取不到就不带，前端退回「全部」）。
    ...await (async (): Promise<{ currentWorkspace?: string }> => {
      if (deps.currentWorkspace === undefined) return {}
      try {
        const current = await deps.currentWorkspace()
        return current === undefined || current === '' ? {} : { currentWorkspace: current }
      } catch {
        return {}
      }
    })(),
    ...(duplicateNames.length > 0 ? { duplicateNames } : {}),
  }
}

/** agents/openai.yaml 的 interface 元数据 → 目录行/详情行（catalog 与详情共用）。 */
export function applyInterface<T extends SkillInterface>(row: T, iface: SkillInterface): void {
  if (iface.displayName !== undefined) row.displayName = iface.displayName
  if (iface.shortDescription !== undefined) row.shortDescription = iface.shortDescription
  if (iface.brandColor !== undefined) row.brandColor = iface.brandColor
  if (iface.iconSmall !== undefined) row.iconSmall = iface.iconSmall
  if (iface.iconLarge !== undefined) row.iconLarge = iface.iconLarge
  if (iface.defaultPrompt !== undefined) row.defaultPrompt = iface.defaultPrompt
}

/** Map a loaded definition onto the wire shape. */
export function toDetail(skill: SkillDefinition): SkillDetail {
  return {
    name: skill.name,
    description: skill.description,
    ...(skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {}),
    invocation: {
      modelInvocable: skill.invocation.modelInvocable,
      userInvocable: skill.invocation.userInvocable,
    },
    provider: skill.provider,
    source: skill.source,
    ...(skill.path !== undefined ? { path: skill.path } : {}),
    content: skill.content,
  }
}
