/** JSON error body shared by every route. */
export interface ErrorResponse {
  error: string
}

/** The skill shelf's own runtime configuration, edited from the settings card. */
export interface HubConfig {
  /** Master switch: routes, provider, and announcement all go live with this. */
  enabled: boolean
  /** When true, a system-prompt section announces the hub to every agent. */
  announceToAgent: boolean
  /** Model-invocable dot color (#rrggbb); absent means the panel default. */
  dotModelColor?: string
  /** User-invocable dot color (#rrggbb); absent means the panel default. */
  dotUserColor?: string
  /** Show per-skill invocation count chip. Default true. */
  showUseCount?: boolean
  /** Show per-skill last-used relative time. Default true. */
  showUseTime?: boolean
  /** Show group-header usage summaries (count + last used). Default true. */
  showGroupSummary?: boolean
  /** 侧边栏是否显示「技能书架」入口卡片。Default true（保持现状）。 */
  showSidebarCard?: boolean
  evolution?: boolean
  /**
   * GitHub personal access token for market/source API calls (anonymous quota
   * is 60 req/h, authed 5000/hr). Stored in the local settings doc; absent
   * means anonymous. Never logged.
   */
  githubToken?: string
  /**
   * 技能进化：开启后对话结束会在后台复盘并提出技能建议。
   * 默认关闭：它会调模型，不能默认开。
   */
}

/**
 * HubConfig minus the GitHub token: the shape of every config payload that
 * leaves the host over HTTP. The token is write-only there — a response
 * pasted into an issue or a screenshot would otherwise hand the credential
 * over, so callers read `ConfigResponse.githubTokenSet` when they only need
 * to know whether one is in effect.
 */
export type RedactedHubConfig = Omit<HubConfig, 'githubToken'>

/**
 * The complete config field list, in the order the settings page renders them.
 * The host walks it for volatile refs and the sidecar migration walks it to
 * hydrate untrusted JSON. A second hand-written list in store/migrate.ts used
 * to know only 7 of these, silently dropping githubToken on every migration.
 */
export const CONFIG_FIELDS = [
  'enabled',
  'announceToAgent',
  'dotModelColor',
  'dotUserColor',
  'showUseCount',
  'showUseTime',
  'showGroupSummary',
  'showSidebarCard',
  'evolution',
  'githubToken',
] as const

export type ConfigField = typeof CONFIG_FIELDS[number]

/** Expected primitive for each field; used to validate untrusted sidecar JSON. */
export const CONFIG_FIELD_TYPES: Record<ConfigField, 'boolean' | 'string' | 'number'> = {
  enabled: 'boolean',
  announceToAgent: 'boolean',
  dotModelColor: 'string',
  dotUserColor: 'string',
  showUseCount: 'boolean',
  showUseTime: 'boolean',
  showGroupSummary: 'boolean',
  showSidebarCard: 'boolean',
  evolution: 'boolean',
  githubToken: 'string',
}

/**
 * The resolved shape of the hub's settings namespace (schema defaults, then
 * the composition base, then the user layer). Kept as a type alias so the
 * browser-side settings scope snapshot is index-compatible with the card
 * form's record shape.
 */
export type HubSettingsValue = {
  enabled: boolean
  announceToAgent: boolean
  showUseCount: boolean
  showUseTime: boolean
  showGroupSummary: boolean
  /** 侧边栏是否显示技能书架入口（默认 true）。 */
  showSidebarCard: boolean
  evolution: boolean
  /** 技能进化开关：开启后对话结束会在后台复盘。 */
  /** Model-invocable dot color (#rrggbb); absent means the panel default. */
  dotModelColor?: string
  /** User-invocable dot color (#rrggbb); absent means the panel default. */
  dotUserColor?: string
  /** GitHub token（明文存本地设置文档，仅经 dsh 的 /api 信任栅栏可读；缺省为匿名）。 */
  githubToken?: string
}

/**
 * This plugin's Loader entry id — the settings namespace dsh serves its config
 * under. It is cordis.patch.yml's insert id, NOT the package name, and it is
 * shared by contract because the browser half addresses the same form through
 * `ctx.configForms.get(HUB_ENTRY_ID)` while the host half writes through
 * `ctx.settings.update(HUB_ENTRY_ID, …)`.
 */
export const HUB_ENTRY_ID = 'skill-shelf'

/**
 * Hub config defaults — the single source every layer reads: the cordis
 * schema (index.ts), the host's saved-override merge, and the routes'
 * fallback view. Changing a default here changes all three.
 */
