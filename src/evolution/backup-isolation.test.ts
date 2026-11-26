/**
 * 落地备份不能污染 provider 扫描根。
 *
 * 真实故障：替换已有技能时备份写成 `<skills根>/<name>.bak-<ts>/`，它仍在
 * provider 扫描范围内，且 frontmatter name 与原技能相同 —— registry 报
 * 「同名不可达」+「名称与发现路径不一致」，诊断面板直接炸出两条异常。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyProposal, backupRootFor } from './apply.ts'
import { projectSkillsRoot, rootPath } from '../skillfs/paths.ts'
import { scanRoot } from '../skillfs.ts'
import type { EvolutionProposal } from '../protocol/evolution.ts'

let home: string
let workspace: string

const proposal = (overrides: Partial<EvolutionProposal> = {}): EvolutionProposal => ({
  id: 'p1',
  kind: 'new-skill',
  skillName: 'demo-skill',
  displayName: '演示',
  createdAt: 1,
  status: 'pending',
  recommendation: 'create',
  priority: 'medium',
  occurrences: 3,
  scenario: '场景',
  draft: '## 何时使用\nx\n\n## 步骤\n1. a\n2. b\n\n## 边界\n- 无',
  ...overrides,
})

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'hub-bak-home-'))
  workspace = await mkdtemp(join(tmpdir(), 'hub-bak-ws-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(workspace, { recursive: true, force: true })
})

describe('backupRootFor', () => {
  it('places backups beside the skills root, not inside it', () => {
    const skillsRoot = join(home, 'skills')
    const backupRoot = backupRootFor(skillsRoot)
    // 关键：备份根不能是 skills 根的子目录。
    expect(backupRoot.startsWith(skillsRoot)).toBe(false)
    expect(dirname(backupRoot)).toBe(dirname(skillsRoot))
  })

  it('works for a workspace skills root too', () => {
    const skillsRoot = projectSkillsRoot(workspace)
    const backupRoot = backupRootFor(skillsRoot)
    expect(backupRoot.startsWith(skillsRoot)).toBe(false)
    expect(backupRoot).toContain('.skill-backups')
  })
})

describe('replacing a skill does not pollute the scan root', () => {
  it('writes the backup outside the skills root', async () => {
    const first = await applyProposal(proposal(), home)
    expect(first.ok).toBe(true)

    const second = await applyProposal(
      proposal({ draft: '## 何时使用\n改进\n\n## 步骤\n1. c\n2. d\n\n## 边界\n- 无' }),
      home,
      'user-dsh',
      1_700_000_000_000,
    )
    expect(second.ok).toBe(true)
    expect(second.backupPath).toBeDefined()

    const skillsRoot = rootPath('user-dsh', home)
    // 这是核心断言：备份路径不在 skills 根内。
    expect(second.backupPath?.startsWith(skillsRoot)).toBe(false)
    expect(existsSync(second.backupPath ?? '')).toBe(true)
  })

  it('the scan root only reports the live skill, never the backup', async () => {
    await applyProposal(proposal(), home)
    await applyProposal(
      proposal({ draft: '## 何时使用\n改进\n\n## 步骤\n1. c\n2. d\n\n## 边界\n- 无' }),
      home,
      'user-dsh',
      1_700_000_000_000,
    )
    const entries = await scanRoot(rootPath('user-dsh', home))
    const dirs = entries.map((entry) => entry.directory)
    // 只有一份 demo-skill，没有任何 .bak-* 目录。
    expect(dirs.filter((d) => d.endsWith('demo-skill'))).toHaveLength(1)
    expect(dirs.some((d) => d.includes('.bak-'))).toBe(false)
  })
})

describe('scanRoot skips legacy .bak-* entries', () => {
  it('ignores a leftover backup directory inside the root', async () => {
    const skillsRoot = rootPath('user-dsh', home)
    // 模拟历史遗留：备份仍在 skills 根里。
    const legacy = join(skillsRoot, 'demo-skill.bak-2026-11-26T00-14-37-297Z')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'SKILL.md'), '---\nname: demo-skill\ndescription: d\n---\n\nbody\n', 'utf8')
    // 同时有一个正常的技能。
    const live = join(skillsRoot, 'demo-skill')
    await mkdir(live, { recursive: true })
    await writeFile(join(live, 'SKILL.md'), '---\nname: demo-skill\ndescription: d\n---\n\nbody\n', 'utf8')

    const entries = await scanRoot(skillsRoot)
    // 备份被跳过，只剩一份。
    expect(entries).toHaveLength(1)
    expect(entries[0]?.directory).toBe(live)
  })
})

describe('workspace landing still writes to the workspace', () => {
  it('puts the skill in <workspace>/.dsh/skills and keeps backups out', async () => {
    await mkdir(projectSkillsRoot(workspace), { recursive: true })
    const first = await applyProposal(proposal(), home, 'project', Date.now(), workspace)
    expect(first.ok).toBe(true)
    expect(first.path).toBe(join(projectSkillsRoot(workspace), 'demo-skill', 'SKILL.md'))

    const second = await applyProposal(
      proposal({ draft: '## 何时使用\nv2\n\n## 步骤\n1. x\n2. y\n\n## 边界\n- 无' }),
      home,
      'project',
      1_700_000_000_000,
      workspace,
    )
    expect(second.ok).toBe(true)
    // 备份也在工作区侧，且不在扫描根内。
    expect(second.backupPath?.startsWith(projectSkillsRoot(workspace))).toBe(false)
    expect(second.backupPath).toContain('.skill-backups')

    const entries = await scanRoot(projectSkillsRoot(workspace))
    expect(entries).toHaveLength(1)
    expect(entries.some((e) => e.directory.includes('.bak-'))).toBe(false)
  })
})
