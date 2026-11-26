/**
 * 技能进化元代理面板。
 *
 * 界面只做三件事：跑一次分析、看提案、人工审核。**没有任何「自动应用」路径** ——
 * 每条提案都要人点「同意」才会落地成技能文件，驳回必须填原因（用于抑制同类提案）。
 */

import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import type { EvolutionProposal, EvolutionResponse } from '../../protocol.ts'
import type { SkillHubApi } from '../api.ts'
import { errorMessage, tt } from '../helpers.ts'
import { locationLabel } from './source-label.ts'
import css from './panel.module.css'

export type EvolutionApi = Pick<SkillHubApi, 'fetchEvolution' | 'runEvolution' | 'decideEvolution' | 'clearEvolution' | 'reparseEvolution' | 'deleteSkill'>

/** 相对时间。 */
function relative(ms: number, now = Date.now()): string {
  if (ms === 0) return tt('evolution.never')
  const diff = Math.max(0, now - ms)
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return tt('time.justNow')
  if (minutes < 60) return tt('time.minutesAgo', { value: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return tt('time.hoursAgo', { value: hours })
  return tt('time.daysAgo', { value: Math.floor(hours / 24) })
}

/** 提案状态徽标。 */
function statusLabel(status: EvolutionProposal['status']): string {
  if (status === 'accepted') return tt('evolution.statusAccepted')
  if (status === 'rejected') return tt('evolution.statusRejected')
  if (status === 'deferred') return tt('evolution.statusDeferred')
  return tt('evolution.statusPending')
}

/** 驳回弹窗的一套配置。 */
export interface RejectDialogConfig {
  /** 默认理由的 locale key（打开即预填）。 */
  defaultKey: string
  /** 快捷理由的 locale key 列表。 */
  quickKeys: readonly string[]
}

/**
 * 新建推荐 / 细分专项 的驳回配置。
 *
 * 语义是「这个提案不该做」—— 场景太细碎、已有技能覆盖、流程不稳定。
 */
export const REJECT_CONFIG_NEW: RejectDialogConfig = {
  defaultKey: 'evolution.defaultRejectReason',
  quickKeys: [
    'evolution.quickReasonNarrow',
    'evolution.quickReasonCovered',
    'evolution.quickReasonUnstable',
  ],
}

/**
 * 优化提案（轨迹优化 / 主动扫描优化）的驳回配置。
 *
 * 语义是「现在不改」而不是「这个提案没价值」—— 技能确实存在问题，
 * 只是当前不值得动。所以理由要偏「暂缓」而不是「不合格」，
 * 复用新建类那套「场景太细碎」会显得答非所问。
 */
export const REJECT_CONFIG_OPTIMIZE: RejectDialogConfig = {
  defaultKey: 'evolution.defaultRejectReasonOptimize',
  quickKeys: [
    'evolution.quickReasonLowPriority',
    'evolution.quickReasonRisky',
    'evolution.quickReasonSufficient',
  ],
}

/**
 * 建议回收类提案的驳回配置。
 *
 * 语义是「不回收、保留该技能」，不是「提案不该做」。
 */
export const REJECT_CONFIG_RECLAIM: RejectDialogConfig = {
  defaultKey: 'evolution.defaultRejectReasonReclaim',
  quickKeys: [
    'evolution.quickReasonKeep',
    'evolution.quickReasonObserve',
    'evolution.quickReasonStillUseful',
  ],
}

/**
 * 按提案类型选驳回配置。
 *
 * 三类提案的驳回语义互不相同，**不串用**：
 * - new-skill  → 不该新建
 * - optimize   → 暂不优化
 * - reclaim    → 暂不回收
 * @param kind - 提案类型。
 * @returns 该类型对应的弹窗配置。
 */
export function rejectConfigFor(kind: EvolutionProposal['kind']): RejectDialogConfig {
  if (kind === 'reclaim') return REJECT_CONFIG_RECLAIM
  if (kind === 'optimize') return REJECT_CONFIG_OPTIMIZE
  return REJECT_CONFIG_NEW
}

/** 兼容旧引用：新建类的快捷理由。 */
export const QUICK_REJECT_REASONS = REJECT_CONFIG_NEW.quickKeys.map((key) => ({ key }))

/** 兼容旧引用：新建类的默认理由 key。 */
export const DEFAULT_REJECT_REASON_KEY = REJECT_CONFIG_NEW.defaultKey

/** 该提案是否带任何统计维度数据（全缺时整行不渲染）。 */
function hasMetrics(metrics: EvolutionProposal['metrics']): boolean {
  if (metrics === undefined) return false
  return metrics.totalCalls !== undefined || metrics.weekCalls !== undefined || metrics.successRate !== undefined || metrics.inTrash === true
}

/** 一条提案卡片。 */
function ProposalCard(props: {
  proposal: EvolutionProposal
  busy: boolean
  onAccept: (root: 'user-dsh' | 'user-agents') => void
  onReject: (reason: string) => void
  onDefer: () => void
  /** 一键移入回收站（仅回收建议提案使用）。 */
  onTrash: (skillName: string) => void
}): JSX.Element {
  const { proposal } = props
  const [open, setOpen] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const pending = proposal.status === 'pending'
  const isNew = proposal.kind === 'new-skill'
  // 回收建议：操作区换成「移入回收站」，且不展示草稿区。
  const isReclaim = proposal.kind === 'reclaim'
  // 驳回弹窗按提案类型取配置 —— 回收建议的驳回语义是「保留该技能」。
  const rejectConfig = rejectConfigFor(proposal.kind)

  return (
    <div className={css.evolutionCard}>
      <div className={css.evolutionCardHead}>
        <span className={isReclaim ? css.evolutionBadgeReclaim : css.evolutionBadge}>{isReclaim ? tt('evolution.kindReclaim') : isNew ? tt('evolution.kindNew') : tt('evolution.kindOptimize')}</span>
        {/* 来源标签：区分「轨迹优化」「主动扫描优化」「重新解析」。 */}
        {proposal.source === 'scan' ? <span className={css.evolutionChipScan}>{tt('evolution.sourceScan')}</span> : null}
        {proposal.source === 'analysis' && !isNew ? <span className={css.evolutionChip}>{tt('evolution.sourceTrajectory')}</span> : null}
        {proposal.source === 'reparse' ? <span className={css.evolutionChip}>{tt('evolution.reparseBadge')}</span> : null}
        {/* 归属目录标签：与通用页「按目录」视图同一套分类。
            新建类技能还没落地，显示「待落地」；细分专项额外标注归属项目。 */}
        <span className={isNew ? css.evolutionChipPending : css.evolutionChipLocation} title={tt('evolution.locationHint')}>
          {isNew
            ? tt('evolution.locationPending')
            // 老提案没有 skillSource：退回「未知目录」而不是渲染空标签。
            : locationLabel(proposal.skillSource ?? '') || tt('evolution.locationUnknown')}
        </span>
        {proposal.recommendation === 'niche' ? (
          <span className={css.evolutionChip}>{tt('evolution.nicheProject')}</span>
        ) : null}
        {/* 标题用精简中文展示名；技能 ID 以小号等宽字跟在后面，便于核对目录名。 */}
        <span className={css.evolutionName}>{proposal.displayName ?? proposal.skillName}</span>
        {proposal.displayName !== undefined && proposal.displayName !== proposal.skillName ? (
          <code className={css.evolutionSkillId} title={tt('evolution.skillIdHint')}>{proposal.skillName}</code>
        ) : null}
        {isNew && proposal.recommendation !== undefined ? (
          <span className={css.evolutionChip}>
            {proposal.recommendation === 'create'
              ? tt('evolution.recCreate')
              : proposal.recommendation === 'niche'
                ? tt('evolution.recNiche')
                : tt('evolution.recObserve')}
          </span>
        ) : null}
        {!isNew && proposal.changeType !== undefined ? (
          <span className={css.evolutionChip}>{tt(('evolution.change_' + proposal.changeType) as 'evolution.change_modify')}</span>
        ) : null}
        {isNew && proposal.priority !== undefined ? (
          <span className={css.evolutionChip}>{tt(('evolution.priority_' + proposal.priority) as 'evolution.priority_high')}</span>
        ) : null}
        <span className={css.evolutionAge}>{statusLabel(proposal.status)}</span>
      </div>

      {isNew ? (
        <>
          {proposal.scenario !== undefined ? <div className={css.evolutionDescription}>{proposal.scenario}</div> : null}
          <div className={css.evolutionRationale}>
            {proposal.occurrences !== undefined ? tt('evolution.occurrences', { count: proposal.occurrences }) + ' · ' : ''}
            {proposal.benefit ?? ''}
          </div>
          {proposal.risk !== undefined && proposal.risk !== '' ? <div className={css.evolutionRationale}>{tt('evolution.risk')}: {proposal.risk}</div> : null}
        </>
      ) : (
        <>
          {proposal.painPoints !== undefined ? <div className={css.evolutionDescription}>{proposal.painPoints}</div> : null}
          {proposal.riskAssessment !== undefined ? <div className={css.evolutionRationale}>{tt('evolution.risk')}: {proposal.riskAssessment}</div> : null}
          {proposal.benefitCompare !== undefined ? <div className={css.evolutionRationale}>{tt('evolution.benefit')}: {proposal.benefitCompare}</div> : null}
        </>
      )}

      {/* 统计维度：历史调用量 / 成功率 / 回收站状态。缺数据时整行不显示。 */}
      {hasMetrics(proposal.metrics) ? (
        <div className={css.evolutionMetrics}>
          {proposal.metrics?.totalCalls !== undefined
            ? <span className={css.evolutionMetric}>{tt('evolution.metricTotal', { count: proposal.metrics.totalCalls })}</span>
            : null}
          {proposal.metrics?.weekCalls !== undefined
            ? <span className={css.evolutionMetric}>{tt('evolution.metricWeek', { count: proposal.metrics.weekCalls })}</span>
            : null}
          {proposal.metrics?.successRate !== undefined
            ? <span className={css.evolutionMetric}>{tt('evolution.metricRate', { rate: Math.round(proposal.metrics.successRate * 1000) / 10 })}</span>
            : null}
          {proposal.metrics?.inTrash === true
            ? <span className={css.evolutionMetricTrash}>{tt('evolution.metricTrash')}</span>
            : null}
        </div>
      ) : null}

      <div className={css.evolutionActions}>
        {pending ? (
          <>
            {/* 回收建议提案：主操作是「移入回收站」，不是「同意并落地」。 */}
            {isReclaim ? (
              <button type='button' className={css.button + ' ' + css.primary + ' ' + css.evolutionButton} disabled={props.busy} onClick={() => { props.onTrash(proposal.skillName) }}>{tt('evolution.moveToTrash')}</button>
            ) : (
              <button type='button' className={css.button + ' ' + css.primary + ' ' + css.evolutionButton} disabled={props.busy} onClick={() => { props.onAccept('user-dsh') }}>{tt('evolution.accept')}</button>
            )}
            <button type='button' className={css.button + ' ' + css.evolutionButton} disabled={props.busy} onClick={() => {
              setRejecting((value) => {
                const next = !value
                // 打开弹窗时预填默认理由：用户可以直接点「确认驳回」，
                // 想改再改 —— 不再强制先输入文字。
                if (next && reason.trim() === '') setReason(tt(rejectConfig.defaultKey as never))
                return next
              })
            }}>{tt('evolution.reject')}</button>
            <button type='button' className={css.button + ' ' + css.evolutionButton} disabled={props.busy} onClick={props.onDefer}>{tt('evolution.defer')}</button>
          </>
        ) : null}
        <button type='button' className={css.button + ' ' + css.evolutionButton} onClick={() => { setOpen((value) => !value) }}>{open ? tt('evolution.collapse') : tt('evolution.expand')}</button>
      </div>

      {rejecting && pending ? (
        <div className={css.evolutionRedraft}>
          <label className={css.evolutionLabel} htmlFor={'reject-' + proposal.id}>{tt('evolution.rejectReason')}</label>
          {/* 快捷理由：点一下直接替换输入框内容，不用手打。 */}
          <div className={css.evolutionQuickReasons}>
            {rejectConfig.quickKeys.map((item) => (
              <button
                key={item}
                type='button'
                className={css.evolutionQuickReason + (reason === tt(item as never) ? ' ' + css.evolutionQuickReasonActive : '')}
                onClick={() => { setReason(tt(item as never)) }}
              >{tt(item as never)}</button>
            ))}
          </div>
          <input
            id={'reject-' + proposal.id}
            className={css.input}
            value={reason}
            placeholder={tt('evolution.rejectPlaceholder')}
            onChange={(event) => { setReason(event.target.value) }}
          />
          <div className={css.evolutionActions}>
            {/* 默认已填好通用理由，可以直接确认，不需要先改文字。 */}
            <button
              type='button'
              className={css.button + ' ' + css.primary}
              disabled={props.busy || reason.trim() === ''}
              onClick={() => { props.onReject(reason.trim()) }}
            >{tt('evolution.rejectConfirm')}</button>
            <button type='button' className={css.button} onClick={() => { setRejecting(false) }}>{tt('common.cancel')}</button>
          </div>
        </div>
      ) : null}

      {open && !isReclaim ? (
        <>
          {/* 统计维度评估理由：说明这条提案为什么被判为优化/回收/拆分。 */}
          {proposal.metrics?.reason !== undefined && proposal.metrics.reason !== '' ? (
            <div className={css.evolutionMetricReason}>
              <strong>{tt('evolution.metricReason')}</strong>
              {proposal.metrics.reason}
            </div>
          ) : null}
          <pre className={css.evolutionBody}>
            {isNew
              ? (proposal.draft ?? tt('evolution.noDraft'))
              : [
                  proposal.newSource === undefined ? '' : tt('evolution.newSource') + '\n' + proposal.newSource,
                  proposal.testCases === undefined ? '' : tt('evolution.testCases') + '\n' + proposal.testCases,
                ].filter((part) => part !== '').join('\n\n')}
          </pre>
        </>
      ) : null}
    </div>
  )
}

/** 进化面板主体。 */
export function EvolutionView(props: {
  api: EvolutionApi
  /** 落地成功后回调（外壳据此刷新 catalog，让新技能立刻出现在列表里）。 */
  onApplied?: () => void
}): JSX.Element {
  const { api } = props
  const [state, setState] = useState<EvolutionResponse | undefined>(undefined)
  const [busyId, setBusyId] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)

  const reload = useCallback(async (): Promise<void> => {
    try {
      setState(await api.fetchEvolution())
    } catch (failure) {
      setError(errorMessage(failure))
    }
  }, [api])

  // 首次加载 + 挂载即读一次状态。
  //
  // 关键：**运行态来自服务端**，组件卸载/切页不会中断分析；回来重新挂载时
  // 第一次 GET 就能拿到 running=true 和已耗时，进度接着显示。
  useEffect(() => { void reload() }, [reload])

  const running = state?.running === true

  // 轮询：跑着时每 2 秒读一次；跑完自动停。
  useEffect(() => {
    if (!running) return undefined
    const timer = window.setInterval(() => { void reload() }, 2000)
    return () => { window.clearInterval(timer) }
  }, [running, reload])

  // 跑完那一刻把结果转成一条提示（只做一次，靠前一次 running 判断）。
  const wasRunning = useRef(false)
  useEffect(() => {
    if (wasRunning.current && !running && state !== undefined) {
      if (state.lastError !== undefined) setError(state.lastError)
      else if (state.lastSkip !== undefined) setNotice(tt('evolution.skipped', { reason: state.lastSkip }))
      else if (state.proposals.length === 0) setNotice(tt('evolution.noProposal'))
      // 会话数与消息数从**最近一条运行记录**取真实值。
      // 之前这里硬编码 sessions: 0，于是完成提示永远写「读取 0 个会话」——
      // 后端统计其实一直是对的（runs[0].sessions），只是前端没读。
      else setNotice(tt('evolution.ran', {
        count: state.proposals.length,
        sessions: state.runs[0]?.sessions ?? 0,
      }))
    }
    wasRunning.current = running
  }, [running, state])

  /** 重新解析进行中（它很快，但仍要防连点）。 */
  const [reparsing, setReparsing] = useState(false)
  /** 是否有可用的历史 markdown（决定按钮是否可点）。 */
  const hasMarkdown = (state?.markdown ?? '').trim() !== ''

  /**
   * 离线重新解析：用已存的模型输出重跑解析管线。
   *
   * 不调用模型、不读会话 —— 几秒内完成。失败时保留上一版提案。
   */
  const reparse = async (): Promise<void> => {
    setReparsing(true)
    setError(undefined)
    setNotice(undefined)
    try {
      const result = await api.reparseEvolution()
      if (!result.ok) setError(result.error ?? tt('evolution.reparseFailed'))
      else setNotice(tt('evolution.reparsed', { count: result.proposals, ms: result.elapsedMs }))
      await reload()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setReparsing(false)
    }
  }
  const run = async (): Promise<void> => {
    setError(undefined)
    setNotice(undefined)
    try {
      const result = await api.runEvolution()
      // 并发保护：已有分析在跑不是错误，要把「它还在跑、已经跑了多久」讲清楚。
      if (result.alreadyRunning === true) {
        setNotice(tt('evolution.alreadyRunning', { seconds: Math.round((result.elapsedMs ?? 0) / 1000) }))
      }
      // 立即刷新一次，让按钮在 3 秒内进入「分析中」。
      await reload()
    } catch (failure) {
      setError(errorMessage(failure))
    }
  }

  /**
   * 已耗时（秒）。
   *
   * 服务端每次轮询给最新的 elapsedMs；两次轮询之间靠 `now` 这个每秒心跳让
   * 数字继续走，否则「已 N 秒」会每 2 秒才跳一格。
   */
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return undefined
    const timer = window.setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { window.clearInterval(timer) }
  }, [running])
  const [anchor, setAnchor] = useState<{ ms: number; at: number }>({ ms: 0, at: Date.now() })
  useEffect(() => {
    if (state === undefined) return
    setAnchor({ ms: state.elapsedMs, at: Date.now() })
  }, [state?.elapsedMs])
  const elapsedSeconds = Math.max(0, Math.round((anchor.ms + (running ? now - anchor.at : 0)) / 1000))

  const decide = async (id: string, status: 'accepted' | 'rejected' | 'deferred', reason?: string): Promise<void> => {
    setBusyId(id)
    setNotice(undefined)
    setError(undefined)
    try {
      const result = await api.decideEvolution(id, status, reason)
      if (result.error !== undefined) setError(result.error)
      else if (status === 'accepted') {
        setNotice(tt('evolution.applied', { name: result.appliedName ?? '' }))
        // 落地成功后通知外壳刷新 catalog —— 否则「工作区」页要等下一次
        // 5 秒轮询才会看到新技能，用户会以为落地没生效。
        props.onApplied?.()
      } else if (status === 'rejected') setNotice(tt('evolution.rejected'))
      await reload()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusyId(undefined)
    }
  }

  /**
   * 一键移入回收站。
   *
   * 复用插件已有的删除路由（`deleteSkill`）—— 它会把技能移到 `.trash`，
   * 用户仍可在「回收站」页恢复。移入成功后把该提案标为 accepted，
   * 让它从待审核列表消失。
   */
  const trashSkill = async (skillName: string, proposalId: string): Promise<void> => {
    if (!window.confirm(tt('evolution.trashConfirm', { name: skillName }))) return
    setBusyId(proposalId)
    setError(undefined)
    setNotice(undefined)
    try {
      await api.deleteSkill(skillName)
      // 关闭提案：标记为 accepted 即从待审核移除。
      await api.decideEvolution(proposalId, 'accepted')
      setNotice(tt('evolution.trashDone', { name: skillName }))
      await reload()
    } catch (failure) {
      setError(tt('evolution.trashFailed') + errorMessage(failure))
    } finally {
      setBusyId(undefined)
    }
  }
  const clear = async (): Promise<void> => {
    setNotice(undefined)
    try {
      await api.clearEvolution()
      await reload()
    } catch (failure) {
      setError(errorMessage(failure))
    }
  }

  const proposals = state?.proposals ?? []
  const pending = proposals.filter((item) => item.status === 'pending')
  const handled = proposals.filter((item) => item.status !== 'pending')

  return (
    <div className={css.evolutionWrap}>
      <header className={css.evolutionListBar}>
        <span className={css.evolutionTitle}>{tt('evolution.title')}</span>
        <span className={css.evolutionHint}>
          {(state?.ranAt ?? 0) > 0
            ? tt('evolution.lastRunDetail', {
                time: relative(state?.ranAt ?? 0),
                sessions: state?.runs[0]?.sessions ?? 0,
                messages: state?.runs[0]?.messages ?? 0,
              })
            : tt('evolution.lastRun', { time: relative(0) })}
        </span>
        <div className={css.buttons}>
          {/* 跑着时按钮禁用并显示已耗时 —— 点了有反应，不是「点了没反应」。 */}
          <button type='button' className={css.button + ' ' + css.primary} disabled={running} onClick={() => { void run() }}>
            {running ? tt('evolution.runningElapsed', { seconds: elapsedSeconds }) : tt('evolution.runNow')}
          </button>
          {/* 重新解析：复用已存的模型输出，不调用大模型。无历史记录时置灰。 */}
          <button
            type='button'
            className={css.button}
            disabled={running || reparsing || !hasMarkdown}
            title={hasMarkdown ? tt('evolution.reparseHint') : tt('evolution.reparseNoHistory')}
            onClick={() => { void reparse() }}
          >{reparsing ? tt('evolution.reparsing') : tt('evolution.reparse')}</button>
          {proposals.length > 0 ? <button type='button' className={css.button} onClick={() => { void clear() }}>{tt('evolution.clear')}</button> : null}
        </div>
      </header>

      <p className={css.evolutionHint}>{tt('evolution.hint')}</p>

      {/* 跑着时给一条进度条式提示，并说明预计耗时与「可以离开本页」。 */}
      {running ? (
        <div className={css.evolutionRunning}>
          <span className={css.evolutionSpinner} />
          <span>{tt('evolution.runningHint', { seconds: elapsedSeconds })}</span>
        </div>
      ) : null}

      {/* 失败原因放面板顶部，不只写日志。 */}
      {error !== undefined ? <div className={css.evolutionError}>{tt('evolution.errorPrefix')}{error}</div> : null}
      {notice !== undefined ? <div className={css.evolutionNotice}>{notice}</div> : null}

      {state === undefined ? <div className={css.evolutionMuted}>{tt('panel.loading')}</div> : null}

      {state !== undefined && proposals.length === 0 ? (
        <div className={css.evolutionEmpty}>
          <div className={css.evolutionEmptyGlyph}>✧</div>
          <strong>{tt('evolution.emptyTitle')}</strong>
          <p>{tt('evolution.emptyBody')}</p>
        </div>
      ) : null}

      {pending.length > 0 ? (
        <>
          <div className={css.sectionTitle}>{tt('evolution.pendingSection', { count: pending.length })}</div>
          {pending.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              busy={busyId === proposal.id}
              onAccept={() => { void decide(proposal.id, 'accepted', undefined) }}
              onReject={(reason) => { void decide(proposal.id, 'rejected', reason) }}
              onDefer={() => { void decide(proposal.id, 'deferred') }}
              onTrash={(skillName) => { void trashSkill(skillName, proposal.id) }}
            />
          ))}
        </>
      ) : null}

      {handled.length > 0 ? (
        <details className={css.evolutionHistory}>
          <summary>{tt('evolution.handledSection', { count: handled.length })}</summary>
          <div>
            {handled.map((proposal) => (
              <ProposalCard
                key={proposal.id}
                proposal={proposal}
                busy={busyId === proposal.id}
                onAccept={() => {}}
                onReject={() => {}}
                onDefer={() => {}}
                onTrash={() => {}}
              />
            ))}
          </div>
        </details>
      ) : null}

      {state !== undefined && state.rejections.length > 0 ? (
        <details className={css.evolutionHistory}>
          <summary>{tt('evolution.rejectionsSection', { count: state.rejections.length })}</summary>
          <ul>
            {state.rejections.slice(0, 50).map((rejection) => (
              <li key={rejection.id}>{rejection.skillName} · {rejection.reason}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  )
}