export const HUB_CONFIG_DEFAULTS = {
  enabled: true,
  announceToAgent: true,
  showUseCount: true,
  showUseTime: true,
  showGroupSummary: true,
  showSidebarCard: true,
  evolution: false,
} as const

/**
 * Fill a raw settings value into the effective hub config: schema defaults for
 * anything missing.
 *
 * There is deliberately no "saved sidecar layer" parameter. Until dsh 0.1.7 the
 * hub kept its own runtime overrides in the sidecar and merged them here; the
 * settings namespace is now the only user layer (`updateConfig` writes through
 * `ctx.settings.mutate`), so a merge against a sidecar layer could never
 * observe anything but `{}` — see the git history of `resolveHubConfig`.
 */
export function resolveHubConfig(base: Partial<HubConfig> = {}): HubConfig {
  return {
    enabled: base.enabled ?? HUB_CONFIG_DEFAULTS.enabled,
    announceToAgent: base.announceToAgent ?? HUB_CONFIG_DEFAULTS.announceToAgent,
    showUseCount: base.showUseCount ?? HUB_CONFIG_DEFAULTS.showUseCount,
    showUseTime: base.showUseTime ?? HUB_CONFIG_DEFAULTS.showUseTime,
    showGroupSummary: base.showGroupSummary ?? HUB_CONFIG_DEFAULTS.showGroupSummary,
    showSidebarCard: base.showSidebarCard ?? HUB_CONFIG_DEFAULTS.showSidebarCard,
    evolution: base.evolution ?? HUB_CONFIG_DEFAULTS.evolution,
    ...(base.dotModelColor !== undefined ? { dotModelColor: base.dotModelColor } : {}),
    ...(base.dotUserColor !== undefined ? { dotUserColor: base.dotUserColor } : {}),
    ...(base.githubToken !== undefined ? { githubToken: base.githubToken } : {}),
  }
}

/**
 * Drop the GitHub token from a config-shaped object. Returns a copy, so the
 * caller's own config layer keeps the token. Shared by the config route's GET
 * and POST responses — neither may echo it back.
 */
export function redactGithubToken<T extends { githubToken?: string }>(value: T): Omit<T, 'githubToken'> {
  const copy: Record<string, unknown> = { ...value }
  delete copy.githubToken
  return copy as Omit<T, 'githubToken'>
}

/** HEX color validation shared by host routes and the settings card. */
export const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i

/** GET /api/skill-shelf/config */
export interface ConfigResponse {
  ok: true
  /** 已安装插件自身的版本号（package.json version），设置卡标题旁显示。 */
  pluginVersion: string
  /** Effective configuration (saved overrides merged over the defaults), token stripped. */
  config: RedactedHubConfig
  /** Raw user overrides persisted in the sidecar (absent fields inherit defaults), token stripped. */
  saved: Partial<RedactedHubConfig>
  /** True when a GitHub token is in effect (saved override or the base/env layer). */
  githubTokenSet: boolean
}

/**
 * POST /api/skill-shelf/config — a partial patch; omitted fields keep their values.
 *
 * Only the fields the handler actually parses belong here; the settings
 * namespace owns the rest of {@link HubSettingsValue}, not this route.
 */
export interface ConfigRequest {
  /** Set the field; null clears the saved override so it re-inherits the default. */
  enabled?: boolean | null
  /** Set the field; null clears the saved override so it re-inherits the default. */
  announceToAgent?: boolean | null
  /** Set the field; null clears the saved override so it re-inherits the default. */
  showUseCount?: boolean | null
  /** Set the field; null clears the saved override so it re-inherits the default. */
  showUseTime?: boolean | null
  /** Set the field; null clears the saved override so it re-inherits the default. */
  showGroupSummary?: boolean | null
  /** Set the field; null clears the saved override so it re-inherits the default. */
  showSidebarCard?: boolean | null
  evolution?: boolean | null
  /** Set the dot color; null clears the saved override so it re-inherits the default. */
  dotModelColor?: string | null
  /** Set the dot color; null clears the saved override so it re-inherits the default. */
  dotUserColor?: string | null
  /** Set the GitHub token; null/empty clears it back to anonymous. */
  githubToken?: string | null
}

/** GitHub token validation shared by host routes and the settings card. */
export const GITHUB_TOKEN_RE = /^[A-Za-z0-9_\-]{8,255}$/
