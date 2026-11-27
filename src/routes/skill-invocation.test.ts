import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeRoutes } from '../routes.ts'
import { SKILL_HUB_API, SKILL_HUB_WRITE_HEADER, SKILL_HUB_WRITE_VALUE, type ErrorResponse, type SkillInvocationResponse } from '../protocol.ts'
import { SkillHubStore, statePath } from '../store.ts'
import type { SkillHubRouteDeps } from './helpers.ts'

class FakeResponse {
  status = 0
  headers: Record<string, string> = {}
  body = ''
  writeHead(status: number, headers?: Record<string, string>): void { this.status = status; if (headers !== undefined) this.headers = headers }
  end(chunk?: string): void { this.body = chunk ?? '' }
  json(): unknown { try { return JSON.parse(this.body) } catch { return undefined } }
}

function fakeReq(method: string, body?: unknown, remoteAddress = '127.0.0.1', headers: Record<string, string> = {}): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url: SKILL_HUB_API.skillInvocation,
    headers: { host: '127.0.0.1:3080', ...(method === 'POST' ? { [SKILL_HUB_WRITE_HEADER]: SKILL_HUB_WRITE_VALUE } : {}), ...headers },
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
  } as unknown as IncomingMessage
}

describe('POST skill/invocation route', () => {
  let dir: string
  let home: string
  let deps: SkillHubRouteDeps
  let skillPath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-skill-invocation-'))
    home = join(dir, 'home')
    const skillsDir = join(home, 'skills')
    await mkdir(skillsDir, { recursive: true })
    await mkdir(join(skillsDir, 'demo'), { recursive: true })
    skillPath = join(skillsDir, 'demo', 'SKILL.md')
    await writeFile(skillPath, '---\nname: demo\ndescription: d\n---\nbody\n', 'utf8')
    const store = new SkillHubStore(statePath(home))
    deps = {
      home,
      userHome: dir,
      store,
      skills: {
        snapshot: async () => ({ skills: [], complete: true }),
        get: async () => ({
          name: 'demo',
          description: 'd',
          invocation: { modelInvocable: true, userInvocable: true },
          source: 'user-dsh',
          provider: 'filesystem',
          path: skillPath,
          content: 'body',
        }),
      },
    }
  })

  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  async function invoke(body: unknown, req?: (r: IncomingMessage) => IncomingMessage): Promise<FakeResponse> {
    const route = makeRoutes(deps).find((r) => r.path === SKILL_HUB_API.skillInvocation)!
    const res = new FakeResponse()
    const request = fakeReq('POST', body)
    await route.handler(req !== undefined ? req(request) : request, res as never)
    return res
  }

  it('happy path: 改 frontmatter 并返回新状态', async () => {
    const res = await invoke({ name: 'demo', modelInvocable: false })
    expect(res.status).toBe(200)
    const body = res.json() as SkillInvocationResponse
    expect(body.invocation).toEqual({ modelInvocable: false, userInvocable: true })
    const text = await readFile(skillPath, 'utf8')
    expect(text).toContain('disable-model-invocation: true')
  })

  it('不可写文件返回 409 + 明确原因', async () => {
    await chmod(skillPath, 0o444)
    const res = await invoke({ name: 'demo', userInvocable: false })
    expect(res.status).toBe(409)
    expect(String((res.json() as ErrorResponse).error)).toContain('not writable')
  })

  it('缺标记头 / 非回环来源被围栏拒绝', async () => {
    const noHeader = await invoke({ name: 'demo', modelInvocable: false },
      () => fakeReq('POST', { name: 'demo', modelInvocable: false }, '127.0.0.1', { [SKILL_HUB_WRITE_HEADER]: '' }))
    expect(noHeader.status).toBe(403)
    const remote = await invoke({ name: 'demo' }, () => fakeReq('POST', { name: 'demo' }, '10.0.0.5'))
    expect(remote.status).toBe(403)
  })
})
