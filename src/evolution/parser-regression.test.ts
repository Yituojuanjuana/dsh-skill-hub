/**
 * 解析器回归测试：用**真实模型输出**做 fixture。
 *
 * 背景：某次运行 sessions=12 messages=917 但 proposals=0，而 markdown 里明明有
 * 5 行表格和 5 个草稿块。原因是解析器只认 `｜` 分隔的草稿标题，而模型写的是
 * 中文冒号 `：`；表格行首尾的 `|` 也没剥掉，导致列错位。
 *
 * 这个 fixture 是那份真实输出的原样保存（40 KB），任何解析回归都会在这里炸。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseProposals } from './engine.ts'

const here = dirname(fileURLToPath(import.meta.url))
const REAL = readFileSync(join(here, '__fixtures__', 'real-markdown.md'), 'utf8')

/** slug：小写字母/数字/连字符。 */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

describe('real model output (regression fixture)', () => {
  const proposals = parseProposals(REAL, 1000)
  const newSkills = proposals.filter((item) => item.kind === 'new-skill')

  it('parses at least 5 new-skill proposals from the saved markdown', () => {
    // 表格里确实有 5 行数据行 —— 少一条都说明解析器又回归了。
    expect(newSkills.length).toBeGreaterThanOrEqual(5)
  })

  it('every parsed skillName is a valid slug (no backticks, no CJK, no spaces)', () => {
    for (const proposal of newSkills) {
      expect(proposal.skillName).toMatch(SLUG)
    }
    // 具体点名，防止「解析出 5 条但名字全错」这种假通过。
    expect(newSkills.map((item) => item.skillName)).toContain('taro-weapp-page-change')
    expect(newSkills.map((item) => item.skillName)).toContain('sports-coach-coach-workbench')
  })

  it('every draft is non-empty and carries its bold labels', () => {
    for (const proposal of newSkills) {
      expect(proposal.draft).toBeDefined()
      expect((proposal.draft ?? '').trim().length).toBeGreaterThan(50)
    }
    // 草稿正文用 **名称** / **触发条件** 这类加粗标签，至少要能原样带出来。
    const first = newSkills.find((item) => item.skillName === 'taro-weapp-page-change')
    expect(first?.draft).toContain('**名称**')
    expect(first?.draft).toContain('**触发条件**')
  })

  it('occurrence counts are parsed as positive numbers', () => {
    for (const proposal of newSkills) {
      expect(proposal.occurrences).toBeGreaterThan(0)
    }
  })

  it('keeps 【细分专项】 as niche and plain 新建 as create', () => {
    const niche = newSkills.filter((item) => item.recommendation === 'niche')
    const create = newSkills.filter((item) => item.recommendation === 'create')
    expect(niche.length).toBeGreaterThanOrEqual(2)
    expect(create.length).toBeGreaterThanOrEqual(1)
    // 细分专项的优先级被规则强制成「中」。
    for (const item of niche) expect(item.priority).toBe('medium')
    // 具体点名两个已知的细分专项。
    expect(niche.map((item) => item.skillName)).toContain('sports-coach-coach-workbench')
    expect(niche.map((item) => item.skillName)).toContain('sports-coach-student-records')
  })

  it('skips the English preamble instead of treating it as a table row', () => {
    // 模型在模板前输出了 "Let me analyze the sessions…"，不能被当成提案。
    expect(newSkills.some((item) => item.skillName.toLowerCase().includes('let'))).toBe(false)
    // 前言里的会话编号列表（1. session-66f4 — …）也不能被当表格行。
    expect(newSkills.some((item) => item.skillName.startsWith('session-'))).toBe(false)
  })
})

describe('format tolerance', () => {
  /** 造一份带草稿的表格 —— 新规则要求 create/niche 必须有草稿，否则被丢弃。 */
  const table = (row: string, draftName = ''): string => [
    '## 一、新建技能推荐清单',
    '| 序号 | 优先级 | 技能名称 | 适用场景 | 出现次数 | 收益 | 潜在风险 | 建议 |',
    '|---|---|---|---|---|---|---|---|',
    row,
    draftName === '' ? '' : '### 【候选技能草稿 1】' + draftName,
    draftName === '' ? '' : '**名称**：' + draftName,
    '## 二、已有技能优化提案',
  ].filter((line) => line !== '').join('\n')

  it('strips leading and trailing pipes', () => {
    const proposals = parseProposals(table('| 1 | 高 | `alpha-skill` | 场景 | 3 | 收益 | 风险 | 新建 |', 'alpha-skill'), 1)
    expect(proposals).toHaveLength(1)
    expect(proposals[0]?.skillName).toBe('alpha-skill')
    expect(proposals[0]?.occurrences).toBe(3)
  })

  it('accepts a table without surrounding pipes', () => {
    const proposals = parseProposals(table('1 | 高 | beta-skill | 场景 | 2 | 收益 | 风险 | 新建', 'beta-skill'), 2)
    expect(proposals).toHaveLength(1)
    expect(proposals[0]?.skillName).toBe('beta-skill')
  })

  it('accepts ｜ (full-width) as the separator', () => {
    const proposals = parseProposals(table('1｜高｜gamma-skill｜场景｜4｜收益｜风险｜新建', 'gamma-skill'), 3)
    expect(proposals).toHaveLength(1)
    expect(proposals[0]?.skillName).toBe('gamma-skill')
  })

  it('accepts a draft heading with a Chinese colon', () => {
    const md = [
      '## 一、新建技能推荐清单',
      '| 1 | 高 | `delta-skill` | 场景 | 3 | 收益 | 风险 | 新建 |',
      '### 候选技能草稿 1：`delta-skill`',
      '**名称**：delta-skill',
      '**触发条件**：当用户要求做某件事时',
      '## 二、已有技能优化提案',
    ].join('\n')
    const proposals = parseProposals(md, 4)
    expect(proposals[0]?.draft).toContain('**名称**')
  })

  it('accepts a draft heading with a full-width pipe', () => {
    const md = [
      '## 一、新建技能推荐清单',
      '| 1 | 高 | `epsilon-skill` | 场景 | 3 | 收益 | 风险 | 新建 |',
      '### 候选技能草稿 1｜epsilon-skill',
      '**名称**：epsilon-skill',
      '## 二、已有技能优化提案',
    ].join('\n')
    const proposals = parseProposals(md, 5)
    expect(proposals[0]?.draft).toContain('**名称**')
  })

  it('tolerates a 【细分专项】 prefix inside the draft heading', () => {
    const md = [
      '## 一、新建技能推荐清单',
      '| 1 | 中 | `zeta-skill` | 场景 | 2 | 收益 | 风险 | 【细分专项】 |',
      '### 候选技能草稿 1：【细分专项】`zeta-skill`',
      '**名称**：zeta-skill',
      '## 二、已有技能优化提案',
    ].join('\n')
    const proposals = parseProposals(md, 6)
    expect(proposals[0]?.recommendation).toBe('niche')
    expect(proposals[0]?.draft).toContain('**名称**')
  })

  it('returns nothing for the fixed no-proposal answer', () => {
    expect(parseProposals('暂无技能进化提案', 7)).toEqual([])
  })
})
