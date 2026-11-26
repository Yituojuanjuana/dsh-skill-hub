/**
 * 面板的错误边界（兜底，不是修复）。
 *
 * 为什么需要它：React 里任何一个渲染期异常都会让**整棵子树**卸载。插件被
 * 宿主挂在设置页或侧栏里，卸载之后用户看到的就是整块空白 —— 连标题栏都没了，
 * 既不知道出了什么事，也没有任何可点的东西。这个边界把「白屏」变成一张
 * 可读的卡片：错误摘要、组件栈、复制详情、重试。
 *
 * 边界**只包内容区**，不包标题栏与 tab 条 —— 那两样必须始终在，否则用户连
 * 换 tab 逃出去的路都没有。这一点由调用方（`SkillHubPanel`）的包裹位置保证。
 *
 * 注意它**不修复**任何 bug：真正的修复在别处（例如 hook 顺序）。边界只是让
 * 下一次同类故障可见、可恢复，而不是静默白屏。
 */

import { Component, type ErrorInfo, type JSX, type ReactNode } from 'react'
import { copyTextToClipboard, tt } from '../helpers.ts'
import css from './panel.module.css'

export interface PanelErrorBoundaryProps {
  children: ReactNode
  /** 出错时展示的区域名（便于判断是哪一块炸了）。 */
  scope: string
  /** 重试：边界会先清空错误状态，再让子树重新挂载。 */
  onRetry?: () => void
}

interface PanelErrorBoundaryState {
  error: Error | null
  componentStack: string
  copied: boolean
}

export class PanelErrorBoundary extends Component<PanelErrorBoundaryProps, PanelErrorBoundaryState> {
  state: PanelErrorBoundaryState = { error: null, componentStack: '', copied: false }

  static getDerivedStateFromError(error: Error): Partial<PanelErrorBoundaryState> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 保留组件栈：它是判断「哪一层炸了」的唯一线索，控制台里稍纵即逝。
    this.setState({ componentStack: info.componentStack ?? '' })
    // 同时打到控制台，方便在真机 GUI 里直接看到。
    console.error('[dsh-skill-shelf] panel render failed in ' + this.props.scope, error, info.componentStack)
  }

  private readonly retry = (): void => {
    this.setState({ error: null, componentStack: '', copied: false })
    this.props.onRetry?.()
  }

  private readonly copy = (): void => {
    const { error, componentStack } = this.state
    const text = [
      'scope: ' + this.props.scope,
      'error: ' + (error?.name ?? 'Error') + ': ' + (error?.message ?? ''),
      '',
      'stack:',
      error?.stack ?? '(no stack)',
      '',
      'component stack:',
      componentStack === '' ? '(none)' : componentStack,
    ].join('\n')
    void copyTextToClipboard(text).then((ok) => { if (ok) this.setState({ copied: true }) })
  }

  render(): ReactNode {
    const { error, componentStack, copied } = this.state
    if (error === null) return this.props.children
    return (
      <div className={css.errorCard} role='alert'>
        <div className={css.errorCardTitle}>
          {tt('err.renderFailed')}
          <span className={css.errorCardScope}>{this.props.scope}</span>
        </div>
        <div className={css.errorCardMessage}>{error.name}: {error.message}</div>
        {componentStack !== '' ? (
          <details className={css.errorCardDetails}>
            <summary>{tt('err.componentStack')}</summary>
            <pre className={css.errorCardPre}>{componentStack.trim()}</pre>
          </details>
        ) : null}
        <div className={css.errorCardActions}>
          <button type='button' className={css.button} onClick={this.copy}>{copied ? tt('err.copied') : tt('err.copyDetails')}</button>
          <button type='button' className={css.button + ' ' + css.primary} onClick={this.retry}>{tt('err.retry')}</button>
        </div>
      </div>
    )
  }
}

/**
 * 函数式包装，便于在 JSX 里少写一层泛型。
 * @param props - 边界属性。
 * @returns 边界元素。
 */
export function PanelBoundary(props: PanelErrorBoundaryProps): JSX.Element {
  return <PanelErrorBoundary {...props} />
}
