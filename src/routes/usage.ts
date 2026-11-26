/**
 * Permanent usage stats route: aggregates the append-only skill-call ledger
 * into today/week/total rows. Registered as a RouteSpec under the hub prefix,
 * so createRoute wraps it with the shared trust fence, master switch and
 * 404 catch-all — no separate WebRoute.
 */
import { join } from 'node:path'
import { SKILL_HUB_API, type PermanentStatsResponse } from '../protocol.ts'
import { aggregate } from '../counter/aggregate.ts'
import { readLedger } from '../counter/ledger.ts'
import { homeOf, writeJson, type RouteContext, type RouteSpec, type SkillHubRouteDeps } from './helpers.ts'

export function makeUsageHandler(file: string, now: () => number = Date.now) {
  return async (ctx: RouteContext): Promise<void> => {
    const { entries, skipped } = await readLedger(file)
    const rows = aggregate(entries, now())
    const stats = [...rows.entries()]
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => a.name.localeCompare(b.name))
    const body: PermanentStatsResponse = {
      ok: true,
      stats,
      skipped,
      note: 'Permanent counts start from plugin installation only.',
    }
    writeJson(ctx.res, 200, body)
  }
}

export function usageRoutes(deps: SkillHubRouteDeps): RouteSpec[] {
  // Must match the recorder's path in index.ts:
  // join(dshHome(), 'skill-usage-manager', 'usage-ledger.jsonl').
  const usageLedgerFile = join(homeOf(deps), 'skill-usage-manager', 'usage-ledger.jsonl')
  return [
    { path: SKILL_HUB_API.permanentStats, methods: ['GET'], handler: makeUsageHandler(usageLedgerFile) },
  ]
}
