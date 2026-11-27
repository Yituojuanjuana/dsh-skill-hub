// @vitest-environment jsdom
/** 需求一 UI 回归：回收建议展开能看到技能说明；回收站行展开显示描述/原路径。 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EvolutionProposal, TrashEntry } from '../../protocol.ts'

const { ProposalCard } = await import('./EvolutionView.tsx')
const { TrashView } = await import('./TrashView.tsx')

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(async () => {
  if (root !== undefined) await act(async () => { root?.unmount() })
  container?.remove()
  root = undefined
  container = undefined
})

async function mount(node: React.ReactNode): Promise<HTMLDivElement> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container as HTMLDivElement)
    root.render(node)
  })
  return container as HTMLDivElement
}

function reclaimProposal(): EvolutionProposal {
  return {
    id: 'r1', kind: 'reclaim', skillName: 'old-skill', displayName: '旧技能',
    createdAt: 1, status: 'pending',
    painPoints: '长期无人使用',
    skillSummary: '用于生成周报的旧技能',
    skillSummaryZh: '用于生成周报的旧技能',
  } as EvolutionProposal
}

describe('技能说明快照在 UI 可见', () => {
  it('回收建议展开后显示「这技能是做什么的」整行', async () => {
    const el = await mount(<ProposalCard proposal={reclaimProposal()} busy={false} onAccept={() => {}} onReject={() => {}} onDefer={() => {}} onTrash={() => {}} />)
    expect(el.textContent).not.toContain('这技能是做什么的')
    const buttons = [...el.querySelectorAll('button')]
    const expand = buttons.find((b) => (b.textContent ?? '').includes('展开详情')) as HTMLButtonElement
    await act(async () => { expand.click() })
    expect(el.textContent).toContain('这技能是做什么的')
    expect(el.textContent).toContain('用于生成周报的旧技能')
  })

  it('老提案没有快照时不显示该行', async () => {
    const old = reclaimProposal()
    delete old.skillSummary
    const el = await mount(<ProposalCard proposal={old} busy={false} onAccept={() => {}} onReject={() => {}} onDefer={() => {}} onTrash={() => {}} />)
    const expand = [...el.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('展开详情')) as HTMLButtonElement
    await act(async () => { expand.click() })
    expect(el.textContent).not.toContain('这技能是做什么的')
  })

  it('回收站行展开显示描述、原路径；缺描述时显示占位', async () => {
    const entry: TrashEntry = {
      name: 'trashed-skill', path: 'E:\\trash\\trashed-skill', movedAt: 1,
      sourcePath: 'E:\\skills\\trashed-skill', description: '曾经的技能描述',
    }
    const hub = { sourcesState: { trash: [entry], sources: [] }, tagBusy: false, restoreTrash: vi.fn(async () => {}), reloadCatalog: vi.fn(async () => {}), setConfirmClearTrash: vi.fn() }
    const el = await mount(<TrashView hub={hub as never} />)
    await act(async () => { (el.querySelector('button[aria-expanded]') as HTMLButtonElement).click() })
    expect(el.textContent).toContain('曾经的技能描述')
    expect(el.textContent).toContain('E:\\skills\\trashed-skill')

    const bare: TrashEntry = { name: 'old', path: 'E:\\trash\\old', movedAt: 1 }
    const el2 = await mount(<TrashView hub={{ ...hub, sourcesState: { trash: [bare], sources: [] } } as never} />)
    await act(async () => { (el2.querySelector('button[aria-expanded]') as HTMLButtonElement).click() })
    expect(el2.textContent).toContain('该技能没有写描述')
  })
})
