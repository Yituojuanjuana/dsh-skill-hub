/**
 * 工作区卡片标题只显示项目名称，不显示完整路径。
 *
 * 真实问题：卡片头里出现 `E:\67549\Desktop\熊阳阳\sports-coach` 这种长路径，
 * 既占位又难读。名称优先用登记 title；拿不到时退回路径末段（而不是整条路径）。
 * 完整路径只留在 `title` 属性（hover tooltip）里。
 */
import { describe, expect, it } from 'vitest'

/** 复刻 ProjectTree 的 nameOf 逻辑。 */
function nameOf(workspace: string | undefined, workspaceTitle: string | undefined, fallback: string): string {
  if (workspaceTitle !== undefined && workspaceTitle !== '' && workspaceTitle !== workspace) return workspaceTitle
  if (workspace === undefined || workspace === '') return fallback
  const parts = workspace.split(/[\\/]/).filter((part) => part !== '')
  return parts[parts.length - 1] ?? workspace
}

const FALLBACK = '项目'

describe('card title shows the name only', () => {
  it('uses the registered title when available', () => {
    expect(nameOf('E:\\67549\\Desktop\\熊阳阳\\sports-coach', 'sports-coach', FALLBACK)).toBe('sports-coach')
  })

  it('falls back to the last path segment, never the whole path', () => {
    const label = nameOf('E:\\67549\\Desktop\\熊阳阳\\sports-coach', undefined, FALLBACK)
    expect(label).toBe('sports-coach')
    // 关键：不能把整条路径当标题。
    expect(label).not.toContain('E:')
    expect(label).not.toContain('\\')
  })

  it('handles POSIX separators too', () => {
    expect(nameOf('/home/u/projects/my-app', undefined, FALLBACK)).toBe('my-app')
  })

  it('ignores a title that is just the path', () => {
    // 后端兜底会把 title 设成 path，这种等于没名字。
    const label = nameOf('E:\\a\\b\\sports-coach', 'E:\\a\\b\\sports-coach', FALLBACK)
    expect(label).toBe('sports-coach')
  })

  it('returns the fallback when there is no workspace at all', () => {
    expect(nameOf(undefined, undefined, FALLBACK)).toBe(FALLBACK)
    expect(nameOf('', '', FALLBACK)).toBe(FALLBACK)
  })

  it('tolerates a trailing separator', () => {
    expect(nameOf('E:\\a\\b\\sports-coach\\', undefined, FALLBACK)).toBe('sports-coach')
  })

  it('every produced label is short enough to sit in a card header', () => {
    const label = nameOf('E:\\67549\\Desktop\\熊阳阳\\sports-coach', undefined, FALLBACK)
    // 名称本身远短于路径；CSS 再补一层 22ch 截断。
    expect(label.length).toBeLessThan(40)
  })
})
