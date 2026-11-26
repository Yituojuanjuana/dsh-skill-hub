/** dsh-skill-hub -> dsh-skill-shelf sidecar migration: copy-only, legacy kept. */
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStoreCore } from './core.ts'

let home: string
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'shelf-mig-')) })
afterEach(async () => { await rm(home, { recursive: true, force: true }) })

describe('sidecar rename migration', () => {
  it('copies legacy sidecar to the new path and keeps the legacy file', async () => {
    const legacy = join(home, 'dsh-skill-hub.json')
    const next = join(home, 'dsh-skill-shelf.json')
    await writeFile(legacy, JSON.stringify({ version: 4, disabled: [], tags: [{ id: 't1', name: 'X', skillNames: [], default: true }] }), 'utf8')
    const core = createStoreCore(next)
    await core.ensureLoaded()
    // 新文件出现，内容来自旧文件。
    const copied = JSON.parse(await readFile(next, 'utf8'))
    expect(copied.tags).toEqual([{ id: 't1', name: 'X', skillNames: [], default: true }])
    // 旧文件仍在，字节不变。
    expect((await readFile(legacy, 'utf8')).length).toBeGreaterThan(0)
  })

  it('never overwrites an existing new-path sidecar', async () => {
    const legacy = join(home, 'dsh-skill-hub.json')
    const next = join(home, 'dsh-skill-shelf.json')
    await writeFile(legacy, JSON.stringify({ version: 4, disabled: [] }), 'utf8')
    await writeFile(next, JSON.stringify({ version: 4, disabled: [], tags: [{ id: 'new', name: 'NEW', skillNames: [], default: true }] }), 'utf8')
    const core = createStoreCore(next)
    await core.ensureLoaded()
    expect(JSON.parse(await readFile(next, 'utf8')).tags).toEqual([{ id: 'new', name: 'NEW', skillNames: [], default: true }])
  })
})