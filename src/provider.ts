/**
 * The hub's own skill provider, registered into the GLOBAL layer of the
 * official ctx.skills registry.
 *
 * Why: in the dsh web app the base host skill-filesystem row is disabled on
 * purpose — agent presets own local discovery by mounting their own
 * skill-filesystem into their preset scope layers, so a host-plane query
 * against the registry's empty global layer sees nothing. The hub needs a
 * session-independent management view, so it contributes one itself: the
 * user roots always, plus the project roots when the caller names a cwd.
 *
 * Agent views are unaffected: preset layers are nearer than the global
 * layer, so a preset's own filesystem provider wins every duplicate name
 * outright, and this provider only surfaces skills for presets that mount
 * no filesystem row at all.
 */

import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SkillCandidate, SkillDefinition, SkillProvider, SkillProviderControl } from '@deepseek-ai/dsh-skill'
import { errorText } from './error-text.ts'
import { dshHome } from './store/paths.ts'
import { findProjectRoot, parseFrontmatter, rootPath, scanRoot } from './skillfs.ts'
import { foreignRoots } from './skillfs/foreign.ts'

/** Official root ranks (mirrors dsh-skill-filesystem). */
const PROJECT_DSH_RANK = 100
const PROJECT_AGENTS_RANK = 200
const USER_DSH_RANK = 400
const USER_AGENTS_RANK = 500
/**
 * 外部 Agent 技能根的 rank：一律排在 dsh 自己的用户级根之后。
 *
 * 为什么要有这一档：这些目录是**只读**的（别的 agent 拥有它们），同名时
 * 必须让 dsh 自己的那份赢，否则 hub 的开关/删除会作用到别人的文件上。
 */
const FOREIGN_RANK = 600

/** One scanned root the provider lists. */
interface ProviderRoot {
  /** Skills directory to scan. */
  base: string
  /** SkillSource value for candidates from this root. */
  source: string
  /** Official precedence rank. */
  rank: number
}

/**
 * Global-layer skill provider for the hub's management catalog.
 * Implements the official SkillProvider contract: list() returns
 * invocation-neutral candidates; get() resolves the winning candidate's
 * body. Both are readonly reads of the local skill roots.
 */
export class SkillHubProvider implements SkillProvider {
  readonly name = 'skill-shelf'
  private readonly home: string
  /** 用户主目录（外部 Agent 的技能根相对它解析，与 dshHome 是两个概念）。 */
  private readonly userHome: string
  private readonly control: SkillProviderControl
  private readonly watchTimer: ReturnType<typeof setInterval>
  private rootStamp = ''
  /** 上一次 watch 失败的错误文案（同一错误只记一次，避免 5 秒定时器刷屏）。 */
  private lastWatchError = ''
  /** 模型调用覆盖（项目技能停用）。每次 list 现查 —— store 是内存态，读它很便宜。 */
  private readonly overrides: () => Promise<ReadonlySet<string>>
  /** 是否并入外部 Agent 技能根：只有管理面板（global 层）该为 true。 */
  private readonly includeForeign: boolean

  constructor(
    control: SkillProviderControl,
    home = dshHome(),
    overrides: () => Promise<ReadonlySet<string>> = async () => new Set(),
    userHome = homedir(),
    includeForeign = true,
  ) {
    this.control = control
    this.home = home
    this.userHome = userHome
    this.overrides = overrides
    this.includeForeign = includeForeign
    // The registry caches completed catalogs until something invalidates.
    // The hub invalidates explicitly after its own mutations (see routes),
    // and this cheap mtime poll catches external top-level changes (manual
    // adds/removes/renames of skill dirs) so the GUI stays live.
    this.watchTimer = setInterval(() => { this.watch() }, 5000)
    this.watchTimer.unref?.()
    control.signal.addEventListener('abort', () => { clearInterval(this.watchTimer) }, { once: true })
    this.watch()
  }

  /**
   * checkRoots 的守卫包装：某个根不可读（EACCES/ENOTDIR）时不能抛成未处理
   * 拒绝——构造时一次、之后每 5 秒一次。错误按文案去重，恢复后清零。
   */
  private watch(): void {
    void this.checkRoots().then(
      () => { this.lastWatchError = '' },
      (error: unknown) => {
        const text = errorText(error)
        if (text === this.lastWatchError) return
        this.lastWatchError = text
        console.warn('[dsh-skill-shelf] skill root watch failed:', text)
      },
    )
  }

