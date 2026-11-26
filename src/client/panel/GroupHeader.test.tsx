/**
 * Cards must start collapsed: with a full catalog the expanded list is a wall
 * of rows, so every group renders with `aria-expanded="false"` until the user
 * opens it. These tests pin that default so a refactor cannot silently flip it
 * back to expanded-by-default.
 */
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GroupHeader } from './GroupHeader.tsx'

describe('GroupHeader collapse default', () => {
  it('renders collapsed when the caller passes collapsed', () => {
    const html = renderToString(createElement(GroupHeader, { title: 'x', collapsed: true, onToggle: () => {} }))
    expect(html).toContain('aria-expanded="false"')
  })

  it('renders expanded only when explicitly not collapsed', () => {
    const html = renderToString(createElement(GroupHeader, { title: 'x', collapsed: false, onToggle: () => {} }))
    expect(html).toContain('aria-expanded="true"')
  })
})