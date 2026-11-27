import { load } from 'js-yaml'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import { errorText } from '../error-text.ts'

/** One parsed frontmatter outcome (official provider semantics). */
export interface FrontmatterValue {
  name: string
  description: string
  whenToUse?: string
  /** Claude Code 的 `argument-hint`：/name 的参数提示，dsh 不消费但不能丢。 */
  argumentHint?: string
  invocation: { modelInvocable: boolean; userInvocable: boolean }
  /** Instruction body after the frontmatter block, trimmed. */
  content: string
}

/** Parse a SKILL.md the way the official filesystem provider does. */
export function parseFrontmatter(text: string): { value: FrontmatterValue } | { error: string } {
  // 先剥掉 UTF-8 BOM：Windows 上的编辑器与部分工具会写它，而 `^---` 在 BOM 之后
  // 永远匹配不上，整份技能会被判成「没有 frontmatter」而从列表里消失 —— 用户
  // 看到的就是「明明有目录却检测不到」。BOM 不是内容，剥掉不影响任何语义。
  const cleaned = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n([\s\S]*))?$/.exec(cleaned)
  if (match === null) return { error: 'missing YAML frontmatter (--- block)' }
  let data: unknown
  let rawFrontmatter = match[1]
  try {
    data = load(rawFrontmatter)
  } catch (error) {
    const repaired = repairFrontmatterScalarFields(rawFrontmatter)
    if (repaired !== null) {
      try {
        data = load(repaired)
        rawFrontmatter = repaired
      } catch {
        return { error: 'invalid YAML frontmatter: ' + (errorText(error)) }
      }
    } else {
      return { error: 'invalid YAML frontmatter: ' + (errorText(error)) }
    }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { error: 'frontmatter must be a YAML mapping' }
  }
  const record = data as Record<string, unknown>
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  if (name === '') return { error: 'frontmatter requires a name field' }
  if (!isSkillName(name)) return { error: 'invalid skill name "' + name + '" (must be kebab-case)' }
  const description = typeof record.description === 'string' ? record.description.trim() : ''
  if (description === '') return { error: 'frontmatter requires a description field' }
  const whenToUse = typeof record.whenToUse === 'string' && record.whenToUse.trim() !== '' ? record.whenToUse.trim() : undefined
  const argumentHint = typeof record['argument-hint'] === 'string' && record['argument-hint'].trim() !== '' ? record['argument-hint'].trim() : undefined
  if (Object.hasOwn(record, 'disableModelInvocation')) return { error: 'frontmatter field "disableModelInvocation" is unsupported; use "disable-model-invocation"' }
  if (Object.hasOwn(record, 'modelInvocable')) return { error: 'frontmatter field "modelInvocable" is unsupported; use "disable-model-invocation"' }
  if (Object.hasOwn(record, 'userInvocable')) return { error: 'frontmatter field "userInvocable" is unsupported; use "user-invocable"' }
  let invocation: { modelInvocable: boolean; userInvocable: boolean }
  try {
    const disableModel = frontmatterBoolean(record, 'disable-model-invocation')
    const userInvocable = frontmatterBoolean(record, 'user-invocable')
    invocation = { modelInvocable: disableModel !== true, userInvocable: userInvocable !== false }
  } catch (error) {
    return { error: errorText(error) }
  }
  return { value: { name, description, ...(whenToUse !== undefined ? { whenToUse } : {}), ...(argumentHint !== undefined ? { argumentHint } : {}), invocation, content: (match[2] ?? '').trim() } }
}

/**
 * Repair bare scalar fields that contain an unquoted colon (e.g. `description: Build for AWS: ECS`)
 * or an invalid flow-like scalar (`@`, `` ` ``, `[`, `{`). Mirrors codex `repair_frontmatter_scalar_fields`:
 * line-oriented, only touches lines where quoting makes the YAML valid, and preserves block scalars.
 * Returns the repaired frontmatter string when at least one line was quoted, otherwise null.
 */
