/**
 * 插件设置页的「运行与连接」一节。
 *
 * 三块内容（需求 0.7.0）：
 *  1. 状态卡：DSH 进程 / ingress 端口 / 隧道域名 / 隧道健康 / 插件版本 /
 *     bundle 一致性。10 秒自动刷新；**刷新失败不清空旧值**，只标注
 *     「上次成功 xx 秒前」。
 *  2. 三个按钮：热重载插件（Cordis 层，不重启进程）、重启 DSH（红色，二次
 *     确认，文案写清会中断对话）、重连隧道（换域名后把新域名显示出来）。
 *  3. 连接信息：隧道地址 / 配对码 / 设备 token 的显示与一键复制。token 默认
 *     遮罩，点「显示」才请求明文。
 *
 * 这一节不是新 tab：它渲染在既有「插件设置」页里，避免 tab 条变长。
 */

import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import type { OpsAction, OpsConnectionResponse, OpsStatusResponse } from '../../protocol.ts'
import { SkillHubApi } from '../api.ts'
import { errorMessage, tt } from '../helpers.ts'
import css from './ops.module.css'

/** 自动刷新间隔（需求：10 秒）。 */
const POLL_MS = 10_000

/** 相对时间：把「上次成功」的 epoch ms 翻成秒/分钟。 */
function agoText(ms: number | null, now: number): string {
  if (ms === null) return tt('ops.neverSucceeded')
  const seconds = Math.max(0, Math.floor((now - ms) / 1000))
  if (seconds < 60) return tt('ops.agoSeconds', { seconds })
  return tt('ops.agoMinutes', { minutes: Math.floor(seconds / 60) })
}

/** 一个「标签 : 值」行，值可带状态色。 */
function Row(props: { label: string; value: JSX.Element | string; tone?: 'ok' | 'warn' | 'bad' }): JSX.Element {
  const toneClass = props.tone === 'ok' ? css.ok : props.tone === 'warn' ? css.warn : props.tone === 'bad' ? css.bad : undefined
  return (
    <div className={css.row}>
      <span className={css.rowLabel}>{props.label}</span>
      <span className={toneClass === undefined ? css.rowValue : css.rowValue + ' ' + toneClass}>{props.value}</span>
    </div>
  )
}

/** 可复制的值：右侧一个小按钮，复制后短暂显示「已复制」。 */
function CopyValue(props: { text: string | null; masked?: boolean; onReveal?: () => void; revealed?: boolean }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    if (props.text === null) return
    void navigator.clipboard.writeText(props.text).then(() => {
      setCopied(true)
      setTimeout(() => { setCopied(false) }, 1500)
    }).catch(() => { /* 剪贴板不可用时静默 */ })
  }
  return (
    <span className={css.copyWrap}>
      <span className={props.masked === true ? css.masked : css.copyText}>{props.text ?? '—'}</span>
      {props.onReveal !== undefined ? (
        <button type='button' className={css.miniBtn} onClick={props.onReveal}>
          {tt(props.revealed === true ? 'ops.hide' : 'ops.show')}
        </button>
      ) : null}
      {props.text !== null ? (
        <button type='button' className={css.miniBtn} onClick={copy}>
          {tt(copied ? 'ops.copied' : 'ops.copy')}
        </button>
      ) : null}
    </span>
  )
}

/**
 * 渲染「运行与连接」一节。
 * @returns 状态卡 + 三个按钮 + 连接信息。
 */
