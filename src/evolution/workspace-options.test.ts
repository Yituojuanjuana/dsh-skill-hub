/**
 * 工作区下拉：选项构造与路径归一化。
 *
 * 真实故障：`workspace.json` 里的路径与 session header 里的 cwd 写法可能不同
 * （大小写、正斜杠/反斜杠、尾部斜杠）。用原始字符串比对会让 select 的 value
 * 匹配不到任何 option —— 浏览器显示成空白，看起来就是「下拉没有内容」。
 */
import { describe, expect, it } from 'vitest'

/** 复刻 WorkspaceView 的归一化比较。 */
const norm = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
const samePath = (a: string, b: string): boolean => norm(a) === norm(b)

/** 复刻选项构造逻辑。 */
function buildOptions(
  currentWorkspace: string,
  workspaces: ReadonlyArray<{ path: string; title: string }>,
  selected: string,
): Array<{ path: string; label: string }> {
  const list: Array<{ path: string; label: string }> = []
  const seen = new Set<string>()
  const titleOf = (path: string): string => {
    const hit = workspaces.find((entry) => samePath(entry.path, path))
    if (hit !== undefined && hit.title !== '' && hit.title !== hit.path) return hit.title
    const parts = path.split(/[\\/]/).filter((part) => part !== '')
    return parts[parts.length - 1] ?? path
  }
  const push = (path: string, label: string): void => {
    if (path === '') return
    const key = norm(path)
    if (seen.has(key)) return
    seen.add(key)
    list.push({ path, label })
  }
  if (currentWorkspace !== '') push(currentWorkspace, titleOf(currentWorkspace))
  for (const entry of workspaces) push(entry.path, entry.title !== '' ? entry.title : titleOf(entry.path))
  if (selected !== '' && !seen.has(norm(selected))) push(selected, titleOf(selected))
  return list
}

const REGISTERED = [
  { path: 'E:\\67549\\Documents\\deepseek-harness\\default-workspace', title: 'default-workspace' },
  { path: 'E:\\67549\\Desktop\\熊阳阳\\sports-coach', title: 'sports-coach' },
]

describe('path normalization', () => {
  it('treats backslash and forward slash paths as equal', () => {
    expect(samePath('E:\\a\\b', 'E:/a/b')).toBe(true)
  })

  it('ignores a trailing separator', () => {
    expect(samePath('E:\\a\\b\\', 'E:\\a\\b')).toBe(true)
    expect(samePath('E:/a/b/', 'E:\\a\\b')).toBe(true)
  })

  it('ignores case', () => {
    expect(samePath('E:\\A\\B', 'e:/a/b')).toBe(true)
  })

  it('does not equate different directories', () => {
    expect(samePath('E:\\a\\b', 'E:\\a\\bc')).toBe(false)
  })
})

describe('option building', () => {
  it('lists every registered workspace', () => {
    const options = buildOptions('', REGISTERED, '')
    expect(options.map((o) => o.label)).toEqual(['default-workspace', 'sports-coach'])
  })

  it('puts the current conversation workspace first', () => {
    const options = buildOptions(REGISTERED[1]!.path, REGISTERED, REGISTERED[1]!.path)
    expect(options[0]?.label).toBe('sports-coach')
  })

  it('does not duplicate the current workspace when it is also registered', () => {
    // 关键回归：以前「当前工作区」与列表项用原始字符串比对，写法不同就重复出现，
    // 而且 select 的 value 匹配不到 → 显示空白。
    const options = buildOptions(REGISTERED[0]!.path, REGISTERED, REGISTERED[0]!.path)
    expect(options).toHaveLength(2)
    expect(options.filter((o) => norm(o.path) === norm(REGISTERED[0]!.path))).toHaveLength(1)
  })

  it('dedupes when the current workspace differs only in separators', () => {
    const options = buildOptions('E:/67549/Documents/deepseek-harness/default-workspace/', REGISTERED, REGISTERED[0]!.path)
    expect(options).toHaveLength(2)
  })

  it('always contains an option matching the selected value', () => {
    // 这条是「下拉显示空白」的直接防线。
    const options = buildOptions('', REGISTERED, REGISTERED[0]!.path)
    const values = options.map((o) => norm(o.path))
    expect(values).toContain(norm(REGISTERED[0]!.path))
  })

  it('appends an unregistered selection so it is not lost', () => {
    const options = buildOptions('', REGISTERED, 'E:\\some\\unregistered\\dir')
    expect(options).toHaveLength(3)
    expect(options[2]?.label).toBe('dir')
  })

  it('never emits an empty path option', () => {
    for (const option of buildOptions('', REGISTERED, '')) {
      expect(option.path).not.toBe('')
    }
  })

  it('falls back to the last path segment when title is missing', () => {
    const options = buildOptions('', [{ path: 'E:\\a\\no-title-here', title: '' }], '')
    expect(options[0]?.label).toBe('no-title-here')
  })
})
