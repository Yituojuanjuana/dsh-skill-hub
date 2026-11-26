/**
 * 非技能条目（`.bak-*` / `.moved-*`）必须被两处扫描入口一致跳过。
 *
 * 真实故障链：
 * 1. 替换技能时备份写成 `<name>.bak-<ts>/` → 仍在扫描根内、frontmatter name
 *    与原技能相同 → registry 报「同名不可达」+「名称与发现路径不一致」。
 * 2. 迁移到工作区后旧副本改名 `<name>.moved-<ts>/` 保留，同样的问题换个
 *    后缀又长出来 —— 因为扫描只过滤了 `.bak-`。
 *
 * 修复：后缀收敛到 `NON_SKILL_SUFFIXES` + `isNonSkillEntry`，两个扫描循环
 * 都调它，`relocateLegacyBackups` 也用它。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isNonSkillEntry, NON_SKILL_SUFFIXES, scanRoot } from './scan.ts'
import { relocateLegacyBackups } from '../evolution/migrate-skills.ts'
import { backupRootFor } from '../evolution/apply.ts'
import { rootPath } from './paths.ts'

let home: string

const seed = async (dir: string, name: string): Promise<void> => {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n\nbody\n`, 'utf8')
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'hub-nonskill-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('isNonSkillEntry', () => {
  it('recognises every declared suffix', () => {
    for (const suffix of NON_SKILL_SUFFIXES) {
      expect(isNonSkillEntry('demo' + suffix + '2026-11-26T00-00-00Z')).toBe(true)
    }
  })

  it('covers both .bak- and .moved-', () => {
    expect(isNonSkillEntry('demo.bak-2026-11-26T00-14-37-297Z')).toBe(true)
    expect(isNonSkillEntry('demo.moved-2026-11-26T00-23-27-593Z')).toBe(true)
  })

  it('does not flag a normal skill name', () => {
    expect(isNonSkillEntry('sports-coach-miniapp-build-verify')).toBe(false)
    expect(isNonSkillEntry('pdf')).toBe(false)
    // 名字里含 bak 但不是后缀标记 —— 不该误伤。
    expect(isNonSkillEntry('my-bakery-skill')).toBe(false)
  })
})

describe('scanRoot skips non-skill entries', () => {
  it('ignores a .moved-* directory (the regression from this round)', async () => {
    const skillsRoot = rootPath('user-dsh', home)
    await seed(join(skillsRoot, 'demo-skill'), 'demo-skill')
    // 模拟迁移遗留：目录名变了，frontmatter 还是原名。
    await seed(join(skillsRoot, 'demo-skill.moved-2026-11-26T00-23-27-593Z'), 'demo-skill')

    const entries = await scanRoot(skillsRoot)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.directory).toBe(join(skillsRoot, 'demo-skill'))
    expect(entries.some((e) => e.directory.includes('.moved-'))).toBe(false)
  })

  it('ignores a .bak-* directory', async () => {
    const skillsRoot = rootPath('user-dsh', home)
    await seed(join(skillsRoot, 'demo-skill'), 'demo-skill')
    await seed(join(skillsRoot, 'demo-skill.bak-2026-11-26T00-14-37-297Z'), 'demo-skill')

    const entries = await scanRoot(skillsRoot)
    expect(entries).toHaveLength(1)
    expect(entries.some((e) => e.directory.includes('.bak-'))).toBe(false)
  })

  it('ignores flat .moved-*.md files too', async () => {
    const skillsRoot = rootPath('user-dsh', home)
    await seed(join(skillsRoot, 'flat-skill'), 'flat-skill')
    await mkdir(skillsRoot, { recursive: true })
    await writeFile(join(skillsRoot, 'old.moved-2026-11-26T00-23-27-593Z.md'), '---\nname: old\n---\n', 'utf8')

    const entries = await scanRoot(skillsRoot)
    expect(entries.some((e) => e.path.includes('.moved-'))).toBe(false)
  })
})

describe('relocateLegacyBackups handles both suffixes', () => {
  it('moves .bak-* and .moved-* out of the scan root', async () => {
    const skillsRoot = rootPath('user-dsh', home)
    await seed(join(skillsRoot, 'target-skill'), 'target-skill')
    await seed(join(skillsRoot, 'target-skill.bak-2026-11-26T00-14-37-297Z'), 'target-skill')
    await seed(join(skillsRoot, 'target-skill.moved-2026-11-26T00-23-27-593Z'), 'target-skill')

    const moved = await relocateLegacyBackups(skillsRoot)
    expect(moved.sort()).toEqual([
      'target-skill.bak-2026-11-26T00-14-37-297Z',
      'target-skill.moved-2026-11-26T00-23-27-593Z',
    ])

    // 备份根里两份都在（保留，不删除）。
    for (const name of moved) {
      expect(existsSync(join(backupRootFor(skillsRoot), name))).toBe(true)
    }
    // 扫描根只剩目标技能。
    const entries = await scanRoot(skillsRoot)
    expect(entries.map((e) => e.directory)).toEqual([join(skillsRoot, 'target-skill')])
  })

  it('leaves normal skills untouched', async () => {
    const skillsRoot = rootPath('user-dsh', home)
    await seed(join(skillsRoot, 'keep-me'), 'keep-me')
    expect(await relocateLegacyBackups(skillsRoot)).toEqual([])
    expect(existsSync(join(skillsRoot, 'keep-me', 'SKILL.md'))).toBe(true)
  })
})

describe('disabled-skill scan entry also skips non-skill entries', () => {
  it('does not surface a .moved-* directory as a disabled skill', async () => {
    // 第二处扫描入口是 scanDiagnostics 走的同一条 scanRoot 路径；
    // 这里用同一个根同时放「正常技能」与「迁移遗留」，确认只剩正常那份。
    const skillsRoot = rootPath('user-dsh', home)
    await seed(join(skillsRoot, 'live-skill'), 'live-skill')
    await seed(join(skillsRoot, 'live-skill.moved-2026-11-26T00-23-27-593Z'), 'live-skill')
    await seed(join(skillsRoot, 'live-skill.bak-2026-11-26T00-14-37-297Z'), 'live-skill')

    const entries = await scanRoot(skillsRoot)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.directory.endsWith('live-skill')).toBe(true)
  })
})
