/**
 * useMetaFlow — 自身更新检查 + 调用统计 + 配置：只依赖 api，不碰其他域。
 *
 * 调用量只保留**永久账本**（插件自己记的日/周/总，含历史导入）。原先并行的
 * 会话日志统计已移除：两套数字并排显示既冗余又容易互相矛盾，用户只需要一个
 * 可信的调用量。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { HubConfig, PermanentStat } from '../../../protocol.ts'
import type { SkillHubApi } from '../../api.ts'
import { errorMessage } from '../../helpers.ts'
import { POLL_MS, USES_CATCH_UP_MAX, type UpdateState } from './shared.ts'

export function useMetaFlow(api: SkillHubApi) {
  const [updateState, setUpdateState] = useState<UpdateState>({ status: 'idle' })
  const [permanentUses, setPermanentUses] = useState<ReadonlyMap<string, PermanentStat>>(new Map())
  const [hubConfig, setHubConfig] = useState<HubConfig | null>(null)

  const loadPermanentUses = useCallback(async (): Promise<void> => {
    try {
      const result = await api.getPermanentStats()
      setPermanentUses(new Map(result.stats.map((stat) => [stat.name, stat])))
    } catch {
      // Permanent counters are best-effort; a failure must not disturb the catalog.
    }
  }, [api])

  const loadConfig = useCallback(async (): Promise<void> => {
    try {
      setHubConfig((await api.config()).config)
    } catch {
      // Dot colors are cosmetic; a config failure falls back to the defaults.
    }
  }, [api])

  const checkUpdate = useCallback(async (): Promise<void> => {
    setUpdateState({ status: 'checking' })
    try {
      // 用户主动点的，绕开服务端缓存（force）——点了就该看到真实结果。
      setUpdateState({ status: 'ready', data: await api.updateCheck(true) })
    } catch (error) {
      setUpdateState({ status: 'error', message: errorMessage(error) })
    }
  }, [api])

  // 永久统计是 SWR：首刷可能命中冷启动（回空数组、后台读账本中）。
  // 补捞轮询：空数时每 5 秒捞一次，有数即停（最多约 6 分钟），之后交给 60 秒轮询。
  const usesCatchUp = useRef(0)
  useEffect(() => {
    if (permanentUses.size > 0 || usesCatchUp.current >= USES_CATCH_UP_MAX) return
    const timer = window.setInterval(() => {
      usesCatchUp.current += 1
      void loadPermanentUses()
      if (usesCatchUp.current >= USES_CATCH_UP_MAX) window.clearInterval(timer)
    }, POLL_MS)
    return () => { window.clearInterval(timer) }
  }, [permanentUses.size, loadPermanentUses])

  return { updateState, checkUpdate, permanentUses, loadPermanentUses, hubConfig, loadConfig }
}
