/**
 * 外部 Agent 技能的三项能力：可调用 / 可停用 / 可删除。
 *
 * 这三条是用户明确要求的，任何一条回退都会让那 55 个 Trae 技能变成摆设。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SkillHubProvider } from './provider.ts'
import { foreignRootOfPath } from './skillfs/paths.ts'

let home: string
let userHome: string

const control = (): { signal: AbortSignal; invalidate: () => void } => ({
  signal: new AbortController().signal,
  invalidate: () => {},
})

async function seedSkill(root: string, name: string): Promise<void> {
  await mkdir(join(root, name), { recursive: true })
  await writeFile(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n\nbody of ${name}\n`, 'utf8')
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'hub-foreign-home-'))
  userHome = await mkdtemp(join(tmpdir(), 'hub-foreign-user-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(userHome, { recursive: true, force: true })
})

describe('foreign agent skills are first-class', () => {
  it('1) are callable: listed with a loadable body', async () => {
    await seedSkill(join(userHome, '.trae-cn', 'skills'), 'trae-callable')
    const provider = new SkillHubProvider(control(), home, async () => new Set(), userHome, true)
    const list = await provider.list({})
    const candidate = list.find((item) => item.name === 'trae-callable')
    expect(candidate?.source).toBe('agent-trae-cn')
    // 能出现在列表还不够：正文必须真的读得出来，否则模型拿到空技能。
    const loaded = candidate === undefined ? undefined : await provider.get(candidate)
    expect(loaded?.content).toContain('body of trae-callable')
  })

  it('2) are disableable: the discovery path resolves to a known foreign root', async () => {
    await seedSkill(join(userHome, '.trae-cn', 'skills'), 'trae-disable')
    const provider = new SkillHubProvider(control(), home, async () => new Set(), userHome, true)
    const candidate = (await provider.list({})).find((item) => item.name === 'trae-disable')
    expect(candidate?.path).toBeDefined()
    // 停用走 invocation 覆盖，需要能确认「这个路径属于已知外部根」。
    expect(foreignRootOfPath(candidate?.path ?? '', userHome)).toBe('trae-cn')
  })

  it('3) are deletable: only inside a known foreign root', async () => {
    await seedSkill(join(userHome, '.trae-cn', 'skills'), 'trae-delete')
    const provider = new SkillHubProvider(control(), home, async () => new Set(), userHome, true)
    const candidate = (await provider.list({})).find((item) => item.name === 'trae-delete')
    const inside = candidate?.path ?? ''
    expect(foreignRootOfPath(inside, userHome)).toBe('trae-cn')
    // 外部根之外的路径必须拒绝，否则删除动作能被诱导到任意位置。
    expect(foreignRootOfPath(join(home, 'skills', 'x', 'SKILL.md'), userHome)).toBeUndefined()
    expect(foreignRootOfPath(join(userHome, '.ssh', 'id_rsa'), userHome)).toBeUndefined()
  })

  it('keeps dsh own skills winning when a foreign root has the same name', async () => {
    await seedSkill(join(home, 'skills'), 'shared-name')
    await seedSkill(join(userHome, '.trae-cn', 'skills'), 'shared-name')
    const provider = new SkillHubProvider(control(), home, async () => new Set(), userHome, true)
    const list = await provider.list({})
    const rows = list.filter((item) => item.name === 'shared-name')
    const dsh = rows.find((item) => item.source === 'user-dsh')
    const trae = rows.find((item) => item.source === 'agent-trae-cn')
    // 两行都在，但 dsh 的 rank 更低 —— 注册表会选它，删除/停用不会误伤外部文件。
    expect(dsh?.rank).toBeLessThan(trae?.rank ?? 0)
  })
})
