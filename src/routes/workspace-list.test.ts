/**
 * 工作区清单的两个硬约束：
 * 1. 传了 cwd 也必须返回**全部**已登记工作区（否则下拉只剩一项）；
 * 2. 每个工作区的 title 必须是干净名称，不是完整路径。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
  provider: 'skill-hub',
  invocation: { modelInvocable: true, userInvocable: true },
  path: `C:/x/${name}/SKILL.md`,
})

function deps(): SkillHubRouteDeps {
  return {
    skills: {
      snapshot: async (lookup) => ({
        skills: lookup?.cwd === undefined ? [summary('user-skill', 'user-dsh')] : [summary('proj-skill', 'project-dsh')],
        complete: true,
      }),
      get: async () => undefined,
    },
    store: new SkillHubStore(statePath(dir)),
    home: dir,
    userHome: dir,
    config: () => ({ enabled: true, announceToAgent: true, showUseCount: true, showUseTime: true, showGroupSummary: true }),
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hub-workspace-list-'))
  await mkdir(join(dir, 'storages'), { recursive: true })
  await writeFile(join(dir, 'storages', 'workspace.json'), JSON.stringify({
    tables: {
      workspaces: {
        a: { path: 'E:/work/alpha', title: 'alpha' },
        b: { path: 'E:/work/beta', title: 'beta' },
      },
    },
  }), 'utf8')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('workspace list', () => {
  it('returns every registered workspace even when a cwd is supplied', async () => {
    const catalog = await buildCatalog(deps(), 'E:/work/alpha')
    const paths = (catalog.workspaces ?? []).map((entry) => entry.path)
    // 这是回归点：以前带 cwd 时这里只剩 ['E:/work/alpha']，下拉因此只有一项。
    expect(paths).toEqual(['E:/work/alpha', 'E:/work/beta'])
  })

  it('titles are workspace names, never full paths', async () => {
    const catalog = await buildCatalog(deps())
    for (const entry of catalog.workspaces ?? []) {
      expect(entry.title).not.toContain('/')
      expect(entry.title).not.toContain('\\')
    }
    expect((catalog.workspaces ?? []).map((entry) => entry.title)).toEqual(['alpha', 'beta'])
  })

  it('still scans only the requested cwd for project skills', async () => {
    const catalog = await buildCatalog(deps(), 'E:/work/alpha')
    const names = catalog.skills.map((skill) => skill.name)
    expect(names).toContain('proj-skill')
    // 用户级技能仍然来自全局快照。
    expect(names).toContain('user-skill')
  })
})
