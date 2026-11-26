/**
 * provider 的根覆盖：外部 Agent 技能根只读并入主列表。
 *
 * 关键约束（改了就是数据损坏级别的 bug）：
 * - 外部来源的 source 必须是 `agent-*`，因此 isWritableSource 为 false；
 * - 同名时 dsh 自己的那份赢（rank 更低）；
 * - 外部根不存在时不能抛错。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SkillHubProvider } from './provider.ts'

let home: string
let userHome: string

const control = (): { signal: AbortSignal; invalidate: () => void } => ({
  signal: new AbortController().signal,
  invalidate: () => {},
})

/** 在目录里造一个技能。 */
async function seedSkill(root: string, name: string, description = 'd'): Promise<void> {
  await mkdir(join(root, name), { recursive: true })
  await writeFile(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`, 'utf8')
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'hub-provider-home-'))
  userHome = await mkdtemp(join(tmpdir(), 'hub-provider-user-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(userHome, { recursive: true, force: true })
})

describe('SkillHubProvider foreign roots', () => {
  it('lists skills from other agents as read-only agent-* sources', async () => {
    await seedSkill(join(home, 'skills'), 'dsh-one')
    await seedSkill(join(userHome, '.trae-cn', 'skills'), 'trae-one')

    const provider = new SkillHubProvider(control(), home, async () => new Set(), userHome)
    const list = await provider.list({})
    const byName = new Map(list.map((candidate) => [candidate.name, candidate]))

    expect(byName.get('dsh-one')?.source).toBe('user-dsh')
    expect(byName.get('trae-one')?.source).toBe('agent-trae-cn')
  })

  it('keeps the dsh copy when a foreign root has the same skill name', async () => {
    await seedSkill(join(home, 'skills'), 'shared', 'from dsh')
    await seedSkill(join(userHome, '.trae-cn', 'skills'), 'shared', 'from trae')

    const provider = new SkillHubProvider(control(), home, async () => new Set(), userHome)
    const list = await provider.list({})
    const shared = list.filter((candidate) => candidate.name === 'shared')

    // 两行都在（source 不同），但 dsh 的 rank 更低，注册表会选它。
    expect(shared).toHaveLength(2)
    const dsh = shared.find((candidate) => candidate.source === 'user-dsh')
    const trae = shared.find((candidate) => candidate.source === 'agent-trae-cn')
    expect(dsh?.rank).toBeLessThan(trae?.rank ?? 0)
  })

  it('does not fail when a foreign root is absent', async () => {
    await seedSkill(join(home, 'skills'), 'only-dsh')
    const provider = new SkillHubProvider(control(), home, async () => new Set(), userHome)
    const list = await provider.list({})
    // `user-agents` 根解析的是真实 ~/.agents（跨 agent 共享），测试无法隔离它，
    // 所以只断言 dsh 根里的那个技能在，且没有来自临时 userHome 的外部技能。
    expect(list.map((candidate) => candidate.name)).toContain('only-dsh')
    expect(list.some((candidate) => candidate.source === 'agent-trae-cn')).toBe(false)
  })

  it('marks foreign skills non-writable so the hub never edits them', async () => {
    await seedSkill(join(userHome, '.trae-cn', 'skills'), 'trae-only')
    const provider = new SkillHubProvider(control(), home, async () => new Set(), userHome)
    const list = await provider.list({})
    const trae = list.find((candidate) => candidate.name === 'trae-only')
    // 可写根只有 user-dsh / user-agents；agent-* 必须落在外面。
    expect(trae?.source.startsWith('agent-')).toBe(true)
  })

  it('omits foreign roots when includeForeign is false (the agent/invocation layer)', async () => {
    await seedSkill(join(home, 'skills'), 'dsh-one')
    await seedSkill(join(userHome, '.trae-cn', 'skills'), 'trae-one')

    // 管理视图（global 层）看全量。
    const globalProvider = new SkillHubProvider(control(), home, async () => new Set(), userHome, true)
    expect((await globalProvider.list({})).map((candidate) => candidate.name)).toContain('trae-one')

    // 调用视图（agent 层）必须只含 dsh 自己的根：这一层比 preset 更近，
    // 塞进外部技能会遮蔽 preset 原生技能，而外部来源又不可写 —— 表现就是
    // 「面板看得见、模型调不动」。
    const agentProvider = new SkillHubProvider(control(), home, async () => new Set(), userHome, false)
    const agentList = await agentProvider.list({})
    expect(agentList.map((candidate) => candidate.name)).not.toContain('trae-one')
    expect(agentList.map((candidate) => candidate.name)).toContain('dsh-one')
    expect(agentList.every((candidate) => candidate.source.startsWith('agent-') === false)).toBe(true)
  })
})
