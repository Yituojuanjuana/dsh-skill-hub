/**
 * 历史遗留技能迁移。
 *
 * 旧代码把细分专项技能写到 `~/.dsh/skills`，工作区页永远看不到。
 * 迁移必须**不丢用户数据**：先复制校验，再把源改名保留（不删除）。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { moveSkillToWorkspace, relocateLegacyBackups } from './migrate-skills.ts'
import { backupRootFor } from './apply.ts'
import { projectSkillsRoot, rootPath } from '../skillfs/paths.ts'
import { scanRoot } from '../skillfs.ts'

let home: string
let workspace: string

const seed = async (dir: string, name: string): Promise<void> => {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n\nbody of ${name}\n`, 'utf8')
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'hub-mig-home-'))
  workspace = await mkdtemp(join(tmpdir(), 'hub-mig-ws-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(workspace, { recursive: true, force: true })
})

describe('moveSkillToWorkspace', () => {
  it('copies the skill into the workspace and parks the source', async () => {
    const name = 'sports-coach-demo'
    await seed(join(rootPath('user-dsh', home), name), name)

    const outcome = await moveSkillToWorkspace(name, home, workspace, 1_700_000_000_000)
    expect(outcome.ok).toBe(true)

    // 目标存在且内容完整。
    const target = join(projectSkillsRoot(workspace), name, 'SKILL.md')
    expect(existsSync(target)).toBe(true)
    expect(await readFile(target, 'utf8')).toContain('body of ' + name)

    // 源被改名保留，不是删除 —— 用户数据不丢。
    expect(outcome.parkedAt).toBeDefined()
    expect(existsSync(outcome.parkedAt ?? '')).toBe(true)
    expect(outcome.parkedAt).toContain('.moved-')
    // 原路径已不存在（否则会被当成两份技能）。
    expect(existsSync(join(rootPath('user-dsh', home), name))).toBe(false)
  })

  it('the migrated skill becomes visible in the workspace scan', async () => {
    const name = 'sports-coach-visible'
    await seed(join(rootPath('user-dsh', home), name), name)
    await moveSkillToWorkspace(name, home, workspace)

    const entries = await scanRoot(projectSkillsRoot(workspace))
    expect(entries.map((e) => e.directory)).toContain(join(projectSkillsRoot(workspace), name))
  })

  it('refuses when the source does not exist', async () => {
    const outcome = await moveSkillToWorkspace('missing-skill', home, workspace)
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('source skill not found')
  })

  it('refuses to overwrite an existing workspace skill', async () => {
    const name = 'dup-skill'
    await seed(join(rootPath('user-dsh', home), name), name)
    await seed(join(projectSkillsRoot(workspace), name), name)
    const outcome = await moveSkillToWorkspace(name, home, workspace)
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('target already exists')
  })
})

describe('relocateLegacyBackups', () => {
  it('moves .bak-* directories out of the scan root', async () => {
    const skillsRoot = rootPath('user-dsh', home)
    const bakName = 'demo.bak-2026-11-26T00-14-37-297Z'
    await seed(join(skillsRoot, bakName), 'demo')

    const moved = await relocateLegacyBackups(skillsRoot)
    expect(moved).toEqual([bakName])

    // 已搬到备份根，且不在扫描根里。
    expect(existsSync(join(backupRootFor(skillsRoot), bakName))).toBe(true)
    expect(existsSync(join(skillsRoot, bakName))).toBe(false)
    const entries = await scanRoot(skillsRoot)
    expect(entries.some((e) => e.directory.includes('.bak-'))).toBe(false)
  })

  it('is a no-op when there is no legacy backup', async () => {
    const skillsRoot = rootPath('user-dsh', home)
    await seed(join(skillsRoot, 'normal-skill'), 'normal-skill')
    expect(await relocateLegacyBackups(skillsRoot)).toEqual([])
    // 正常技能不受影响。
    expect(existsSync(join(skillsRoot, 'normal-skill', 'SKILL.md'))).toBe(true)
  })

  it('tolerates a missing skills root', async () => {
    expect(await relocateLegacyBackups(join(home, 'no-such-root'))).toEqual([])
  })
})
