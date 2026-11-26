/** Friendly labels for external discovery sources surfaced by skill providers. */
const SOURCE_LABELS: Readonly<Record<string, string>> = {
  'agent-ccswitch': 'CC Switch',
  'agent-workbuddy': 'WorkBuddy',
  'agent-trae-cn': 'Trae (国内版)',
  'agent-trae': 'Trae',
  'agent-codex': 'Codex',
  'agent-claude': 'Claude',
  'agent-cursor': 'Cursor',
  'agent-gemini': 'Gemini',
  'agent-copilot': 'Copilot',
  'agent-windsurf': 'Windsurf',
  'agent-qoder': 'Qoder',
  'agent-roo': 'Roo',
  'agent-opencode': 'OpenCode',
  'agent-goose': 'Goose',
  'agent-lingma': 'Lingma',
  'agent-openclaw': 'OpenClaw',
}

/** Turn an internal source id such as agent-ccswitch into a display label. */
export function sourceLabel(source: string): string {
  const known = SOURCE_LABELS[source]
  if (known !== undefined) return known
  if (source.startsWith('agent-')) {
    return source.slice('agent-'.length)
      .split('-')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ')
  }
  return source
}

/**
 * Labels for the "by location" view: the discovery root a skill was found in.
 * Local roots show the path shape users recognise; external agents reuse the
 * product name (`Codex`, `Claude`, …).
 */
const LOCATION_LABELS: Readonly<Record<string, string>> = {
  'user-dsh': 'DSH',
  'user-agents': '公共 Agent',
  bundled: '官方',
  'project-dsh': '项目 DSH',
  'project-agents': '项目 Agent',
}

export function locationLabel(source: string): string {
  return LOCATION_LABELS[source] ?? sourceLabel(source)
}
