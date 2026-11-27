/**
 * 原位写（open 'r+' + truncate + write）带同目录备份回滚。
 *
 * 为什么不用「临时文件 + rename」：rename 会把目标文件的创建时间（birthtime
 * / NTFS 的 file index）重置为当下，而面板把 birthtime 当「安装时间」展示。
 * 用户点一次「模型 / 用户」就把安装时间刷成「刚刚」是真实的数据损坏。
 * 原位写保留 ino 与 birthtime，只动 mtime/ctime。
 *
 * 写入流程：
 *  1. 读原文（UTF-8 字符串，调用方已经 parse 过，这里再读字节用于备份）；
 *  2. 同目录写 `<basename>.skill-shelf.bak`（覆盖式，写完 fsync 语义由 copyFile 提供）；
 *  3. 打开原文件 'r+' → ftruncate(0) → writeFile(next) → close；
 *  4. 任一步失败：用备份字节原位写回原文件，再删备份；
 *  5. 成功：删备份。
 *
 * 备份是暂存品，绝不作为恢复来源长期保留；真正的时间防线是持久化的
 * firstSeenAt（见 store），这里只保证「本次写入失败不留半截文件」。
 */
import { copyFile, open, readFile, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const BACKUP_SUFFIX = '.skill-shelf.bak'

/** 备份路径，导出便于测试断言与失败清理。 */
export function inPlaceBackupPath(path: string): string {
  return join(dirname(path), path.split(/[\\/]/).at(-1)! + BACKUP_SUFFIX)
}

/**
 * 原位写入 next 文本，失败时用写前备份回滚。
 * 保留文件的 birthtime / ino（不 rename、不 unlink）。
 */
export async function writeInPlaceWithBackup(path: string, next: string): Promise<void> {
  const backup = inPlaceBackupPath(path)
  let original: Buffer
  try {
    original = await readFile(path)
  } catch {
    // 读不到原文就没有回滚依据，绝不继续写（避免把不可读文件写成半截）。
    throw new Error('cannot read original for in-place write: ' + path)
  }

  let handleOpened = false
  try {
    await copyFile(path, backup)
    const handle = await open(path, 'r+')
    handleOpened = true
    try {
      await handle.truncate(0)
      await handle.writeFile(next, 'utf8')
    } finally {
      await handle.close()
      handleOpened = false
    }
    await rm(backup, { force: true })
  } catch (error) {
    // 回滚：把备份字节原位写回。回滚也用原位写，恢复 birthtime。
    try {
      const restore = await open(path, handleOpened ? 'r+' : 'w')
      try {
        await restore.truncate(0)
        await restore.writeFile(original)
      } finally {
        await restore.close()
      }
    } catch {
      // 回滚失败不吞掉原始错误；调用方会看到 409。
    }
    await rm(backup, { force: true }).catch(() => undefined)
    throw error
  }
}

/** 供回归测试读取 stat 快照（birthtimeMs / mtimeMs / ctimeMs / ino）。 */
export async function statSnapshot(path: string): Promise<{ birthtimeMs: number; mtimeMs: number; ctimeMs: number; ino: string }> {
  const s = await stat(path)
  return { birthtimeMs: s.birthtimeMs, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, ino: String(s.ino) }
}
