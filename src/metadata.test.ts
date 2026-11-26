/**
 * Plugin display metadata guard: the locale dictionaries, the icon and the
 * detail documents that dsh reads without activating the plugin. These files
 * are only reachable through the manifest's `exports`/`files`, so a rename or
 * a forgotten entry breaks the plugin page in the GUI with no type error.
 */
import { readFileSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const root = new URL('../', import.meta.url)
const readJson = (path: string): unknown => JSON.parse(readFileSync(new URL(path, root), 'utf8'))
const manifest = readJson('package.json') as {
  exports: Record<string, unknown>
  files: string[]
  engines: Record<string, string>
}

/** Every `locale/<language>.json` the manifest exports, keyed by language id. */
function locales(): Array<{ language: string; meta: Record<string, unknown> }> {
  return ['en', 'zh'].map((language) => {
    const file = readJson('locale/' + language + '.json') as { meta: Record<string, unknown> }
    return { language, meta: file.meta }
  })
}

describe('plugin display metadata', () => {
  it('exports the locale dictionaries and the icon', () => {
    expect(manifest.exports['./locale/*.json']).toBe('./locale/*.json')
    expect(manifest.exports['./icon']).toBe('./icon.svg')
  })

  it('ships the locales, icon and detail documents', () => {
    for (const entry of ['locale/*.json', 'icon.svg', 'DETAIL.md', 'DETAIL.zh.md', 'preview.svg']) {
      expect(manifest.files).toContain(entry)
    }
  })

  it('gives every locale a non-empty title and description', () => {
    for (const { language, meta } of locales()) {
      expect(typeof meta.title, language).toBe('string')
      expect((meta.title as string).trim(), language).not.toBe('')
      expect(typeof meta.description, language).toBe('string')
      expect((meta.description as string).trim(), language).not.toBe('')
    }
  })

  it('names a detail document that exists beside the package root', () => {
    for (const { language, meta } of locales()) {
      const detail = meta.detail as string
      expect(detail.endsWith('.md'), language).toBe(true)
      expect(detail.includes('\\'), language).toBe(false)
      expect(statSync(new URL(detail, root)).isFile(), language).toBe(true)
    }
  })

  it('points every detail document at the one feature image', () => {
    for (const { language, meta } of locales()) {
      const detail = readFileSync(new URL(meta.detail as string, root), 'utf8')
      const images = [...detail.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1])
      expect(images, language).toEqual(['preview.svg'])
      expect(statSync(new URL('preview.svg', root)).size, language).toBeGreaterThan(0)
    }
  })

  it('declares the dsh range the peer dependencies already express', () => {
    // `engines.dsh`, once present, alone decides compatibility, so it must stay
    // as wide as the peer ranges: a narrower floor would refuse older hosts.
    expect(manifest.engines.dsh).toBe('>=0.1.7-alpha.1 <0.3.0-0 || >=0.2.0-rc.1 <0.2.0 || >=0.2.1-alpha.2 <0.2.1 || >=0.2.2-alpha.2 <0.2.2 || >=0.2.3-alpha.2 <0.2.3')
  })
})
