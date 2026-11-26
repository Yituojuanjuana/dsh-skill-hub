/**
 * 细分专项落地到工作区。
 *
 * 真实故障：进化页点「同意并落地」后技能写进了 `~/.dsh/skills`，而「工作区」
 * 页只扫 `<workspace>/.dsh/skills` —— 文件写成功了，但写错地方，所以永远
 * 不出现在那个列表里。
 *
 * 修复：提案带 `targetRoot: 'project'` + `targetWorkspace`，落地时写进
 * `<workspace>/.dsh/skills`。
 */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyProposal } from './apply.ts'
import { projectSkillsRoot } from '../skillfs/paths.ts'
import type { EvolutionProposal } from '../protocol/evolution.ts'

let home: string
let workspace: string

const proposal = (overrides: Partial<EvolutionProposal> = {}): EvolutionProposal => ({
  id: 'p1',
  kind: 'new-skill',
  skillName: 'sports-coach-card-align',
  displayName: '预约卡片对齐',
  createdAt: 1,
  status: 'pending',
  recommendation: 'niche',
  priority: 'medium',
  occurrences: 4,
  scenario: '抢单大厅卡片对齐',
  draft: '## 何时使用\n改卡片对齐时\n\n## 步骤\n1. 一\n2. 二\n\n## 边界\n- 无',
  ...overrides,
})

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'hub-apply-home-'))
  workspace = await mkdtemp(join(tmpdir(), 'hub-apply-workspace-'))
  await mkdir(projectSkillsRoot(workspace), { recursive: true })
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(workspace, { recursive: true, force: true })
})

describe('landing a niche skill into a workspace', () => {
  it('writes the skill into the workspace .dsh/skills directory', async () => {
    const outcome = await applyProposal(
      proposal({ targetRoot: 'project', targetWorkspace: workspace }),
      home,
      'project',
      Date.now(),
      workspace,
    )
    expect(outcome.ok).toBe(true)
    const expected = join(projectSkillsRoot(workspace), 'sports-coach-card-align', 'SKILL.md')
    expect(outcome.path).toBe(expected)
    expect(existsSync(expected)).toBe(true)
  })

  it('does NOT write it into the DSH user skills root', async () => {
    await applyProposal(proposal(), home, 'project', Date.now(), workspace)
    // 这是修复前的问题所在：技能落到了 ~/.dsh/skills，工作区页看不到。
    expect(existsSync(join(home, 'skills', 'sports-coach-card-align'))).toBe(false)
  })

  it('produces a loadable SKILL.md with frontmatter and version', async () => {
    const outcome = await applyProposal(proposal(), home, 'project', Date.now(), workspace)
    const text = await readFile(outcome.path ?? '', 'utf8')
    expect(text).toContain('name: sports-coach-card-align')
    expect(text).toContain('version: 0.1.1')
    expect(text).toContain('## 何时使用')
  })

  it('refuses a project landing without a workspace path', async () => {
    const outcome = await applyProposal(proposal(), home, 'project', Date.now(), undefined)
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('工作区路径')
  })

  it('creates the workspace skills directory when it does not exist yet', async () => {
    const fresh = await mkdtemp(join(tmpdir(), 'hub-apply-fresh-'))
    try {
      const outcome = await applyProposal(proposal(), home, 'project', Date.now(), fresh)
      expect(outcome.ok).toBe(true)
      expect(existsSync(join(projectSkillsRoot(fresh), 'sports-coach-card-align', 'SKILL.md'))).toBe(true)
    } finally {
      await rm(fresh, { recursive: true, force: true })
    }
  })
})

describe('generic skills still land in the DSH root', () => {
  it('writes to ~/.dsh/skills by default', async () => {
    const outcome = await applyProposal(
      proposal({ skillName: 'generic-skill', recommendation: 'create', targetRoot: 'user-dsh' }),
      home,
    )
    expect(outcome.ok).toBe(true)
    expect(outcome.path).toBe(join(home, 'skills', 'generic-skill', 'SKILL.md'))
    expect(existsSync(join(projectSkillsRoot(workspace), 'generic-skill'))).toBe(false)
  })
})

describe('optimize proposals keep their original location', () => {
  it('still writes to the user root when no project target is set', async () => {
    const outcome = await applyProposal(
      proposal({
        kind: 'optimize',
        skillName: 'existing-skill',
        changeType: 'modify',
        painPoints: '触发条件模糊',
        newSource: '---\nname: existing-skill\n---\n新正文',
        testCases: '正向 / 边界',
        riskAssessment: '低',
        draft: '---\nname: existing-skill\n---\n新正文',
      }),
      home,
    )
    expect(outcome.ok).toBe(true)
    expect(outcome.path).toBe(join(home, 'skills', 'existing-skill', 'SKILL.md'))
  })
})

describe('workspace landing replaces and backs up', () => {
  it('backs up the old version before overwriting inside the workspace', async () => {
    const first = await applyProposal(proposal(), home, 'project', Date.now(), workspace)
    expect(first.ok).toBe(true)
    const second = await applyProposal(
      proposal({ draft: '## 何时使用\n改进版\n\n## 步骤\n1. 二\n2. 三\n\n## 边界\n- 无' }),
      home,
      'project',
      1_700_000_000_000,
      workspace,
    )
    expect(second.ok).toBe(true)
    expect(second.backupPath).toBeDefined()
    // 备份在工作区侧，但**不在 skills 扫描根内** —— 否则会被当成第二份技能注册，
    // 触发「同名不可达」异常（这正是上一轮的真实故障）。
    expect(second.backupPath).toContain('.skill-backups')
    expect(second.backupPath?.startsWith(projectSkillsRoot(workspace))).toBe(false)
    expect(second.version).toBe('0.1.2')
  })
})
