/** 提案落地：新建带版本标签、替换带备份、拒绝未审核提案。 */
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyProposal, buildSkillFile, nextVersionTag, rejectionKey } from './apply.ts'
import type { EvolutionProposal } from '../protocol/evolution.ts'

let home: string

const proposal = (overrides: Partial<EvolutionProposal> = {}): EvolutionProposal => ({
  id: 'p1',
  kind: 'new-skill',
  skillName: 'demo-skill',
  createdAt: 1,
  status: 'accepted',
  draft: '## 何时使用\n做演示\n\n## 步骤\n1. 一步\n\n## 边界\n- 无',
  ...overrides,
})

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'hub-evolution-apply-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('applyProposal', () => {
  it('accepts a pending proposal (status is set after landing)', async () => {
    // 早期实现要求 status === 'accepted' 才能落地，但状态是落地**成功后**才改的，
    // 于是永远报 `proposal is not accepted: pending`。现在 pending 可以落地。
    const outcome = await applyProposal(proposal({ status: 'pending' }), home)
    expect(outcome.ok).toBe(true)
  })

  it('refuses a rejected proposal', async () => {
    const outcome = await applyProposal(proposal({ status: 'rejected' }), home)
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('rejected')
  })

  it('refuses a deferred proposal', async () => {
    const outcome = await applyProposal(proposal({ status: 'deferred' }), home)
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('deferred')
  })

  it('refuses a reclaim proposal (it goes to trash, not to a new skill)', async () => {
    const outcome = await applyProposal(proposal({ kind: 'reclaim' }), home)
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('reclaim')
  })

  it('refuses an invalid skill name', async () => {
    const outcome = await applyProposal(proposal({ skillName: 'Bad Name!' }), home)
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('not a valid skill name')
  })

  it('creates the skill file with a version tag', async () => {
    const outcome = await applyProposal(proposal(), home)
    expect(outcome.ok).toBe(true)
    expect(outcome.version).toBe('0.1.1')
    const file = join(home, 'skills', 'demo-skill', 'SKILL.md')
    expect(existsSync(file)).toBe(true)
    const text = await readFile(file, 'utf8')
    expect(text).toContain('name: demo-skill')
    expect(text).toContain('version: 0.1.1')
    expect(text).toContain('## 何时使用')
  })

  it('backs up the old file before replacing, and bumps the version', async () => {
    const first = await applyProposal(proposal(), home)
    expect(first.ok).toBe(true)

    const second = await applyProposal(
      proposal({ draft: '## 何时使用\n改进版\n\n## 步骤\n1. 二步\n\n## 边界\n- 无' }),
      home,
      'user-dsh',
      1_700_000_000_000,
    )
    expect(second.ok).toBe(true)
    expect(second.version).toBe('0.1.2')
    expect(second.backupPath).toBeDefined()
    expect(existsSync(second.backupPath ?? '')).toBe(true)

    // 备份里应是旧内容，新文件里是新内容。
    const backup = await readFile(join(second.backupPath ?? '', 'SKILL.md'), 'utf8')
    expect(backup).toContain('做演示')
    const current = await readFile(join(home, 'skills', 'demo-skill', 'SKILL.md'), 'utf8')
    expect(current).toContain('改进版')
  })

  it('writes into the requested root', async () => {
    // `user-agents` 解析的是 `~/.agents`（跨 agent 共享的真实目录），测试必须
    // 用 DSH_AGENTS_HOME 把它指到临时目录 —— 否则会往用户真实的技能目录里
    // 写文件（这个坑真的踩过：一次测试把 demo-skill 写进了 ~/.agents/skills）。
    const agentsHome = await mkdtemp(join(tmpdir(), 'hub-agents-home-'))
    const previous = process.env.DSH_AGENTS_HOME
    process.env.DSH_AGENTS_HOME = agentsHome
    try {
      const outcome = await applyProposal(proposal(), home, 'user-agents')
      expect(outcome.ok).toBe(true)
      expect(outcome.path).toContain(join(agentsHome, 'skills', 'demo-skill'))
      // 确认没有写到真实目录。
      expect(existsSync(join(home, 'skills', 'demo-skill'))).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.DSH_AGENTS_HOME
      else process.env.DSH_AGENTS_HOME = previous
      await rm(agentsHome, { recursive: true, force: true })
    }
  })
})

describe('buildSkillFile', () => {
  it('strips a whole-document code fence', () => {
    const text = buildSkillFile(proposal({ draft: '```markdown\n## 何时使用\nx\n```' }), '0.1.1')
    expect(text).not.toContain('```')
    expect(text).toContain('## 何时使用')
  })

  it('preserves an existing frontmatter and only replaces the version', () => {
    const draft = '---\nname: demo-skill\ndescription: 已有描述\nversion: 9.9.9\n---\n\n## 何时使用\nx'
    const text = buildSkillFile(proposal({ draft }), '0.2.0')
    expect(text).toContain('description: 已有描述')
    expect(text).toContain('version: 0.2.0')
    expect(text).not.toContain('9.9.9')
  })
})

describe('nextVersionTag', () => {
  it('increments the patch component', () => {
    expect(nextVersionTag(['0.1.1'])).toBe('0.1.2')
    expect(nextVersionTag(['0.1.1', '0.1.7'])).toBe('0.1.8')
  })

  it('starts at 0.1.1 with no history', () => {
    expect(nextVersionTag([])).toBe('0.1.1')
  })
})

describe('rejectionKey', () => {
  it('normalizes case and punctuation so the same scenario dedupes', () => {
    expect(rejectionKey('Release Notes', '整理 发布说明！')).toBe(rejectionKey('release-notes', '整理发布说明'))
  })

  it('keeps different scenarios apart', () => {
    expect(rejectionKey('a', '场景一')).not.toBe(rejectionKey('a', '场景二'))
  })
})

describe('listing skill dirs', () => {
  it('skips backup directories', async () => {
    await mkdir(join(home, 'skills', 'real'), { recursive: true })
    await mkdir(join(home, 'skills', 'real.bak-2026'), { recursive: true })
    const { listSkillDirs } = await import('./apply.ts')
    const dirs = await listSkillDirs(join(home, 'skills'))
    expect(dirs).toContain('real')
    expect(dirs).not.toContain('real.bak-2026')
    // 目录列表只读，不该写出任何文件。
    expect((await readdir(join(home, 'skills'))).sort()).toEqual(['real', 'real.bak-2026'])
  })
})
