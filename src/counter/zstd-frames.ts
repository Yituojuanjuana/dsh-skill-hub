/**
 * 多帧 zstd 解压。
 *
 * 会话日志是**逐帧追加**的 zstd 文件：每个事件批次一帧，一个文件里能有几千帧
 * （实测最大 11.7 MB → 7183 帧 → 解压后 47 MB）。
 *
 * Node 的 `zstdDecompressSync` 是否顺带解后续帧取决于 Node 版本（24.15 只解
 * 第一帧），`createZstdDecompress` 流式接口同样只吐第一帧。靠它们会把历史数据
 * 静默丢掉绝大部分。
 *
 * 切分方式必须是**解析帧头**而不是搜索魔数：`28 B5 2F FD` 会出现在压缩数据
 * 内部，按魔数切会产生假边界、把帧切成碎片。解析 FrameHeaderDescriptor 与
 * block 头算出的帧长度是精确的 —— 实测切分后剩余字节为 0。
 */
import { zstdDecompressSync } from 'node:zlib'

/** zstd 帧魔数（小端）。 */
const ZSTD_MAGIC = 0xfd2fb528

/**
 * 解析一个 zstd 帧的完整字节长度。
 *
 * 帧格式（RFC 8878）：
 *   Magic(4) FrameHeaderDescriptor(1) [WindowDescriptor] [DictionaryID]
 *   [FrameContentSize] Block* [Checksum(4)]
 *
 * @param buffer - 包含该帧的缓冲区。
 * @param start - 帧起始偏移。
 * @returns 帧总字节数；该偏移不是合法帧则返回 0。
 */
export function zstdFrameLength(buffer: Buffer, start: number): number {
  if (start + 5 > buffer.length) return 0
  if (buffer.readUInt32LE(start) !== ZSTD_MAGIC) return 0

  const descriptor = buffer[start + 4]!
  const contentSizeFlag = descriptor >> 6
  const singleSegment = (descriptor >> 5) & 1
  const hasChecksum = (descriptor >> 2) & 1
  const dictIdFlag = descriptor & 3

  let offset = start + 5
  if (singleSegment === 0) offset += 1
  offset += dictIdFlag === 3 ? 4 : dictIdFlag
  offset += contentSizeFlag === 0 ? (singleSegment === 1 ? 1 : 0) : [0, 2, 4, 8][contentSizeFlag]!

  for (;;) {
    if (offset + 3 > buffer.length) return 0
    const header = buffer[offset]! | (buffer[offset + 1]! << 8) | (buffer[offset + 2]! << 16)
    const last = header & 1
    const type = (header >> 1) & 3
    const size = header >> 3
    // type 1 = RLE：只跟 1 字节；其余类型跟 size 字节。
    offset += 3 + (type === 1 ? 1 : size)
    if (last === 1) break
  }
  if (hasChecksum === 1) offset += 4
  return offset > buffer.length ? 0 : offset - start
}

/** 找出每个 zstd 帧的起始偏移（按帧头精确切分，失败时回退魔数扫描）。 */
export function zstdFrameOffsets(buffer: Buffer): number[] {
  const offsets: number[] = []
  let offset = 0
  while (offset < buffer.length) {
    const length = zstdFrameLength(buffer, offset)
    if (length === 0) {
      const next = nextMagic(buffer, offset + 1)
      if (next === -1) break
      offset = next
      continue
    }
    offsets.push(offset)
    offset += length
  }
  // 一帧都解析不出来时退回魔数扫描（容忍异常文件）。
  if (offsets.length === 0) {
    let index = buffer.indexOf(ZSTD_MAGIC_BUFFER, 0)
    while (index !== -1) {
      offsets.push(index)
      index = buffer.indexOf(ZSTD_MAGIC_BUFFER, index + 4)
    }
  }
  return offsets
}

/** 魔数字节串，供回退扫描用。 */
const ZSTD_MAGIC_BUFFER = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 从 from 开始找下一个魔数；找不到返回 -1。 */
function nextMagic(buffer: Buffer, from: number): number {
  for (let index = from; index + 4 <= buffer.length; index += 1) {
    if (buffer.readUInt32LE(index) === ZSTD_MAGIC) return index
  }
  return -1
}

/**
 * 解压一个多帧 zstd buffer。
 *
 * 某一帧损坏时跳过该帧继续，尽量多捞回历史数据。
 * @param buffer - 文件原始字节。
 * @returns 全部帧解压后的内容。
 */
export function decompressZstdFrames(buffer: Buffer): Buffer {
  const offsets = zstdFrameOffsets(buffer)
  // 没有帧魔数（或调用方给的就是单帧），直接交给 zlib。
  if (offsets.length <= 1) return zstdDecompressSync(buffer)
  const parts: Buffer[] = []
  for (let i = 0; i < offsets.length; i += 1) {
    const start = offsets[i]!
    const end = i + 1 < offsets.length ? offsets[i + 1]! : buffer.length
    try {
      parts.push(zstdDecompressSync(buffer.subarray(start, end)))
    } catch { /* 单帧损坏不影响其余帧 */ }
  }
  return Buffer.concat(parts)
}
