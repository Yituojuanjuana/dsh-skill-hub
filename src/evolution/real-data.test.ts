/** 用本机真实会话日志验证：多帧解压能读全，取样能挑到长会话。 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { decompressAllFrames, parseEvents } from './session-log.ts'
import { messagesFromSurface } from './wiring.ts'

function find(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name === 'session.v4.jsonl.zstd') out.push(full)
    }
  }
  walk(root)
  return out
}

describe('real session logs', () => {
  it('decodes every frame of the largest session (not just the header)', { timeout: 60_000 }, () => {
    const files = find(join(homedir(), '.dsh', 'sessions'))
    if (files.length === 0) return
    const largest = files
      .map((path) => ({ path, size: statSync(path).size }))
      .sort((a, b) => b.size - a.size)[0]!
    const text = decompressAllFrames(readFileSync(largest.path))
    const events = parseEvents(text)
    // 只解第一帧时这里只有 1 个 session 事件；完整解压必然有大量事件。
    expect(events.length).toBeGreaterThan(10)
    expect(events.some((event) => event.type === 'user/message' || event.type === 'assistant/message')).toBe(true)
    // 真实的用户消息也要能转出来。
    const messages = messagesFromSurface(events)
    expect(messages.length).toBeGreaterThan(10)
  })

  it('finds sessions with enough user messages to be sampled', { timeout: 120_000 }, () => {
    const files = find(join(homedir(), '.dsh', 'sessions'))
    if (files.length === 0) return
    let qualifying = 0
    for (const path of files) {
      const events = parseEvents(decompressAllFrames(readFileSync(path)))
      const users = messagesFromSurface(events).filter((message) => message.role === 'user').length
      if (users >= 3) qualifying += 1
    }
    // 本机有 100+ 个会话，其中相当一部分达到取样阈值。
    expect(qualifying).toBeGreaterThan(10)
  })
})