/**
 * buildCatalog 的根覆盖回归测试。
 *
 * 曾经的 bug：只在「没有任何工作区」时才读一次不带 cwd 的全局快照，
 * 于是一旦存在工作区，带 cwd 的快照若不含 global 层，用户级技能就整片消失
 * ——表现是「有目录却检测不到」。这里锁住「工作区存在时用户级技能仍在」。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
import { buildCatalog } from './catalog-data.ts'
import { SkillHubStore } from '../store.ts'
import { statePath } from '../store/paths.ts'
import type { SkillHubRouteDeps } from './helpers.ts'

let dir: string

const summary = (name: string, source: string): SkillSummary => ({
  name,
  description: 'd',
  source,
  provider: 'skill-shelf',
  invocation: { modelInvocable: true, userInvocable: true },
  path: `C:/x/${name}/SKILL.md`,
})

/** 构造一个 deps：带 cwd 的快照只返回项目技能（模拟「不含 global 层」的宿主）。 */
function depsWith(snapshot: (lookup?: { cwd?: string }) => Promise<{ skills: SkillSummary[]; complete: boolean }>): SkillHubRouteDeps {
  return {
    skills: {
      snapshot,
      get: async () => undefined,
    },
    store: new SkillHubStore(statePath(dir)),
    home: dir,
    userHome: dir,
    config: () => ({ enabled: true, announceToAgent: true, showUseCount: true, showUseTime: true, showGroupSummary: true }),
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'skill-hub-catalog-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('buildCatalog root coverage', () => {
  it('keeps user-level skills even when the cwd snapshot omits the global layer', async () => {
    const deps = depsWith(async (lookup) => {
      // 带 cwd：只回项目技能（这正是会吞掉用户级技能的宿主语义）。
      if (lookup?.cwd !== undefined) {
        return { skills: [summary('project-only', 'project-dsh')], complete: true }
      }
      return { skills: [summary('github', 'user-dsh'), summary('pdf', 'user-dsh')], complete: true }
    })
    // 让 workspaceEntries 读到一个真实工作区。
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(dir, 'storages'), { recursive: true })
    await writeFile(join(dir, 'storages', 'workspace.json'), JSON.stringify({
      tables: { workspaces: { a: { path: 'C:/proj', title: 'proj' } } },
    }), 'utf8')

    const catalog = await buildCatalog(deps)
    const names = catalog.skills.map((skill) => skill.name)
    expect(names).toContain('github')
    expect(names).toContain('pdf')
    expect(names).toContain('project-only')
  })

  it('still lists user-level skills when no workspace is configured', async () => {
    const deps = depsWith(async () => ({ skills: [summary('github', 'user-dsh')], complete: true }))
    const catalog = await buildCatalog(deps)
    expect(catalog.skills.map((skill) => skill.name)).toContain('github')
  })

  it('marks the catalog incomplete when any snapshot is incomplete', async () => {
    const deps = depsWith(async (lookup) => ({
      skills: [summary(lookup?.cwd === undefined ? 'github' : 'p', lookup?.cwd === undefined ? 'user-dsh' : 'project-dsh')],
      complete: lookup?.cwd === undefined,
    }))
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(dir, 'storages'), { recursive: true })
    await writeFile(join(dir, 'storages', 'workspace.json'), JSON.stringify({
      tables: { workspaces: { a: { path: 'C:/proj', title: 'proj' } } },
    }), 'utf8')

    const catalog = await buildCatalog(deps)
    expect(catalog.complete).toBe(false)
  })
})
