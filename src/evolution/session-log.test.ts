/**
 * 多帧 zstd 解压：会话日志每个事件一帧，必须全部解出。
 *
 * 这是「暂无提案」的根因所在 —— `zstdDecompressSync` 只解第一帧（header），
 * 于是引擎只看到 0~24 条消息。用真实多帧数据锁住这个行为。
 */
import { describe, expect, it } from 'vitest'
import { zstdCompressSync } from 'node:zlib'
import { decompressAllFrames, parseEvents } from './session-log.ts'
import { zstdFrameLength } from '../counter/zstd-frames.ts'

/** 把若干文本片段各自压成一个独立帧，拼成「多帧文件」。 */
function multiFrame(payloads: readonly string[]): Buffer {
  return Buffer.concat(payloads.map((text) => zstdCompressSync(Buffer.from(text, 'utf8'))))
}

describe('zstdFrameLength', () => {
  it('reports the exact byte length of one frame', () => {
    const one = zstdCompressSync(Buffer.from('hello world', 'utf8'))
    expect(zstdFrameLength(one, 0)).toBe(one.length)
  })

  it('returns 0 for a non-frame offset', () => {
    expect(zstdFrameLength(Buffer.from('not zstd'), 0)).toBe(0)
  })

  it('finds each frame boundary in a multi-frame buffer', () => {
    const frames = ['{"type":"session"}', '{"type":"user/message"}', '{"type":"assistant/message"}']
    const buf = multiFrame(frames)
    const lengths: number[] = []
    let offset = 0
    while (offset < buf.length) {
      const length = zstdFrameLength(buf, offset)
      expect(length).toBeGreaterThan(0)
      lengths.push(length)
      offset += length
    }
    // 必须正好切完，不多不少。
    expect(lengths).toHaveLength(frames.length)
    expect(offset).toBe(buf.length)
  })
})

describe('decompressAllFrames', () => {
  it('decodes every frame, not just the first', () => {
    const frames = ['{"type":"session"}', '{"type":"a"}', '{"type":"b"}', '{"type":"c"}']
    const buf = multiFrame(frames)
    const text = decompressAllFrames(buf)
    // 这是核心断言：四帧的内容都要在，只解第一帧时这里只有 'session'。
    expect(text).toContain('"session"')
    expect(text).toContain('"a"')
    expect(text).toContain('"b"')
    expect(text).toContain('"c"')
  })

  it('still works for a single-frame buffer', () => {
    const one = zstdCompressSync(Buffer.from('single frame body', 'utf8'))
    expect(decompressAllFrames(one)).toBe('single frame body')
  })

  it('skips a corrupt frame without losing the rest', () => {
    const good1 = zstdCompressSync(Buffer.from('first ', 'utf8'))
    const good2 = zstdCompressSync(Buffer.from('third', 'utf8'))
    const corrupt = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0xff, 0xff, 0xff])
    const text = decompressAllFrames(Buffer.concat([good1, corrupt, good2]))
    expect(text).toContain('first')
    expect(text).toContain('third')
  })

  it('returns empty string for unreadable bytes', () => {
    expect(decompressAllFrames(Buffer.from([0, 1, 2, 3]))).toBe('')
  })
})

describe('parseEvents', () => {
  it('parses newline-delimited events across frames', () => {
    const buf = multiFrame([
      '{"type":"session","id":"s1"}\n',
      '{"type":"user/message","data":{}}\n',
      '{"type":"assistant/message","data":{}}\n',
    ])
    const events = parseEvents(decompressAllFrames(buf))
    expect(events.map((event) => event.type)).toEqual(['session', 'user/message', 'assistant/message'])
  })

  it('skips malformed lines instead of throwing', () => {
    const events = parseEvents('{"type":"a"}\nnot json\n{"type":"b"}\n')
    expect(events.map((event) => event.type)).toEqual(['a', 'b'])
  })

  it('ignores objects without a string type', () => {
    expect(parseEvents('{"foo":1}\n{"type":2}\n')).toEqual([])
  })
})
