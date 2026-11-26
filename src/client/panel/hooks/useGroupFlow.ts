/**
 * useGroupFlow — 分组域：groups 加载（来源集合 / origin 映射）。
 * 这里只剩「加载分组数据」这一职责：来源集合与 origin 映射仍被市场页和
 * 来源跟踪复用。
 */

import { useCallback, useState } from 'react'
import type { GroupsResponse } from '../../../protocol.ts'
import type { SkillHubApi } from '../../api.ts'
import { errorMessage } from '../../helpers.ts'
import type { FlowNotices } from './shared.ts'

export function useGroupFlow(api: SkillHubApi, shared: FlowNotices) {
  const [groupsState, setGroupsState] = useState<GroupsResponse | null>(null)

  /** 加载分组数据 + 系统集合组 + origin 映射。 */
  const loadGroups = useCallback(async (): Promise<void> => {
    try {
      setGroupsState(await api.groups())
    } catch (error) {
      shared.fail(errorMessage(error))
    }
  }, [api, shared])

  return { groupsState, loadGroups }
}