/**
 * invocation 写入判据的**唯一来源**：catalog 行与 invocation 路由共用。
 *
 * 可写 = 路径解析得到 + 落在任一已知技能根（hub 可写根 / 已登记工作区项目
 * 目录 / 外部 Agent 根）+ 文件可写。不用字符串前缀比较：resolve + relative，
 * 大小写差异、`..` 穿越、绝对路径都被排除。
 */
import { access, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { rootOfPath, projectSkillsRoot, foreignRootOfPath } from '../skillfs/paths.ts'
import { workspaceEntries, type WorkspaceEntry } from './catalog-data.ts'
import { homeOf, userHomeOf, type SkillHubRouteDeps } from './deps.ts'

/**
 * 判断一个技能路径是否落在任一已知技能根内（纯路径判定，不碰文件系统权限）。
 * @param path - 技能发现文件绝对路径。
 * @param deps - 路由依赖（读 home / userHome / 工作区清单）。
 */
export async function isWithinKnownSkillRoot(path: string | undefined, deps: SkillHubRouteDeps): Promise<boolean> {
  if (path === undefined || path === '') return false
  const target = resolve(path)
  if (rootOfPath(target, homeOf(deps)) !== undefined) return true
  if (foreignRootOfPath(target, userHomeOf(deps)) !== undefined) return true
  const workspaces: WorkspaceEntry[] = await workspaceEntries(homeOf(deps))
  for (const workspace of workspaces) {
    const rel = relative(resolve(projectSkillsRoot(workspace.path)), target)
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return true
  }
  return false
}

/**
 * catalog 用：路径在已知根内 + 文件可读且可写。
 * 只用 access(W_OK) 探测权限，不真正写文件；探测失败一律视为不可写。
 */
export async function canWriteInvocation(path: string | undefined, deps: SkillHubRouteDeps): Promise<boolean> {
  if (!(await isWithinKnownSkillRoot(path, deps))) return false
  try {
    await stat(resolve(path!))
    await access(resolve(path!), 2 /* W_OK */)
    return true
  } catch {
    return false
  }
}
