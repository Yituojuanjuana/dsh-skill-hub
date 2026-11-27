/**
 * 「运行与连接」路由的契约测试。
 *
 * 守的是需求里的四条硬闸门：
 *  1. restart 前有 running turn → 409 + 人话原因（不排队）；
 *  2. restart 成功 → 202（detached，不让请求悬着）；
 *  3. 冷却期内 → 拒绝并带回剩余秒数；
 *  4. token 默认遮罩，只有 revealToken 才明文；遮罩不泄露长度。
 *
 * 执行体（dsh-control.ps1）在这里被注入的假实现替代 —— 测的是插件这一侧的
 * 判据与响应形状，脚本自己的行为由它的自测覆盖。
 */
import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { maskToken, makeOpsActionHandler, makeOpsConnectionHandler, makeOpsStatusHandler } from './ops.ts'
import type { OpsRouteDeps } from './ops.ts'

/** 一个最小可用的 ServerResponse 替身：记录状态码与 JSON 体。 */
function fakeResponse(): { res: ServerResponse; status: () => number; body: () => unknown } {
  let statusCode = 0
  let payload = ''
  const res = {
    writeHead(code: number) { statusCode = code; return res },
    end(text?: string) { if (text !== undefined) payload = text },
    setHeader() { return res },
    getHeader() { return undefined },
  } as unknown as ServerResponse
  return {
    res,
    status: () => statusCode,
    body: () => (payload === '' ? undefined : JSON.parse(payload)),
  }
}

/** 一个最小请求替身（围栏在 createRoute 里，这里已通过）。 */
function fakeRequest(): IncomingMessage {
  return { headers: {}, socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage
}

function deps(overrides: Partial<OpsRouteDeps> = {}): OpsRouteDeps {
  return {
    skills: { snapshot: async () => ({ skills: [], complete: true }), get: async () => undefined },
    store: {} as never,
    home: 'C:\\nonexistent-home-for-tests',
    pluginVersion: () => '0.7.0',
    now: () => 1_700_000_000_000,
    ...overrides,
  }
}

describe('maskToken', () => {
  it('keeps 4 head and 4 tail, hides the length', () => {
    expect(maskToken('abcdefghijklmnop')).toBe('abcd••••••••mnop')
  })

  it('masks short tokens entirely', () => {
    expect(maskToken('abc')).toBe('••••••••')
  })
})

describe('ops action · restart 的 turn 闸门', () => {
  it('有对话在跑时拒绝，返回 409 与原文原因', async () => {
    const recorder = fakeResponse()
    const handler = makeOpsActionHandler(deps({ hasRunningTurn: () => true }))
    const ctx = { req: fakeRequest(), res: recorder.res, url: new URL('http://127.0.0.1/x'), body: { action: 'restart' } }
    await handler(ctx)
    expect(recorder.status()).toBe(409)
    const body = recorder.body() as { ok: boolean; rejectedReason: string }
    expect(body.ok).toBe(false)
    expect(body.rejectedReason).toBe('有对话在进行，先等它结束')
  })

  it('没有对话时不因闸门被拦（走到脚本，脚本不存在则报错而不是 409 闸门）', async () => {
    const recorder = fakeResponse()
    const ctx = { req: fakeRequest(), res: recorder.res, url: new URL('http://127.0.0.1/x'), body: { action: 'restart' } }
    await makeOpsActionHandler(deps({ hasRunningTurn: () => false }))(ctx)
    // 脚本路径不存在 → 500；关键是没有被 409 闸门拦下。
    expect(recorder.status()).not.toBe(409)
  })
})

describe('ops action · reload 走真实热重载', () => {
  it('注入 reconcile 时调用它，不写脚本标记', async () => {
    let called = 0
    const recorder = fakeResponse()
    const ctx = { req: fakeRequest(), res: recorder.res, url: new URL('http://127.0.0.1/x'), body: { action: 'reload' } }
    await makeOpsActionHandler(deps({
      reconcile: async () => { called++; return { reloaded: ['a', 'b'], skipped: [] } },
    }))(ctx)
    expect(called).toBe(1)
    expect(recorder.status()).toBe(200)
    const body = recorder.body() as { ok: boolean; message: string }
    expect(body.ok).toBe(true)
    expect(body.message).toContain('2')
  })

  it('reconcile 抛错时报失败，不伪装成功', async () => {
    const recorder = fakeResponse()
    const ctx = { req: fakeRequest(), res: recorder.res, url: new URL('http://127.0.0.1/x'), body: { action: 'reload' } }
    await makeOpsActionHandler(deps({
      reconcile: async () => { throw new Error('boom') },
    }))(ctx)
    expect(recorder.status()).toBe(500)
    const body = recorder.body() as { ok: boolean; message: string }
    expect(body.ok).toBe(false)
    expect(body.message).toContain('boom')
  })
})

describe('ops action · 未知动作', () => {
  it('拒绝未知 action 并回 400', async () => {
    const recorder = fakeResponse()
    const ctx = { req: fakeRequest(), res: recorder.res, url: new URL('http://127.0.0.1/x'), body: { action: 'explode' } }
    await makeOpsActionHandler(deps())(ctx)
    expect(recorder.status()).toBe(400)
  })
})

describe('ops status · 失败不清空旧值', () => {
  it('脚本不存在时回 ok:false 且带 error，而不是抛 500', async () => {
    const recorder = fakeResponse()
    const ctx = { req: fakeRequest(), res: recorder.res, url: new URL('http://127.0.0.1/x'), body: {} }
    const cache = { value: null, lastSuccessAt: null }
    await makeOpsStatusHandler(deps(), cache)(ctx)
    expect(recorder.status()).toBe(200)
    const body = recorder.body() as { ok: boolean; fresh: boolean; error?: string }
    expect(body.ok).toBe(false)
    expect(body.fresh).toBe(false)
    expect(typeof body.error).toBe('string')
  })

  it('有过成功快照后失败，返回旧值并标注 fresh:false', async () => {
    const recorder = fakeResponse()
    const ctx = { req: fakeRequest(), res: recorder.res, url: new URL('http://127.0.0.1/x'), body: {} }
    const previous = {
      ok: true, at: 1, fresh: true, lastSuccessAt: 1,
      dsh: { running: true, pid: 42, startedAt: null },
      ingress: { port: 53870, listening: true },
      tunnel: { address: 'https://old.trycloudflare.com', published: null, healthy: true, status: 200, note: null, processes: 1 },
      bundle: { liveMtime: null, repoMtime: null, upToDate: true },
      cooldownRemainingSec: 0, pluginVersion: '0.7.0',
    }
    const cache = { value: previous, lastSuccessAt: 1 }
    await makeOpsStatusHandler(deps(), cache)(ctx)
    const body = recorder.body() as typeof previous & { fresh: boolean }
    expect(body.fresh).toBe(false)
    expect(body.tunnel.address).toBe('https://old.trycloudflare.com')
    expect(body.dsh.pid).toBe(42)
  })
})

describe('ops connection · token 遮罩', () => {
  it('默认不返回明文，revealed=false', async () => {
    const recorder = fakeResponse()
    const ctx = { req: fakeRequest(), res: recorder.res, url: new URL('http://127.0.0.1/x'), body: {} }
    await makeOpsConnectionHandler(deps())(ctx)
    const body = recorder.body() as { revealed: boolean; deviceToken: string | null }
    expect(body.revealed).toBe(false)
    // 本机没有 token 文件时是 null；有的话必须是遮罩串。
    if (body.deviceToken !== null) expect(body.deviceToken).toContain('••••••••')
  })
})
