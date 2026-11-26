/**
 * 进化提案的持久化。
 *
 * 这个模块**只写一个 JSON**（`~/.dsh/skill-usage-manager/evolution.json`），
 * 不碰任何技能目录 —— 「只产出提案、等人工审核」这条约束在代码层面就成立：
 * 这里没有任何指向 skills 根目录的路径拼接。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  EvolutionFile,
  EvolutionProposal,
  EvolutionProposalKind,
  EvolutionProposalStatus,
  EvolutionRejection,
  EvolutionRunRecord,
} from '../protocol/evolution.ts'
import { dshHome } from '../store/paths.ts'

/** 磁盘 schema 版本。 */
export const EVOLUTION_STORE_VERSION = 1

/** 保留多少条提案与运行记录。 */
export const MAX_PROPOSALS = 200
export const MAX_RUNS = 50

/** 提案文件的绝对路径。 */
export function evolutionPath(home = dshHome()): string {
  return join(home, 'skill-usage-manager', 'evolution.json')
}

/** 空状态。 */
function emptyFile(): EvolutionFile {
  return { version: EVOLUTION_STORE_VERSION, markdown: '', ranAt: 0, proposals: [], runs: [], rejections: [] }
}

/** 把任意值收窄成一条提案；形状不对就丢掉，不抛错。 */
function readProposal(value: unknown): EvolutionProposal | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const v = value as Record<string, unknown>
  if (typeof v.id !== 'string' || v.id === '') return undefined
  if (typeof v.skillName !== 'string' || v.skillName === '') return undefined
  const kind = v.kind === 'optimize' ? 'optimize' : v.kind === 'new-skill' ? 'new-skill' : undefined
  if (kind === undefined) return undefined
  const status = v.status === 'accepted' || v.status === 'rejected' ? v.status : 'pending'
  const str = (key: string): string | undefined => (typeof v[key] === 'string' && v[key] !== '' ? v[key] as string : undefined)
  const num = (key: string): number | undefined => (typeof v[key] === 'number' && Number.isFinite(v[key]) ? v[key] as number : undefined)
  return {
    id: v.id,
    kind: kind as EvolutionProposalKind,
    skillName: v.skillName,
    createdAt: num('createdAt') ?? 0,
    status: status as EvolutionProposalStatus,
    ...str('priority') === undefined ? {} : { priority: str('priority') as EvolutionProposal['priority'] },
    ...str('scenario') === undefined ? {} : { scenario: str('scenario') },
    ...num('occurrences') === undefined ? {} : { occurrences: num('occurrences') },
    ...str('benefit') === undefined ? {} : { benefit: str('benefit') },
    ...str('risk') === undefined ? {} : { risk: str('risk') },
    ...str('recommendation') === undefined ? {} : { recommendation: str('recommendation') as EvolutionProposal['recommendation'] },
    ...str('draft') === undefined ? {} : { draft: str('draft') },
    ...str('changeType') === undefined ? {} : { changeType: str('changeType') as EvolutionProposal['changeType'] },
    ...str('painPoints') === undefined ? {} : { painPoints: str('painPoints') },
    ...str('newSource') === undefined ? {} : { newSource: str('newSource') },
    ...str('testCases') === undefined ? {} : { testCases: str('testCases') },
    ...str('riskAssessment') === undefined ? {} : { riskAssessment: str('riskAssessment') },
    ...str('benefitCompare') === undefined ? {} : { benefitCompare: str('benefitCompare') },
  }
}

/** 校验整份状态；不可读的部分降级为空。 */
export function hydrateEvolutionFile(parsed: unknown): EvolutionFile {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return emptyFile()
  const v = parsed as Record<string, unknown>
  const version = Number(v.version)
  if (!Number.isFinite(version) || version > EVOLUTION_STORE_VERSION) return emptyFile()
  const proposals = Array.isArray(v.proposals)
    ? v.proposals.flatMap((item) => { const p = readProposal(item); return p === undefined ? [] : [p] })
    : []
  const runs = Array.isArray(v.runs)
    ? v.runs.flatMap((item) => {
        if (typeof item !== 'object' || item === null) return []
        const r = item as Record<string, unknown>
        return [{
          at: Number(r.at) || 0,
          sessions: Number(r.sessions) || 0,
          messages: Number(r.messages) || 0,
          proposals: Number(r.proposals) || 0,
          ...typeof r.error === 'string' ? { error: r.error } : {},
          ...typeof r.skipped === 'string' ? { skipped: r.skipped } : {},
        } satisfies EvolutionRunRecord]
      })
    : []
  const rejections = Array.isArray(v.rejections)
    ? v.rejections.flatMap((item) => {
        if (typeof item !== 'object' || item === null) return []
        const r = item as Record<string, unknown>
        if (typeof r.id !== 'string' || typeof r.reason !== 'string') return []
        // kind 必须原样带回来：丢掉它会让去重退化成「不区分类型」，
        // 重启后驳回隔离就失效了。旧记录没有该字段，保持 undefined。
        const kind: EvolutionRejection['kind'] = r.kind === 'new-skill' || r.kind === 'optimize' || r.kind === 'reclaim' ? r.kind : undefined
        return [{
          id: r.id,
          skillName: typeof r.skillName === 'string' ? r.skillName : '',
          reason: r.reason,
          at: Number(r.at) || 0,
          ...kind === undefined ? {} : { kind },
        }]
      })
    : []
  return {
    version: EVOLUTION_STORE_VERSION,
    markdown: typeof v.markdown === 'string' ? v.markdown : '',
    ranAt: Number(v.ranAt) || 0,
    proposals,
    runs,
    rejections,
  }
}

/**
 * 提案的读写者。
 *
 * 写入串行化（一次运行与一次人工处理可能并发），先写临时文件再 rename。
 */
export class EvolutionStore {
  private readonly file: string
  private state: EvolutionFile | undefined
  private loading: Promise<EvolutionFile> | undefined
  private chain: Promise<unknown> = Promise.resolve()

  constructor(file: string = evolutionPath()) {
    this.file = file
  }

  /** 读当前状态（首次访问冷读磁盘）。 */
  async read(): Promise<EvolutionFile> {
    if (this.state !== undefined) return this.state
    this.loading ??= this.load()
    return this.loading
  }

  private async load(): Promise<EvolutionFile> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch {
      this.state = emptyFile()
      return this.state
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = undefined
    }
    this.state = hydrateEvolutionFile(parsed)
    return this.state
  }

  /**
   * 在一次串行的读-改-写里修改状态。
   * @param mutate - 拿到当前状态，返回新状态。
   * @returns 提交后的状态。
   */
  async update(mutate: (current: EvolutionFile) => EvolutionFile): Promise<EvolutionFile> {
    const run = async (): Promise<EvolutionFile> => {
      const current = await this.read()
      const next = mutate(current)
      this.state = next
      await this.persist(next)
      return next
    }
    const queued = this.chain.then(run, run)
    this.chain = queued.catch(() => undefined)
    return queued
  }

  private async persist(state: EvolutionFile): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const temp = this.file + '.tmp-' + String(process.pid)
    await writeFile(temp, JSON.stringify(state, null, 2), 'utf8')
    await rename(temp, this.file)
  }
}

/** 把提案列表截断到上限（保留最新的）。 */
export function capProposals(proposals: readonly EvolutionProposal[]): EvolutionProposal[] {
  return [...proposals].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_PROPOSALS)
}
