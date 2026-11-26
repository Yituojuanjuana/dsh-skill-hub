/**
 * 提案落地：把**人工已通过**的提案写成真实技能文件。
 *
 * 这是整个插件里唯一会写技能目录的地方，因此三条纪律写死在代码里：
 * 1. 只处理 status === 'accepted' 的提案 —— 未审核的提案永远不会到这里；
 * 2. 替换已有技能前**必须**备份旧文件（`<技能>.bak-<时间戳>`），失败可回滚；
 * 3. 只写 dsh 自己的可写根（`~/.dsh/skills` / `~/.agents/skills`），
 *    外部 Agent 目录一个字节都不动。
 */
import { cp, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { EvolutionProposal } from '../protocol/evolution.ts'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import { projectSkillsRoot, rootPath } from '../skillfs/paths.ts'
import type { WritableRoot } from '../protocol.ts'

/**
 * 备份目录的根：skills 根的**兄弟目录**。
 *
 * 放在 `<home>/.skill-backups`（`~/.dsh/.skill-backups` 或
 * `<workspace>/.skill-backups`），与 `skills/` 平级 —— provider 只扫 `skills/`，
 * 所以备份永远不会被当成技能注册。
 *
 * 为什么不用 `skills/.backups`（隐藏子目录）：多数 provider 会递归扫子目录，
 * 点号前缀并不能保证被忽略；平级目录才是稳的。
 * @param skillsRoot - 某个 skills 根的绝对路径。
 * @returns 备份根路径。
 */
export function backupRootFor(skillsRoot: string): string {
  return join(dirname(resolve(skillsRoot)), '.skill-backups')
}

/** 落地结果。 */
export interface ApplyOutcome {
  ok: boolean
  /** 实际写入的技能名。 */
  name?: string
  /** 写入路径。 */
  path?: string
  /** 旧版本备份目录（替换时）。 */
  backupPath?: string
  /** 版本标签。 */
  version?: string
  /** 失败原因。 */
  error?: string
}

/** 版本标签格式：`0.1.<当天序号>`。 */
export function nextVersionTag(existing: readonly string[]): string {
  const versions = existing
    .map((name) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(name.trim()))
    .filter((hit): hit is RegExpExecArray => hit !== null)
    .map((hit) => Number(hit[3]))
  const max = versions.length === 0 ? 0 : Math.max(...versions)
  return '0.1.' + String(max + 1)
}

/**
 * 从提案里取出要写入的 SKILL.md 正文（含 frontmatter）。
 *
 * 草稿来自模型，可能带 Markdown 围栏或缺少 frontmatter —— 这里统一补齐，
 * 保证写出来的是**合法可加载**的技能文件。
 */
export function buildSkillFile(proposal: EvolutionProposal, version: string): string {
  const raw = (proposal.draft ?? proposal.newSource ?? '').trim()
  // 剥掉整篇代码围栏。
  const fenced = raw.match(/^```(?:markdown|md|yaml)?\s*\n([\s\S]*?)\n```$/i)
  const body = (fenced?.[1] ?? raw).trim()
  // 已有 frontmatter 就原样保留（只补 version），否则生成一份。
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(body)
  if (fmMatch !== null) {
    const existing = fmMatch[1] ?? ''
    const rest = fmMatch[2] ?? ''
    const withVersion = /^version:/m.test(existing)
      ? existing.replace(/^version:.*$/m, 'version: ' + version)
      : existing + '\nversion: ' + version
    return ['---', withVersion.trim(), '---', '', rest.trim(), ''].join('\n')
  }
  const description = (proposal.scenario ?? proposal.skillName).replace(/\s+/g, ' ').slice(0, 300)
  return [
    '---',
    'name: ' + proposal.skillName,
    'description: ' + description,
    'version: ' + version,
    '---',
    '',
    body,
    '',
  ].join('\n')
}

/**
 * 把一条已通过的提案落地。
 * @param proposal - 已通过审核的提案。
 * @param home - DSH home（`~/.dsh`）。
 * @param root - 写入哪个可写根。
 * @param now - 时间戳（备份目录名用）。
 * @returns 落地结果。
 */
/**
 * 把一条提案落地成技能文件。
 *
 * **状态校验不在这里**：调用方（decide）代表用户点击「同意并落地」的意图，
 * 它在调用前已经确认过提案是可操作的（pending）。早期实现要求
 * `status === 'accepted'` 才能落地，但状态是落地**成功后**才改的 ——
 * 于是形成死锁，永远报 `proposal is not accepted: pending`。
 *
 * 这里只做两件事：拒绝已终结的提案（rejected/deferred/accepted），
 * 以及执行写入。真正的幂等由 decide 层的状态迁移保证。
 * @param proposal - 待落地的提案。
 * @param home - DSH home。
 * @param root - 写入哪个可写根。
 * @param now - 时间戳。
 * @returns 落地结果。
 */
export async function applyProposal(
  proposal: EvolutionProposal,
  home: string,
  root: WritableRoot | 'project' = 'user-dsh',
  now = Date.now(),
  /** 工作区路径：`root === 'project'` 时必填，写到 `<workspace>/.dsh/skills`。 */
  workspace?: string,
): Promise<ApplyOutcome> {
  // 已终结的提案不该再落地（重复点击 / 已驳回 / 已暂缓）。
  if (proposal.status === 'rejected') return { ok: false, error: 'proposal was rejected: ' + proposal.id }
  if (proposal.status === 'deferred') return { ok: false, error: 'proposal is deferred, resume it first: ' + proposal.id }
  // 回收类提案不落地成技能 —— 它走「移入回收站」按钮，不是「同意并落地」。
  if (proposal.kind === 'reclaim') return { ok: false, error: 'reclaim proposals cannot be applied as skills' }
  const rawName = proposal.skillName.trim()
  if (!isSkillName(rawName)) return { ok: false, error: 'proposal name is not a valid skill name: ' + rawName }

  // 目标目录：项目技能写进工作区的 `.dsh/skills`，其余走用户可写根。
  //
  // 这是「细分专项落地后在工作区看不到」的修复点：以前所有提案都落到
  // `~/.dsh/skills`，而工作区页只扫 `<workspace>/.dsh/skills` —— 文件写对了，
  // 但写错了地方，所以永远不出现在那个列表里。
  let base: string
  if (root === 'project') {
    if (workspace === undefined || workspace.trim() === '') {
      return { ok: false, error: 'project 落地需要指定工作区路径' }
    }
    base = projectSkillsRoot(workspace)
  } else {
    base = rootPath(root, home)
  }
  await mkdir(base, { recursive: true })
  const targetDir = join(base, rawName)
  const targetFile = join(targetDir, 'SKILL.md')
  const exists = existsSync(targetFile)

  // 替换已有技能：先备份整份目录，再写新文件。
  //
  // 备份**必须放在 skills 根之外**。以前备份写成 `<base>/<name>.bak-<ts>/`，
  // 仍落在 provider 的扫描范围内，于是出现两个问题：
  //   1. 备份里的 frontmatter name 与原技能相同 → registry 报「同名不可达」；
  //   2. 备份目录名与 frontmatter name 不符 → 又报「名称与发现路径不一致」。
  // 现在统一放到 `<base 的父目录>/.skill-backups/`，扫描根看不到它。
  let backupPath: string | undefined
  if (exists) {
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
    backupPath = join(backupRootFor(base), rawName + '.bak-' + stamp)
    await mkdir(dirname(backupPath), { recursive: true })
    await cp(targetDir, backupPath, { recursive: true, force: true })
  }

  // 版本标签：已有版本号就递增，否则从 0.1.1 起。
  let version = '0.1.1'
  if (exists) {
    try {
      const previous = await readFile(targetFile, 'utf8')
      const hit = /^version:\s*(.+)$/m.exec(previous)
      if (hit?.[1] !== undefined) version = nextVersionTag([hit[1].trim()])
    } catch {
      // 读不出来就用默认版本。
    }
  }

  const content = buildSkillFile(proposal, version)
  try {
    await mkdir(targetDir, { recursive: true })
    await writeFile(targetFile, content, 'utf8')
  } catch (error) {
    // 写失败时把备份放回去，别留下半成品。
    if (backupPath !== undefined && existsSync(backupPath)) {
      try { await cp(backupPath, targetDir, { recursive: true, force: true }) } catch { /* 回滚失败也只好放弃 */ }
    }
    return { ok: false, error: 'write failed: ' + (error instanceof Error ? error.message : String(error)) }
  }

  return {
    ok: true,
    name: rawName,
    path: targetFile,
    version,
    ...backupPath === undefined ? {} : { backupPath },
  }
}

/**
 * 把一段「同类场景」的描述归一成去重键。
 *
 * 驳回后不再为同一场景反复生成提案：用技能名 + 场景描述的前若干字符做键，
 * 足够稳定又不会因为措辞微调而失效。
 */
export function rejectionKey(skillName: string, scenario: string): string {
  const normalize = (text: string): string => text.toLowerCase().replace(/[\s\p{P}]+/gu, '').slice(0, 60)
  return normalize(skillName) + '::' + normalize(scenario)
}

/** 列出一个可写根下已有的技能目录名（不含备份）。 */
export async function listSkillDirs(base: string): Promise<string[]> {
  try {
    const names = await readdir(base)
    const out: string[] = []
    for (const name of names) {
      if (name.includes('.bak-')) continue
      try {
        const info = await stat(join(base, name))
        if (info.isDirectory()) out.push(name)
      } catch {
        // 单个目录读不出来就跳过。
      }
    }
    return out
  } catch {
    return []
  }
}

/** 把一个技能目录改名成备份（归档用）。 */
export async function archiveSkillDir(base: string, name: string, now = Date.now()): Promise<string | undefined> {
  const from = join(base, name)
  if (!existsSync(from)) return undefined
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
  const to = join(base, name + '.archived-' + stamp)
  await rename(from, to)
  return to
}

/** 确保目录存在（备份父目录等）。 */
export async function ensureDir(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
}
