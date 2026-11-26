/**
 * 工作区（项目级）技能的移入回收站。
 *
 * 项目级技能（project-dsh / project-agents）不在 dsh 的用户可写根里，
 * 早期删除路由会 409 拒绝，于是工作区页压根没法回收它们。
 * 现在新增 resolveProjectSkill：只接受「落在已登记工作区 skills 目录内」的路径。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isProjectSource } from '../client/grouping.ts'

let workspace: string

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'hub-project-trash-'))
  await mkdir(join(workspace, '.dsh', 'skills', 'demo-project-skill'), { recursive: true })
  await writeFile(
    join(workspace, '.dsh', 'skills', 'demo-project-skill', 'SKILL.md'),
    '---\nname: demo-project-skill\ndescription: d\n---\n\nbody\n',
    'utf8',
  )
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

describe('project skill identification', () => {
  it('recognises both project sources', () => {
    expect(isProjectSource('project-dsh')).toBe(true)
    expect(isProjectSource('project-agents')).toBe(true)
  })

  it('does not treat user or foreign roots as project skills', () => {
    expect(isProjectSource('user-dsh')).toBe(false)
    expect(isProjectSource('user-agents')).toBe(false)
    expect(isProjectSource('agent-trae-cn')).toBe(false)
  })
})

describe('containment rule for project trash', () => {
  /** 复刻 resolveProjectSkill 的包含判定。 */
  const inside = (root: string, target: string): boolean => {
    const normalize = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    const r = normalize(root)
    const t = normalize(target)
    return t === r || t.startsWith(r + '/')
  }

  const skillsRoot = (): string => join(workspace, '.dsh', 'skills')

  it('accepts a path inside the workspace skills root', () => {
    expect(inside(skillsRoot(), join(skillsRoot(), 'demo-project-skill', 'SKILL.md'))).toBe(true)
  })

  it('rejects a path outside it', () => {
    expect(inside(skillsRoot(), join(workspace, 'src', 'index.ts'))).toBe(false)
    expect(inside(skillsRoot(), join(tmpdir(), 'other', 'SKILL.md'))).toBe(false)
  })

  it('rejects a sibling directory that only shares a prefix', () => {
    // skills-evil 不该被 skills 的包含判定吃掉。
    expect(inside(skillsRoot(), join(workspace, '.dsh', 'skills-evil', 'SKILL.md'))).toBe(false)
  })

  it('accepts the root itself (directory-shaped skill)', () => {
    expect(inside(skillsRoot(), skillsRoot())).toBe(true)
  })

  it('is case- and separator-insensitive on Windows paths', () => {
    const upper = skillsRoot().toUpperCase().replace(/\//g, '\\')
    expect(inside(skillsRoot(), join(upper, 'X', 'SKILL.md'))).toBe(true)
  })
})
