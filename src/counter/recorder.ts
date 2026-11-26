import { appendEntry } from './ledger.ts'
export type SessionLikeEvent = { type: string; time: number; data: Record<string, unknown> }
/**
 * 从会话事件里认出「调用了哪个技能」。三条真实路径（均按实际会话日志核对）：
 *
 * 1. `tool/ptc-dispatch` —— **主路径**。模型经 run_code 等 PTC 工具间接调用技能时，
 *    真正的 `skill` 调用只出现在这个事件里：data 形如
 *    `{ name:'skill', arguments:{ name:'dsh-doc' }, ... }`（arguments 已是对象）。
 *    这类调用**不会**产生 `name==='skill'` 的 `tool/call`，漏掉它就完全统计不到。
 * 2. `tool/call` —— 模型直接调用 skill 工具时：data 带 `{ name, arguments }`，
 *    arguments 是 JSON 字符串。
 * 3. `user/message` —— 用户 `/技能名` 显式调用：source.kind === 'skill-invocation'。
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
  // 1. PTC 派发：run_code 等工具内部的 skill 调用只在这里可见。
  if (event.type === 'tool/ptc-dispatch') {
    if (d.name !== 'skill') return null
    return skillNameFromArguments(d.arguments)
  }
  // 2. 直接的工具调用。
  if (event.type === 'tool/call') {
    if (d.name !== 'skill') return null
    return skillNameFromArguments(d.arguments)
  }
  // 3. 用户显式 /技能名 调用。
  if (event.type === 'user/message') {
    const s = d.source as { kind?: string; name?: string } | undefined
    if (s && s.kind === 'skill-invocation' && typeof s.name === 'string' && s.name.trim()) return s.name.trim()
  }
  return null
}

export function createSkillCallHandler(file: string) {
  return async (event: SessionLikeEvent): Promise<void> => {
    const name = skillNameFromEvent(event)
    if (!name) return
    try { await appendEntry(file, { name, ts: Number(event.time) || Date.now() }) } catch { /* 写入失败不阻断调用 */ }
  }
}
