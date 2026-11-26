/**
 * 会话日志读取：多帧 zstd → JSON 事件。
 *
 * 解压本身复用 `counter/zstd-frames.ts`（整个插件只有一份帧切分实现，
 * 按帧头精确切分，不靠魔数搜索）。这里只负责「解压后怎么解析成事件」。
 *
 * @module evolution/session-log
 */
import { decompressZstdFrames } from '../counter/zstd-frames.ts'

/**
 * 解压一个多帧 zstd 缓冲区，返回全部解压文本。
 * @param buffer - 文件原始字节。
 * @returns 全部帧解压后的文本拼接。
 */
export function decompressAllFrames(buffer: Buffer): string {
  try {
    return decompressZstdFrames(buffer).toString('utf8')
  } catch {
    return ''
  }
}

/**
 * 把多帧 zstd 文本切成 JSON 事件。
 *
 * 每行一个事件；解析失败的行直接跳过（日志里偶尔有半行或版本差异）。
 * @param text - 解压后的文本。
 * @returns 事件对象数组。
 */
export function parseEvents(text: string): Array<{ type: string; data?: unknown }> {
  const out: Array<{ type: string; data?: unknown }> = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { type?: unknown }).type === 'string') {
        out.push(parsed as { type: string; data?: unknown })
      }
    } catch {
      // 跳过坏行。
    }
  }
  return out
}
