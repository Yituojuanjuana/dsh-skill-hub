import { describe, expect, it } from 'vitest'
import { setInvocationFlags } from './frontmatter.ts'

describe('setInvocationFlags', () => {
  it('保留 CRLF、BOM、字段顺序与正文，只改目标键', () => {
    const src = '\ufeff---\r\nname: demo\r\n# 说明注释\r\ndisable-model-invocation: true\r\ndescription: "A skill"\r\n---\r\n# 正文\r\n'
    const out = setInvocationFlags(src, { modelInvocable: true, userInvocable: false })
    expect(out.startsWith('\ufeff')).toBe(true)
    expect(out).toContain('\r\n')
    expect(out).not.toContain('disable-model-invocation')
    expect(out).toContain('user-invocable: false')
    expect(out.indexOf('# 说明注释')).toBeLessThan(out.indexOf('user-invocable'))
    expect(out).toContain('# 正文')
  })

  it('关模型调用写 disable-model-invocation: true，关用户调用写 user-invocable: false', () => {
    const src = '---\nname: demo\ndescription: d\n---\nbody\n'
    const out = setInvocationFlags(src, { modelInvocable: false, userInvocable: false })
    expect(out).toBe('---\nname: demo\ndescription: d\ndisable-model-invocation: true\nuser-invocable: false\n---\nbody\n')
  })

  it('开启时删除对应键（与解析器默认值一致）', () => {
    const src = '---\nname: demo\ndescription: d\nuser-invocable: false\ndisable-model-invocation: true\n---\n'
    const out = setInvocationFlags(src, { modelInvocable: true, userInvocable: true })
    expect(out).toBe('---\nname: demo\ndescription: d\n---\n')
  })

  it('没有 frontmatter 时补最小块，保留 description 与正文', () => {
    const src = 'description: 一段描述\n# 正文\n更多内容\n'
    const out = setInvocationFlags(src, { modelInvocable: false, userInvocable: true })
    // 顶层 description 行被移到 frontmatter，正文不重复保留该行。
    expect(out).toBe('---\ndescription: 一段描述\ndisable-model-invocation: true\n---\n# 正文\n更多内容\n')
  })

  it('只请求一个开关时另一个键原样不动', () => {
    const src = '---\nname: demo\ndescription: d\nuser-invocable: false\n---\n'
    const out = setInvocationFlags(src, { modelInvocable: false, userInvocable: false })
    expect(out).toContain('user-invocable: false')
    expect(out).toContain('disable-model-invocation: true')
    const out2 = setInvocationFlags(src, { modelInvocable: true, userInvocable: false })
    expect(out2).toBe(src)
  })
})
