/**
 * Auto role classification: keyword rules must place real skill names from
 * this machine into sensible groups, must never drop a skill, and must send
 * weak evidence to `other` rather than guessing.
 */
import { describe, expect, it } from 'vitest'
import { classifyRole, groupByRole } from './grouping.ts'
import type { CatalogSkill } from '../protocol.ts'

const skill = (name: string, description = ''): CatalogSkill => ({
  name,
  description,
  invocation: { modelInvocable: true, userInvocable: false },
  provider: 'test',
  writable: false,
  source: 'user-dsh',
})

describe('classifyRole', () => {
  it('routes office file skills to the office role', () => {
    expect(classifyRole(skill('office', 'Create, read, edit Word, PowerPoint and Excel files'))).toBe('office')
  })

  it('routes design skills to design', () => {
    expect(classifyRole(skill('frontend-design', 'visual design and typography'))).toBe('design')
  })

  it('routes test-first skills to dev', () => {
    expect(classifyRole(skill('tdd', 'test-driven development, red-green-refactor'))).toBe('dev')
  })

  it('routes image and video skills to media', () => {
    expect(classifyRole(skill('frame-smith', 'promo videos as Remotion compositions, motion'))).toBe('media')
  })

  it('routes search skills to research', () => {
    expect(classifyRole(skill('find-skills', 'Search and discover skills from various sources'))).toBe('research')
  })

  it('routes writing skills to doc', () => {
    expect(classifyRole(skill('writing-plans', 'Use when you have a spec or requirements'))).toBe('doc')
  })

  it('falls back to other when evidence is weak', () => {
    expect(classifyRole(skill('zulu', 'nothing recognizable here'))).toBe('other')
  })

  it('never matches a short keyword inside a longer word', () => {
    // Short keywords need a whole token: `art` must not fire on `start`,
    // `ui` must not fire on `quick`.
    expect(classifyRole(skill('start', 'plain text'))).toBe('other')
    expect(classifyRole(skill('quick', 'plain text'))).toBe('other')
  })

  it('matches a long keyword as a prefix of an inflected word', () => {
    // `install` should still find `installing` in prose.
    expect(classifyRole(skill('setup-tool', 'installing things on a machine'))).toBe('ops')
  })

  it('reads Chinese descriptions', () => {
    // CJK runs are tokenized per character, so 排版 must match inside a longer run.
    expect(classifyRole(skill('guizang-page-skill', '把文档排版成网页，生成精排单页'))).toBe('doc')
  })
})

describe('groupByRole', () => {
  it('drops empty roles and puts other last', () => {
    const groups = groupByRole([skill('tdd', 'test driven development'), skill('zulu', 'plain')])
    expect(groups.map((g) => g.id)).toEqual(['dev', 'other'])
    expect(groups[1].skills.map((s) => s.name)).toEqual(['zulu'])
  })

  it('leaves project skills out', () => {
    const project = { ...skill('tdd', 'test driven development'), source: 'project-dsh' }
    expect(groupByRole([project]).map((g) => g.id)).not.toContain('dev')
  })

  it('groups a mixed catalog into the expected roles', () => {
    const groups = groupByRole([
      skill('office', 'Create Word, PowerPoint and Excel files'),
      skill('frontend-design', 'visual design and typography'),
      skill('tdd', 'test-driven development'),
      skill('frame-smith', 'promo videos as Remotion compositions'),
      skill('find-skills', 'Search and discover skills'),
      skill('diagnose-windows-sandbox-acl', 'Windows sandbox access denials'),
      skill('zulu', 'plain'),
    ])
    expect(groups.map((g) => g.id)).toEqual(['office', 'design', 'dev', 'media', 'research', 'ops', 'other'])
    expect(groups.reduce((sum, g) => sum + g.skills.length, 0)).toBe(7)
  })

  it('keeps every skill, never dropping one', () => {
    const skills = [skill('aaa'), skill('bbb'), skill('ccc')]
    expect(groupByRole(skills).flatMap((g) => g.skills).length).toBe(3)
  })
})