function repairFrontmatterScalarFields(frontmatter: string): string | null {
  let changed = false
  let blockScalarIndent: number | null = null
  const repairedLines: string[] = []
  for (const line of frontmatter.split('\n')) {
    const indent = line.search(/[^ ]/)
    const effectiveIndent = indent === -1 ? line.length : indent
    if (blockScalarIndent !== null) {
      if (line.trim() === '' || effectiveIndent > blockScalarIndent) {
        repairedLines.push(line)
        continue
      }
      blockScalarIndent = null
    }
    const colonIndex = line.indexOf(':')
    if (colonIndex === -1) {
      repairedLines.push(line)
      continue
    }
    const key = line.slice(0, colonIndex)
    const value = line.slice(colonIndex + 1)
    if (key.trim() === '' || value.length === 0 || !/^\s/.test(value)) {
      repairedLines.push(line)
      continue
    }
    const trimmedStart = value.trimStart()
    const leadingWhitespace = value.slice(0, value.length - trimmedStart.length)
    let scalar = trimmedStart
    let comment = ''
    // Split trailing `# comment` only when `#` is preceded by whitespace and
    // followed by whitespace/end (YAML comment rule). This preserves `#1` as content.
    for (let idx = 0; idx < trimmedStart.length; idx += 1) {
      if (trimmedStart[idx] === '#') {
        const prev = idx === 0 ? ' ' : trimmedStart[idx - 1]
        const next = idx + 1 < trimmedStart.length ? trimmedStart[idx + 1] : ' '
        if (/\s/.test(prev) && /\s/.test(next)) {
          const commentStart = trimmedStart.slice(0, idx).trimEnd().length
          scalar = trimmedStart.slice(0, commentStart)
          comment = trimmedStart.slice(commentStart)
          break
        }
      }
    }
    scalar = scalar.trimEnd()
    if (scalar === '') {
      repairedLines.push(line)
      continue
    }
    const firstChar = scalar[0]
    if (firstChar === '|' || firstChar === '>') {
      blockScalarIndent = effectiveIndent
      repairedLines.push(line)
      continue
    }
    if (firstChar === "'" || firstChar === '"') {
      repairedLines.push(line)
      continue
    }
    let hasColonSeparator = false
    for (let i = 0; i < scalar.length - 1; i += 1) {
      if (scalar[i] === ':' && /\s/.test(scalar[i + 1])) {
        hasColonSeparator = true
        break
      }
    }
    let invalidFlowLike = false
    if ((firstChar === '[' || firstChar === '{' || firstChar === '@' || firstChar === '`')) {
      try {
        load(scalar)
      } catch {
        invalidFlowLike = true
      }
    }
    if (!hasColonSeparator && !invalidFlowLike) {
      repairedLines.push(line)
      continue
    }
    const quotedScalar = "'" + scalar.replace(/'/g, "''") + "'"
    repairedLines.push(key + ':' + leadingWhitespace + quotedScalar + comment)
    changed = true
  }
  return changed ? repairedLines.join('\n') : null
}

/** Try to repair a SKILL.md's frontmatter in place (unquoted colon etc.). Returns the new file text or null when not fixable. */
export function repairFrontmatterFileText(text: string): string | null {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n([\s\S]*))?$/.exec(text)
  if (match === null) return null
  const repaired = repairFrontmatterScalarFields(match[1])
  if (repaired === null) return null
  try {
    load(repaired)
  } catch {
    return null
  }
  const body = match[2] ?? ''
  return '---\n' + repaired + '\n---' + (body !== '' ? '\n' + body : '')
}

/**
 * 只改两个可调用性开关，其余一切原样保留：字段顺序、注释、空行、CRLF/LF、BOM、
 * 正文一个字节都不动。这里刻意不用 YAML stringify —— 那会重排字段、改引号、
 * 丢注释，用户会看到「我只改了一个开关，整份 skill 都被格式化了」。
 *
 * true = 删除对应键（解析器默认值就是可调用）；false = 写「禁用」键。
 */
export function setInvocationFlags(text: string, flags: { modelInvocable: boolean; userInvocable: boolean }): string {
  const bom = text.charCodeAt(0) === 0xfeff ? '\ufeff' : ''
  const raw = bom === '' ? text : text.slice(1)
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  // split 保留末尾的空串（文件以换行结束时），re-join 时会原样还回去。
  const lines = raw.split(/\r?\n/)

  const start = lines[0]?.trim() === '---' ? 0 : -1
  let end = -1
  if (start === 0) {
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i].trim() === '---') { end = i; break }
    }
  }

  const wanted: Array<{ key: string; value: string; enable: boolean }> = [
    { key: 'disable-model-invocation', value: 'true', enable: !flags.modelInvocable },
    { key: 'user-invocable', value: 'false', enable: !flags.userInvocable },
  ]

  let head: string[]
  let body: string[]
  let closing: string
  if (start === 0 && end > 0) {
    head = lines.slice(1, end)
    body = lines.slice(end + 1)
    closing = lines[end] // 原样保留结束行（可能有尾随空格）。
  } else {
    // 没有 frontmatter：补一个最小块。正文里若有顶层 description: 行，
    // 顺手带进 frontmatter 避免描述丢失；其余正文保持原样。
    head = []
    body = lines.slice()
    const descIndex = body.findIndex((line) => /^description[ \t]*:/.test(line))
    if (descIndex >= 0) head.push(body.splice(descIndex, 1)[0])
    closing = '---'
  }

  for (const item of wanted) {
    const re = new RegExp('^([ \\t]*)' + item.key.replace(/-/g, '\\-') + '([ \\t]*:).*$')
    const indexes: number[] = []
    head.forEach((line, i) => { if (re.test(line)) indexes.push(i) })
    if (item.enable) {
      if (indexes.length > 0) {
        const first = indexes[0]
        const indent = re.exec(head[first])?.[1] ?? ''
        head[first] = indent + item.key + ': ' + item.value
        for (const idx of indexes.slice(1).reverse()) head.splice(idx, 1)
      } else {
        head.push(item.key + ': ' + item.value)
      }
    } else {
      for (const idx of indexes.reverse()) head.splice(idx, 1)
    }
  }

  const result = [['---'], head, [closing], body].flat().join(eol)
  return bom + result
}

/** Official boolean grammar: true/false, 1/0, and the common string spellings. */
function frontmatterBoolean(data: Record<string, unknown>, key: string): boolean | undefined {
  if (!Object.hasOwn(data, key)) return undefined
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'true': case 'yes': case 'on': return true
      case 'false': case 'no': case 'off': return false
    }
  }
  throw new TypeError('frontmatter field "' + key + '" must be a boolean')
}
