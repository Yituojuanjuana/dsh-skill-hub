import { describe, expect, it } from 'vitest'
import { CATALOG_DESCRIPTION_MAX_LENGTH, computeAnnouncementBudget, type CatalogSkill } from './protocol.ts'

function skill(overrides: Partial<CatalogSkill> = {}): CatalogSkill {
  return {
    name: 'demo',
    description: 'does things',
    invocation: { modelInvocable: true, userInvocable: true },
    provider: 'filesystem',
    writable: true,
    source: 'user-dsh',
    ...overrides,
  }
}

describe('computeAnnouncementBudget', () => {
  it('reports zero for an empty catalog', () => {
    expect(computeAnnouncementBudget([])).toEqual({
      skills: 0,
      chars: 0,
      approxTokens: 0,
      descriptionMaxLength: CATALOG_DESCRIPTION_MAX_LENGTH,
      truncated: 0,
    })
  })

  it('sums name and description but ignores whenToUse, which DSH never renders', () => {
    const budget = computeAnnouncementBudget([
      skill({ name: 'abc', description: 'de', whenToUse: 'fg' }),
    ])
    expect(budget.skills).toBe(1)
    expect(budget.chars).toBe(5)
    expect(budget.approxTokens).toBe(2)
  })

  it('skips skills the model cannot invoke', () => {
    const budget = computeAnnouncementBudget([
      skill({ name: 'model-visible', description: '' }),
      skill({ name: 'hidden', description: '', invocation: { modelInvocable: false, userInvocable: true } }),
    ])
    expect(budget.skills).toBe(1)
    expect(budget.chars).toBe('model-visible'.length)
  })

  it('counts descriptions over the per-entry cap and charges only the rendered length', () => {
    const budget = computeAnnouncementBudget([
      skill({ name: 'a', description: 'x'.repeat(CATALOG_DESCRIPTION_MAX_LENGTH + 100) }),
    ])
    expect(budget.truncated).toBe(1)
    // name (1) + capped description (cap - 3 + '...').
    expect(budget.chars).toBe(1 + CATALOG_DESCRIPTION_MAX_LENGTH)
  })

  it('treats exactly the per-entry cap as untruncated', () => {
    const budget = computeAnnouncementBudget([
      skill({ name: 'a', description: 'x'.repeat(CATALOG_DESCRIPTION_MAX_LENGTH - 1) }),
    ])
    expect(budget.truncated).toBe(0)
    expect(budget.chars).toBe(CATALOG_DESCRIPTION_MAX_LENGTH)
  })

  it('never caps the catalog as a whole: a huge total is not an error', () => {
    const many = Array.from({ length: 100 }, (_, i) =>
      skill({ name: `s${i}`, description: 'x'.repeat(400) }))
    const budget = computeAnnouncementBudget(many)
    expect(budget.skills).toBe(100)
    expect(budget.truncated).toBe(0)
    expect(budget.chars).toBeGreaterThan(8000)
  })
})
