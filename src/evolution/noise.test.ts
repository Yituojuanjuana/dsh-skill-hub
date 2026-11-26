/**
 * 噪声过滤：只保留纯用户业务对话。
 *
 * 实测 1236 条 user/message 里 728 条（58.9%）是运行时注入、子代理汇报、
 * 记忆快照、后台任务通知 —— 不过滤会让聚类和计数全部失真。
 */
import { describe, expect, it } from 'vitest'
import { emptyNoiseStats, formatNoiseStats, keepUserMessage, noiseRuleOf } from './review.ts'
import { messagesFromSurface } from './wiring.ts'

describe('noiseRuleOf', () => {
  const noise = [
    ['Time sampled while preparing turn 12, step 3: 2026-11-25T20:00:00+08:00', 'time-sampled'],
    ['Agent lead sent a message: 已完成修改', 'agent-message'],
    ['Background subagent ux-reviewer finished and will do no further work', 'subagent-done'],
    ['[Plugin context from "batching-guidance"; not a user instruction]', 'plugin-context'],
    ['[MNEMON] Search Documents for substantial project records.', 'mnemon'],
    ['MNEMON RUNTIME MEMORY SNAPSHOT Entry annotations default to importance', 'mnemon'],
    ['You have made a run of tool calls without reporting progress', 'tool-run-hint'],
    ['<hindsight_knowledge> This repository has a Hindsight memory', 'hindsight'],
    ['<path>E:\\project\\file.ts', 'path-hint'],
    ['background job pwsh-ba9824b58be34ceb (pwsh: pwsh -NoProfile)', 'background-job'],
    ['The user changed the approval policy from "ask" to "never"', 'approval-policy'],
    ['Current runtime context. This snapshot supersedes earlier', 'runtime-context'],
    ['CC Safety Net did not check the command `ops_bash` just ran.', 'safety-net'],
    ['<system-reminder>some reminder</system-reminder>', 'system-reminder'],
    ['<environment_context>ctx</environment_context>', 'environment'],
  ] as const

  for (const [text, expected] of noise) {
    it(`drops ${expected}: ${text.slice(0, 40)}`, () => {
      expect(noiseRuleOf(text)?.id).toBe(expected)
    })
  }

  const real = [
    '帮我优化后台管理页面',
    '学员详情页添加学员常去的场地',
    '游泳馆排课表的课时字段要能改',
    '请在现有实现基础上继续调整：学员卡片不再展示目标、计划',
    '@用户体验设计师 学员卡片不需展示目标和计划',
    '这个页面太挤了，帮我留白多一点',
    '插件的设置按钮放错位置了',
  ]
  for (const text of real) {
    it(`keeps real request: ${text.slice(0, 30)}`, () => {
      expect(noiseRuleOf(text)).toBeUndefined()
    })
  }

  it('does not drop a real message that merely mentions a plugin', () => {
    // 模糊包含匹配会误杀这句 —— 必须是行首特征匹配。
    expect(noiseRuleOf('插件的设置按钮放错位置了')).toBeUndefined()
  })

  it('treats an empty message as noise', () => {
    expect(noiseRuleOf('   ')?.id).toBe('empty')
  })
})

describe('keepUserMessage', () => {
  it('accumulates per-rule statistics', () => {
    const stats = emptyNoiseStats()
    keepUserMessage('Time sampled while preparing turn 1', stats)
    keepUserMessage('Time sampled while preparing turn 2', stats)
    keepUserMessage('[Plugin context from "x"]', stats)
    keepUserMessage('帮我改页面', stats)
    expect(stats.checked).toBe(4)
    expect(stats.filtered).toBe(3)
    expect(stats.byRule['time-sampled']).toBe(2)
    expect(stats.byRule['plugin-context']).toBe(1)
  })

  it('formats a one-line summary with per-rule detail', () => {
    const stats = emptyNoiseStats()
    keepUserMessage('Time sampled while preparing turn 1', stats)
    keepUserMessage('真实需求', stats)
    const line = formatNoiseStats(stats)
    expect(line).toContain('kept 1/2')
    expect(line).toContain('dropped 1')
    expect(line).toContain('50.0%')
    expect(line).toContain('time-sampled=1')
  })

  it('handles the empty case', () => {
    expect(formatNoiseStats(emptyNoiseStats())).toBe('no user messages checked')
  })
})

describe('messagesFromSurface noise filtering', () => {
  const surface = [
    { type: 'user/message', data: { content: [{ type: 'text', text: '帮我优化后台管理页面' }] } },
    { type: 'user/message', data: { content: [{ type: 'text', text: 'Time sampled while preparing turn 1' }] } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '[MNEMON] memory snapshot' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好的' }] } } },
  ]

  it('keeps only real user messages and reports what was dropped', () => {
    const stats = emptyNoiseStats()
    const messages = messagesFromSurface(surface, stats)
    const users = messages.filter((m) => m.role === 'user')
    expect(users).toHaveLength(1)
    expect(users[0]?.text).toBe('帮我优化后台管理页面')
    // 助手消息不受影响。
    expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(1)
    expect(stats.filtered).toBe(2)
  })
})