export function OpsSection(): JSX.Element {
  const [status, setStatus] = useState<OpsStatusResponse | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const [busy, setBusy] = useState<OpsAction | null>(null)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirmRestart, setConfirmRestart] = useState(false)
  const [connection, setConnection] = useState<OpsConnectionResponse | null>(null)
  const [revealed, setRevealed] = useState(false)
  const mounted = useRef(true)

  const loadStatus = useCallback((): void => {
    void new SkillHubApi().opsStatus()
      .then((next) => {
        if (!mounted.current) return
        setStatus(next)
        setNow(Date.now())
        // 服务端 fresh=false 表示这次没问到；错误原因照实显示，但旧值保留。
        setStatusError(next.fresh ? null : (next.error ?? null))
      })
      .catch((error: unknown) => {
        if (!mounted.current) return
        // 网络层失败：**不清空** status，只记错误。
        setStatusError(errorMessage(error))
      })
  }, [])

  useEffect(() => {
    mounted.current = true
    loadStatus()
    const timer = setInterval(loadStatus, POLL_MS)
    return () => { mounted.current = false; clearInterval(timer) }
  }, [loadStatus])

  const runAction = (action: OpsAction): void => {
    if (busy !== null) return
    setBusy(action)
    setActionMessage(null)
    setActionError(null)
    void new SkillHubApi().opsAction(action)
      .then((result) => {
        if (!mounted.current) return
        if (result.ok) {
          setActionMessage(result.message)
        } else {
          // 服务端给的人话原因（例如「有对话在进行，先等它结束」）原样显示。
          setActionError(result.rejectedReason ?? result.message)
        }
        loadStatus()
      })
      .catch((error: unknown) => { if (mounted.current) setActionError(errorMessage(error)) })
      .finally(() => { if (mounted.current) setBusy(null) })
  }

  const loadConnection = (reveal: boolean): void => {
    void new SkillHubApi().opsConnection({ revealToken: reveal })
      .then((result) => {
        if (!mounted.current) return
        setConnection(result)
        setRevealed(reveal && result.revealed)
      })
      .catch((error: unknown) => { if (mounted.current) setActionError(errorMessage(error)) })
  }

  const cooldown = status?.cooldownRemainingSec ?? 0
  const restartDisabled = busy !== null || cooldown > 0
  const bundleTone = status === null ? undefined : status.bundle.upToDate ? 'ok' : 'warn'
  const bundleText = status === null
    ? '—'
    : status.bundle.upToDate
      ? tt('ops.bundleUpToDate')
      : tt('ops.bundleStale')

  return (
    <section className={css.section}>
      <h3 className={css.title}>{tt('ops.title')}</h3>
      <p className={css.hint}>{tt('ops.hint')}</p>

      {/* ---- 状态卡 ---- */}
      <div className={css.card}>
        {status === null ? <p className={css.pending}>{tt('ops.loading')}</p> : (
          <>
            <Row label={tt('ops.dshProcess')} value={status.dsh.running ? tt('ops.running') : tt('ops.notRunning')} tone={status.dsh.running ? 'ok' : 'bad'} />
            <Row label={tt('ops.ingress')} value={status.ingress.listening ? tt('ops.listening', { port: status.ingress.port }) : tt('ops.notListening', { port: status.ingress.port })} tone={status.ingress.listening ? 'ok' : 'bad'} />
            <Row label={tt('ops.tunnelAddress')} value={status.tunnel.address ?? tt('ops.none')} tone={status.tunnel.address === null ? 'warn' : undefined} />
            <Row label={tt('ops.tunnelHealth')} value={status.tunnel.healthy ? tt('ops.healthy') : tt('ops.unhealthy')} tone={status.tunnel.healthy ? 'ok' : 'bad'} />
            <Row label={tt('ops.pluginVersion')} value={'v' + status.pluginVersion} />
            <Row label={tt('ops.bundle')} value={bundleText} tone={bundleTone} />
          </>
        )}
        {statusError !== null ? (
          <p className={css.stale}>
            {tt('ops.staleStatus', { ago: agoText(status?.lastSuccessAt ?? null, now) })} — {statusError}
          </p>
        ) : null}
      </div>

      {/* ---- 三个按钮 ---- */}
      <div className={css.actions}>
        <button type='button' className={css.actionBtn} disabled={busy !== null} onClick={() => { runAction('reload') }}>
          {tt(busy === 'reload' ? 'ops.working' : 'ops.reload')}
        </button>
        <button
          type='button'
          className={css.dangerBtn}
          disabled={restartDisabled}
          title={cooldown > 0 ? tt('ops.cooldownHint', { seconds: cooldown }) : tt('ops.restartHint')}
          onClick={() => { setConfirmRestart(true) }}
        >
          {tt(busy === 'restart' ? 'ops.working' : 'ops.restart')}
        </button>
        <button type='button' className={css.actionBtn} disabled={busy !== null} onClick={() => { runAction('tunnel-restart') }}>
          {tt(busy === 'tunnel-restart' ? 'ops.working' : 'ops.tunnelRestart')}
        </button>
        {cooldown > 0 ? <span className={css.cooldown}>{tt('ops.cooldownHint', { seconds: cooldown })}</span> : null}
      </div>

      {actionMessage !== null ? <p className={css.success}>{actionMessage}</p> : null}
      {actionError !== null ? <p className={css.error}>{actionError}</p> : null}
      {busy === 'reload' ? <p className={css.hint}>{tt('ops.reloadHint')}</p> : null}

      {/* ---- 连接信息 ---- */}
      <div className={css.card}>
        <div className={css.cardHead}>
          <span className={css.cardTitle}>{tt('ops.connection')}</span>
          {connection === null ? (
            <button type='button' className={css.miniBtn} onClick={() => { loadConnection(false) }}>{tt('ops.loadConnection')}</button>
          ) : null}
        </div>
        {connection !== null ? (
          <>
            <Row label={tt('ops.tunnelAddress')} value={<CopyValue text={connection.tunnelUrl} />} />
            <Row label={tt('ops.pairCode')} value={<CopyValue text={connection.pairCode} />} />
            <Row
              label={tt('ops.deviceToken')}
              value={<CopyValue text={connection.deviceToken} masked={!revealed} revealed={revealed} onReveal={() => { loadConnection(!revealed) }} />}
            />
            <p className={css.hint}>{tt('ops.tokenHint')}</p>
          </>
        ) : null}
      </div>

      {/* ---- 重启二次确认 ---- */}
      {confirmRestart ? (
        <div className={css.overlay} role='dialog' aria-modal='true'>
          <div className={css.dialog}>
            <p className={css.dialogTitle}>{tt('ops.restartConfirmTitle')}</p>
            <p className={css.dialogBody}>{tt('ops.restartConfirmBody')}</p>
            <div className={css.dialogActions}>
              <button type='button' className={css.actionBtn} onClick={() => { setConfirmRestart(false) }}>{tt('ops.cancel')}</button>
              <button
                type='button'
                className={css.dangerBtn}
                onClick={() => { setConfirmRestart(false); runAction('restart') }}
              >{tt('ops.restartConfirm')}</button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}
