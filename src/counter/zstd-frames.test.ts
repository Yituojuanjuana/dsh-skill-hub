import { describe, it, expect } from 'vitest'
import { zstdCompressSync } from 'node:zlib'
import { decompressZstdFrames, zstdFrameOffsets } from './zstd-frames.ts'

describe('multi-frame zstd', () => {
  it('concatenates every frame, not just the first', () => {
    // 会话日志正是逐帧追加的：每批事件一帧。
    const frames = ['alpha', 'beta', 'gamma'].map((s) => zstdCompressSync(Buffer.from(s, 'utf8')))
    const joined = Buffer.concat(frames)
    expect(zstdFrameOffsets(joined)).toHaveLength(3)
    expect(decompressZstdFrames(joined).toString('utf8')).toBe('alphabetagamma')
  })

  it('handles a single-frame buffer', () => {
    const one = zstdCompressSync(Buffer.from('solo', 'utf8'))
    expect(decompressZstdFrames(one).toString('utf8')).toBe('solo')
  })

  it('skips a corrupt frame but keeps the healthy ones', () => {
    const good1 = zstdCompressSync(Buffer.from('first', 'utf8'))
    const good2 = zstdCompressSync(Buffer.from('last', 'utf8'))
    const corrupt = Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.alloc(8, 0)])
    const out = decompressZstdFrames(Buffer.concat([good1, corrupt, good2])).toString('utf8')
    expect(out).toBe('firstlast')
  })
})
