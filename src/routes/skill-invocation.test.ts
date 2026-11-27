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

  it('project-dsh 项目技能也能改（不再被 source 只读判定拦住）', async () => {
    const ws = join(dir, 'workspace')
    const projectSkill = join(ws, '.dsh', 'skills', 'proj-skill', 'SKILL.md')
    await mkdir(join(ws, '.dsh', 'skills', 'proj-skill'), { recursive: true })
    await writeFile(projectSkill, '---\nname: proj-skill\ndescription: p\n---\nbody\n', 'utf8')
    await mkdir(join(home, 'storages'), { recursive: true })
    await writeFile(join(home, 'storages', 'workspace.json'), JSON.stringify({
      tables: { workspaces: { ws: { path: ws, title: 'ws' } } },
    }), 'utf8')
    deps.skills.get = async () => ({
      name: 'proj-skill', description: 'p',
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'project-dsh', provider: 'filesystem', path: projectSkill, content: 'body',
    })
    const res = await invoke({ name: 'proj-skill', userInvocable: false, cwd: ws })
    expect(res.status).toBe(200)
    expect((res.json() as SkillInvocationResponse).invocation).toEqual({ modelInvocable: true, userInvocable: false })
    expect(await readFile(projectSkill, 'utf8')).toContain('user-invocable: false')
  })

  it('路径跑出所有已知技能根 → 403（防 name 穿越写任意文件）', async () => {
    const outside = join(dir, 'elsewhere', 'evil.md')
    await mkdir(join(dir, 'elsewhere'), { recursive: true })
    await writeFile(outside, '---\nname: evil\n---\n', 'utf8')
    deps.skills.get = async () => ({
      name: 'evil', description: '',
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'user-dsh', provider: 'filesystem', path: outside, content: '',
    })
    const res = await invoke({ name: 'evil', userInvocable: false })
    expect(res.status).toBe(403)
    expect(String((res.json() as ErrorResponse).error)).toContain('outside every known skills root')
  })

  it('技能解析不到 → 404', async () => {
    deps.skills.get = async () => undefined
    const res = await invoke({ name: 'ghost', userInvocable: false })
    expect(res.status).toBe(404)
    expect(String((res.json() as ErrorResponse).error)).toContain('skill not found')
  })

  it('实测闭环：写入后重新解析 SKILL.md，新状态反映到 catalog 定义', async () => {
    // 证据：点「用户可调用」→ 路由写 frontmatter → invalidate → 重新
    // 解析同一份 SKILL.md 得到的 invocation 就是写入后的值（catalog 真值）。
    let current = { modelInvocable: true, userInvocable: true }
    deps.skills.get = async () => ({
      name: 'demo', description: 'd', invocation: { ...current },
      source: 'user-dsh', provider: 'filesystem', path: skillPath, content: 'body',
    })
    let invalidated = 0
    deps.invalidate = () => { invalidated++ }

    const res = await invoke({ name: 'demo', userInvocable: false })
    expect(res.status).toBe(200)
    expect((res.json() as SkillInvocationResponse).invocation.userInvocable).toBe(false)
    expect(invalidated).toBe(1)

    // 模拟 provider.get 重读磁盘（真实 SkillHubProvider.get 就是 parseFrontmatter(readFile)）。
    const { parseFrontmatter } = await import('../skillfs/frontmatter.ts')
    const parsed = parseFrontmatter(await readFile(skillPath, 'utf8'))
    current = 'error' in parsed ? current : parsed.value.invocation
    expect(current.userInvocable).toBe(false)
    expect(current.modelInvocable).toBe(true)
  })
})
