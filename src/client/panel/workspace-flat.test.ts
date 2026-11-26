/**
 * 工作区页：选中单个工作区时平铺展示。
 *
 * 用户原话：「选择了项目文件夹之后，直接显示该项目文件夹下的所有技能，
 * 不要折叠显示，不要重复出现『项目级』和『项目文件夹名称』」。
 *
 * 判定条件只有一个：`hub.workspace !== ''`（选了具体工作区）。
 * 选「全部工作区」时保留原有分组树。
 */
import { describe, expect, it } from 'vitest'

interface FakeSkill {
  name: string
  source: string
  workspace?: string
}

/** 复刻 WorkspaceView 的 isFlatView 判定。 */
const isFlatView = (workspace: string): boolean => workspace !== ''

/** 复刻 flatSkills 的去重 + 排序。 */
function flatten(skills: readonly FakeSkill[]): FakeSkill[] {
  const seen = new Set<string>()
  const unique: FakeSkill[] = []
  for (const skill of skills) {
    const key = skill.source + '\u0000' + skill.name
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(skill)
  }
  unique.sort((a, b) => a.name.localeCompare(b.name))
  return unique
}

const SPORTS_COACH = 'E:\\67549\\Desktop\\熊阳阳\\sports-coach'

describe('flat vs grouped branch', () => {
  it('flattens when a concrete workspace is selected', () => {
    expect(isFlatView(SPORTS_COACH)).toBe(true)
  })

  it('keeps grouping for "all workspaces"', () => {
    expect(isFlatView('')).toBe(false)
  })
})

describe('flat list content', () => {
  it('lists every skill of the workspace in one layer', () => {
    const skills: FakeSkill[] = [
      { name: 'a-skill', source: 'project-dsh', workspace: SPORTS_COACH },
      { name: 'b-skill', source: 'project-dsh', workspace: SPORTS_COACH },
      { name: 'c-skill', source: 'project-agents', workspace: SPORTS_COACH },
    ]
    expect(flatten(skills).map((s) => s.name)).toEqual(['a-skill', 'b-skill', 'c-skill'])
  })

  it('shows the same name once per root, never twice for the same root', () => {
    // 同一个 name+source 重复出现是脏数据 —— 必须只留一条。
    const skills: FakeSkill[] = [
      { name: 'dup-skill', source: 'project-dsh', workspace: SPORTS_COACH },
      { name: 'dup-skill', source: 'project-dsh', workspace: SPORTS_COACH },
    ]
    const out = flatten(skills)
    expect(out).toHaveLength(1)
    expect(out[0]?.name).toBe('dup-skill')
  })

  it('keeps the same name under two different roots as two rows', () => {
    // 这是合法的：project-dsh 与 project-agents 是两个技能实体。
    const skills: FakeSkill[] = [
      { name: 'shared-name', source: 'project-dsh', workspace: SPORTS_COACH },
      { name: 'shared-name', source: 'project-agents', workspace: SPORTS_COACH },
    ]
    expect(flatten(skills)).toHaveLength(2)
  })

  it('never repeats a skill within a single workspace selection', () => {
    const skills: FakeSkill[] = [
      { name: 'x', source: 'project-dsh', workspace: SPORTS_COACH },
      { name: 'x', source: 'project-dsh', workspace: SPORTS_COACH },
      { name: 'y', source: 'project-dsh', workspace: SPORTS_COACH },
      { name: 'y', source: 'project-dsh', workspace: SPORTS_COACH },
    ]
    const out = flatten(skills)
    expect(out.map((s) => s.name)).toEqual(['x', 'y'])
  })
})

describe('stable ordering', () => {
  it('sorts by name ascending', () => {
    const skills: FakeSkill[] = [
      { name: 'zeta', source: 'project-dsh' },
      { name: 'alpha', source: 'project-dsh' },
      { name: 'mike', source: 'project-dsh' },
    ]
    expect(flatten(skills).map((s) => s.name)).toEqual(['alpha', 'mike', 'zeta'])
  })

  it('produces the same order regardless of input order', () => {
    const a: FakeSkill[] = [
      { name: 'b', source: 'project-dsh' },
      { name: 'a', source: 'project-dsh' },
    ]
    const b: FakeSkill[] = [
      { name: 'a', source: 'project-dsh' },
      { name: 'b', source: 'project-dsh' },
    ]
    expect(flatten(a).map((s) => s.name)).toEqual(flatten(b).map((s) => s.name))
  })

  it('is idempotent', () => {
    const skills: FakeSkill[] = [
      { name: 'q', source: 'project-dsh' },
      { name: 'p', source: 'project-dsh' },
    ]
    const once = flatten(skills)
    expect(flatten(once).map((s) => s.name)).toEqual(once.map((s) => s.name))
  })
})
