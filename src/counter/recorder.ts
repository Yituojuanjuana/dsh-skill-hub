import { appendEntry } from './ledger.ts'
import { callIdOf, ptcOk, ptcSubCallId, resultCallId, resultOk } from './outcome.ts'
export type SessionLikeEvent = { type: string; time: number; data: Record<string, unknown> }
/**
 * 从会话事件里认出「调用了哪个技能」。三条真实路径（均按实际会话日志核对）：
 *
 * 1. `tool/ptc-dispatch` —— **主路径**。模型经 run_code 等 PTC 工具间接调用技能时，
 *    真正的 `skill` 调用只出现在这个事件里，且它**自带结果**（data.isError）。
 * 2. `tool/call` —— 模型直接调用 skill 工具：先落一条无 ok 的调用，并用 callId
 *    记进 pending；随后的 `tool/result.data.message.toolCallId` 配对上时，再追加
 *    一条**同 (name, ts)** 但带 ok 的记录。aggregate 按 (name, ts) 去重、后者覆盖
 *    前者，所以总调用次数不翻倍，成败却能补上。
 * 3. `user/message` —— 用户 `/技能名` 显式调用：真实日志里没有结果事件，保持未知。
 */
function skillNameFromArguments(raw: unknown): string | null {
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw) } catch { return null }
  }
  const name = (parsed as { name?: unknown } | null)?.name
  return typeof name === 'string' && name.trim() ? name.trim() : null
}

export function skillNameFromEvent(event: SessionLikeEvent): string | null {
  const d = event.data || {}
  if (event.type === 'tool/ptc-dispatch') {
    if (d.name !== 'skill') return null
    return skillNameFromArguments(d.arguments)
  }
  if (event.type === 'tool/call') {
    if (d.name !== 'skill') return null
    return skillNameFromArguments(d.arguments)
  }
  if (event.type === 'user/message') {
    const s = d.source as { kind?: string; name?: string } | undefined
    if (s && s.kind === 'skill-invocation' && typeof s.name === 'string' && s.name.trim()) return s.name.trim()
  }
  return null
}

export function createSkillCallHandler(file: string) {
  /** callId → {name, ts}：同一技能并发两次靠 callId 各自配对，不按 name 串号。 */
  const pending = new Map<string, { name: string; ts: number }>()

  const write = async (name: string, ts: number, ok?: boolean): Promise<void> => {
    try { await appendEntry(file, { name, ts, ...(ok === undefined ? {} : { ok }) }) } catch { /* 写失败不阻断调用 */ }
  }

  return async (event: SessionLikeEvent): Promise<void> => {
    const resultId = resultCallId(event)
    // 结果事件：按 callId 配对 pending，补写带 ok 的同键记录。
    if (resultId !== undefined) {
      const p = pending.get(resultId)
      const ok = resultOk(event)
      if (p !== undefined && ok !== undefined) {
        pending.delete(resultId)
        await write(p.name, p.ts, ok)
      }
      return
    }

    const name = skillNameFromEvent(event)
    if (name === null) return
    const ts = Number(event.time) || Date.now()
    // ptc-dispatch 自带结果，直接落一条带 ok 的。
    const ptcOkValue = ptcOk(event)
    if (ptcOkValue !== undefined) {
      await write(name, ts, ptcOkValue)
      return
    }
    const callId = callIdOf(event) ?? ptcSubCallId(event)
    await write(name, ts)
    if (callId !== undefined) pending.set(callId, { name, ts })
  }
}