  /**
   * Invalidate the registry cache when the discovered skill files changed.
   * The stamp covers the per-skill discovery file's mtime + size (plus the
   * entry set itself), so editing a SKILL.md body — not just adding or
   * renaming directories — refreshes the GUI catalog.
   */
  private async checkRoots(): Promise<void> {
    let stamp = ''
    for (const root of await this.roots(undefined, this.includeForeign)) {
      for (const entry of await scanRoot(root.base)) {
        try {
          const info = await stat(entry.path)
          stamp += entry.path + ':' + info.mtimeMs + ':' + info.size + ';'
        } catch {
          stamp += entry.path + ':missing;'
        }
      }
    }
    if (this.rootStamp === '') {
      this.rootStamp = stamp
      return
    }
    if (stamp !== this.rootStamp) {
      this.rootStamp = stamp
      this.control.invalidate()
    }
  }

  async list(options: { cwd?: string; signal?: AbortSignal }): Promise<readonly SkillCandidate[]> {
    const candidates: SkillCandidate[] = []
    const overridden = await this.overrides()
    for (const root of await this.roots(options.cwd, this.includeForeign)) {
      for (const entry of await scanRoot(root.base)) {
        let text: string
        try {
          text = await readFile(entry.path, 'utf8')
        } catch {
          continue // unreadable files surface in the diagnostics scan instead
        }
        const parsed = parseFrontmatter(text)
        if ('error' in parsed) continue // skip-level failures surface in diagnostics
        const value = parsed.value
        candidates.push({
          name: value.name,
          description: value.description,
          ...(value.whenToUse !== undefined ? { whenToUse: value.whenToUse } : {}),
          // 停用的项目技能仍然出现在列表里（可查可恢复），但模型不再自动调用；
          // `/name` 手动调用保留。这与 WorkBuddy 的 disableModelInvocation 同语义。
          invocation: overridden.has(entry.path)
            ? { modelInvocable: false, userInvocable: value.invocation.userInvocable }
            : value.invocation,
          source: root.source,
          provider: this.name,
          rank: root.rank,
          locator: { path: entry.path, directory: entry.directory },
          path: entry.path,
        })
      }
    }
    return candidates
  }

  async get(candidate: SkillCandidate): Promise<SkillDefinition | undefined> {
    const locator = candidate.locator as { path: string; directory: string }
    let text: string
    try {
      text = await readFile(locator.path, 'utf8')
    } catch {
      return undefined
    }
    const parsed = parseFrontmatter(text)
    if ('error' in parsed) return undefined
    const value = parsed.value
    // 与 list 同一判据：停用的项目技能在正文读取时也保持模型不可调用，
    // 否则 catalog 与 get 会各说各话。
    const overridden = await this.overrides()
    return {
      name: value.name,
      description: value.description,
      ...(value.whenToUse !== undefined ? { whenToUse: value.whenToUse } : {}),
      invocation: overridden.has(locator.path)
        ? { modelInvocable: false, userInvocable: value.invocation.userInvocable }
        : value.invocation,
      source: candidate.source,
      provider: this.name,
      resourceBase: { kind: 'directory', path: locator.directory },
      path: locator.path,
      content: value.content,
    }
  }

  /**
   * The roots this provider lists: user roots always, project roots with cwd.
   *
   * `includeForeign` 只对**管理面板**（global 层）为 true。agent 层必须为
   * false —— 那一层比 preset 更近，把别的 agent 的技能塞进去会让它们遮蔽
   * preset 原生技能，而它们的来源又不可写，结果就是「面板看得见、模型却调
   * 不动」：技能目录里多出几十条指向外部目录的条目，真正该生效的那些被挤掉。
   * 管理视图看全量、调用视图只看自己的根，是这里必须分开的两件事。
   */
  private async roots(cwd?: string, includeForeign = true): Promise<ProviderRoot[]> {
    const roots: ProviderRoot[] = [
      { base: rootPath('user-dsh', this.home), source: 'user-dsh', rank: USER_DSH_RANK },
      { base: rootPath('user-agents', this.home), source: 'user-agents', rank: USER_AGENTS_RANK },
    ]
    if (cwd !== undefined && cwd !== '') {
      const project = await findProjectRoot(cwd)
      roots.unshift(
        { base: join(project, '.dsh', 'skills'), source: 'project-dsh', rank: PROJECT_DSH_RANK },
        { base: join(project, '.agents', 'skills'), source: 'project-agents', rank: PROJECT_AGENTS_RANK },
      )
    }
    if (includeForeign) {
      // 其他 Agent 的用户级技能根：并入调用列表，让它们能被模型直接调用。
      //
      // 关键约束：
      // - rank 最低 → 同名时 dsh 自己的那份赢，开关/删除不会误伤别人的文件；
      // - source 用 `agent-<key>`，与可写根区分（面板据此显示来源标签）；
      // - 目录不存在时 scanRoot 自己返回空数组，不需要在这里探测。
      for (const foreign of foreignRoots(this.userHome)) {
        roots.push({ base: foreign.dir, source: 'agent-' + foreign.agent, rank: FOREIGN_RANK })
      }
    }
    return roots
  }

  /** Public hook for the routes: invalidate after hub-driven mutations. */
  invalidate(): void {
    this.control.invalidate()
  }
}

