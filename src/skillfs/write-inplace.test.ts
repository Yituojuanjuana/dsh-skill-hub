import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { inPlaceBackupPath, statSnapshot, writeInPlaceWithBackup } from './write-inplace.ts'
import { setInvocationFlags } from './frontmatter.ts'

describe('原位写保留 birthtime / ino', () => {
  let dir: string
  let file: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-inplace-'))
    file = join(dir, 'SKILL.md')
    await writeFile(file, '---\nname: demo\ndescription: d\n---\nbody\n', 'utf8')
  })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('写入后 birthtime / ino 不变，只有 mtime 前进', async () => {
    const before = await statSnapshot(file)
    const original = await readFile(file, 'utf8')
    await writeInPlaceWithBackup(file, setInvocationFlags(original, { modelInvocable: true, userInvocable: false }))
    const after = await statSnapshot(file)
    expect(after.birthtimeMs).toBe(before.birthtimeMs)
    expect(after.ino).toBe(before.ino)
    expect(after.mtimeMs).toBeGreaterThanOrEqual(before.mtimeMs)
    expect(await readFile(file, 'utf8')).toContain('user-invocable: false')
    // 备份是暂存的，成功写完必须删掉。
    await expect(readFile(inPlaceBackupPath(file), 'utf8')).rejects.toThrow()
  })

  it('对比：rename 原子写会重置 birthtime 与 ino（复现证据）', async () => {
    const { rename, writeFile } = await import('node:fs/promises')
    const before = await statSnapshot(file)
    const tmp = file + '.tmp'
    const original = await readFile(file, 'utf8')
    await writeFile(tmp, setInvocationFlags(original, { modelInvocable: true, userInvocable: false }), 'utf8')
    await rename(tmp, file)
    const after = await statSnapshot(file)
    expect(after.birthtimeMs).not.toBe(before.birthtimeMs)
    expect(after.ino).not.toBe(before.ino)
  })

  it('写入失败时从备份回滚，内容不变', async () => {
    const original = await readFile(file, 'utf8')
    // 制造写入失败：把路径变成目录，open('r+') 会失败 —— 但 copyFile 先失败。
    const failing = join(dir, 'no-such-dir', 'SKILL.md')
    await expect(writeInPlaceWithBackup(failing, 'x')).rejects.toThrow()
    expect(await readFile(file, 'utf8')).toBe(original)
  })
})
