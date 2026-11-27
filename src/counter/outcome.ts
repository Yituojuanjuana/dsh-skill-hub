/**
 * 调用成败判定所需的事件字段提取（recorder 与 backfill 共用）。
 *
 * 真实会话事件（2026-11-27 从 ~/.dsh/sessions 的 161 份日志核对）：
 * - `tool/ptc-dispatch`：调用与结果**同一个事件**，data.isError 为 boolean
 *   （5564 条全部带该字段），用 subCallId 与 `tool/ptc-dispatch-start` 配对。
 * - `tool/call` + `tool/result`：直接工具调用，结果在另一个事件：
 *   `tool/result.data.message.toolCallId === tool/call.data.callId`，
 *   isError 在 `data.message.isError`（不是 data.isError！）。
 * - `user/message` source.kind==='skill-invocation'：用户 /技能名，真实日志里
 *   没有对应结果事件 → 保持未知，不写 ok。
 *
 * 未知永远是未知：绝不把没结果的调用当成功，也绝不当失败。
 */
export type SessionLikeEvent = { type: string; time?: number; data?: Record<string, unknown> }

/** tool/result 的配对 id（message.toolCallId）；非结果事件返回 undefined。 */
export function resultCallId(event: SessionLikeEvent): string | undefined {
  if (event.type !== 'tool/result') return undefined
  const msg = event.data?.message as { toolCallId?: unknown } | undefined
  return typeof msg?.toolCallId === 'string' && msg.toolCallId !== '' ? msg.toolCallId : undefined
}

/** tool/result 的成败（message.isError）；无结果返回 undefined。 */
export function resultOk(event: SessionLikeEvent): boolean | undefined {
  if (event.type !== 'tool/result') return undefined
  const msg = event.data?.message as { isError?: unknown } | undefined
  return typeof msg?.isError === 'boolean' ? !msg.isError : undefined
}

/** tool/call 的 callId；非该事件返回 undefined。 */
export function callIdOf(event: SessionLikeEvent): string | undefined {
  if (event.type !== 'tool/call') return undefined
  const id = event.data?.callId
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** tool/ptc-dispatch 的 subCallId（自身就是带结果的调用）；非该事件返回 undefined。 */
export function ptcSubCallId(event: SessionLikeEvent): string | undefined {
  if (event.type !== 'tool/ptc-dispatch') return undefined
  const id = event.data?.subCallId
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** tool/ptc-dispatch 的成败（data.isError）；非该事件或无字段返回 undefined。 */
export function ptcOk(event: SessionLikeEvent): boolean | undefined {
  if (event.type !== 'tool/ptc-dispatch') return undefined
  const v = event.data?.isError
  return typeof v === 'boolean' ? !v : undefined
}
