/**
 * 历史遗留技能迁移：把误落到 DSH 用户目录的业务技能搬到对应工作区。
 *
 * 背景：修复前的落地逻辑只会写 `~/.dsh/skills`，细分专项技能因此落在那里，
 * 而工作区页只扫 `<workspace>/.dsh/skills` —— 永远看不到。
 *
 * 迁移原则（**不丢用户数据**）：
 * 1. 先复制到目标工作区，校验写入成功；
 * 2. 源目录**不删除**，改名为 `.moved-<ts>` 留在原处（用户可自行清理）；
 * 3. 旧版 `.bak-*` 备份一并移到 `.skill-backups/`，不再污染扫描根。
 *
 * @module evolution/migrate-skills
 */
import { cp, mkdir, readdir, rename, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { backupRootFor } from './apply.ts'
import { projectSkillsRoot, rootPath } from '../skillfs/paths.ts'
import { isNonSkillEntry } from '../skillfs/scan.ts'

/** 一次迁移的结果。 */
export interface MigrateOutcome {
  /** 实际迁移的技能名。 */
  moved: string[]
  /** 搬走的旧备份目录名。 */
  relocatedBackups: string[]
  /** 目标目录（工作区 skills）。 */
  targetRoot: string
  /** 逐个技能的错误。 */
  errors: Array<{ name: string; error: string }>
}

/**
 * 把一个技能从 DSH 用户根搬到工作区。
 *
 * @param name - 技能目录名。
 * @param home - DSH home。
 * @param workspace - 目标工作区路径。
 * @param now - 时间戳。
 * @returns 成功与否 + 说明。
 */
export async function moveSkillToWorkspace(
  name: string,
  home: string,
  workspace: string,
  now = Date.now(),
): Promise<{ ok: boolean; error?: string; from?: string; to?: string; parkedAt?: string }> {
  const from = join(rootPath('user-dsh', home), name)
  if (!existsSync(from)) return { ok: false, error: 'source skill not found: ' + from }
  const targetRoot = projectSkillsRoot(workspace)
  const to = join(targetRoot, name)
  if (existsSync(to)) return { ok: false, error: 'target already exists: ' + to }

  try {
    await mkdir(targetRoot, { recursive: true })
    // 先复制，确认目标存在后再把源改名（而不是删除）。
    await cp(from, to, { recursive: true, force: false })
    const copied = await stat(join(to, 'SKILL.md')).catch(() => undefined)
    if (copied === undefined) return { ok: false, error: 'copied skill has no SKILL.md: ' + to }

    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
    const parkedAt = from + '.moved-' + stamp
    await rename(from, parkedAt)
    return { ok: true, from, to, parkedAt }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 把 skills 根里的历史遗留目录搬到 `.skill-backups/`。
 *
 * 处理两种后缀（统一来自 {@link NON_SKILL_SUFFIXES}）：
 * - `.bak-*`  ：替换技能时的旧版本备份
 * - `.moved-*`：迁移到工作区后留在原地的旧副本
 *
 * 它们已不再被 scanRoot 扫描，但仍留在磁盘上占空间，且用户可能想找回
 * 旧版本 —— 搬走而不是删。
 * @param skillsRoot - skills 根。
 * @param now - 时间戳。
 * @returns 搬走的目录名。
 */
export async function relocateLegacyBackups(skillsRoot: string, now = Date.now()): Promise<string[]> {
  const moved: string[] = []
  let names: string[]
  try {
    names = await readdir(skillsRoot)
  } catch {
    return moved
  }
  const backupRoot = backupRootFor(skillsRoot)
  for (const name of names) {
    // 与 scanRoot 共用同一判定：新增后缀只改 NON_SKILL_SUFFIXES 一处。
    if (!isNonSkillEntry(name)) continue
    const from = join(skillsRoot, name)
    try {
      const info = await stat(from)
      if (!info.isDirectory()) continue
      await mkdir(dirname(join(backupRoot, name)), { recursive: true })
      await rename(from, join(backupRoot, name))
      moved.push(name)
    } catch {
      // 单个搬不动不影响其余。
    }
  }
  void now
  return moved
}
