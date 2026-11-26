# dsh-skill-shelf

[English](README.md) | [中文版](README.zh.md)

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-skill-shelf"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-skill-shelf?color=2f81f7&label=npm"></a>
  <img alt="downloads" src="https://img.shields.io/npm/dm/dsh-skill-shelf">
  <img alt="license" src="https://img.shields.io/npm/l/dsh-skill-shelf">
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D22.19-339933">
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/cheshireez/dsh-skill-shelf/main/promo/real-skill-hub.png" alt="dsh-skill-shelf 面板" width="640">
</p>

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的技能书架 —— 在 Web GUI 里浏览与治理 `ctx.skills` 全量目录：按目录 / 角色 / 工作区分组或平铺查看，日 / 周 / 总调用量与成功率来自本地台账，导入前做内容审计，来源可同步并检测本地改动，移除进可恢复回收站，诊断可定位并修复加载问题，技能进化提案经人工审核后落地到项目工作区。

> 宿主只用官方 SDK，浏览器通过官方槽位渲染，不改 dsh 源码。

## 快速开始

```bash
dsh plugin --profile web add dsh-skill-shelf
# 重启 dsh web → 设置 → 技能书架 → 市场 → 扫描 → 导入
```

要求 `Node ^22.19 || >=24` + dsh web `>=0.1.7-alpha.1 <0.3`。dsh `0.2.2` 起要求 `Node >=24.9`。

两个界面 —— 管理面板在 **设置 → 技能书架**；本插件自身的配置卡片在 **插件管理页** 的插件自有页面上（侧边栏「插件」→ dsh-skill-shelf）。该卡片由本插件自己注册进 `plugins.bundle.config` 槽位（dsh 没有自动生成的配置页），覆盖总开关、向 Agent 公告、圆点颜色、GitHub Token 与显示哪些调用统计。

## 功能

**设置 → 技能书架** — 4 个 tab：**通用**（全部/按来源/按目录/按角色）、**工作区**（指定工作区的项目级技能）、**市场**（安装与更新）、**回收站**（可恢复的已移除技能）。

同一个面板也提供 **960px 宽屏侧栏入口**（左侧栏「插件」区域 → 技能书架），浏览技能不必离开对话。

- **浏览** — `ctx.skills` 注册表全量：项目/用户/内置+第三方。按名称、描述、`displayName` 搜索；按来源、状态（已启用/已停用）、调用方式（模型/用户）筛选；按调用次数（默认）/名称/添加时间排序。每行都有 `⋯` 菜单（详情/启停/删除），操作不再依赖编辑模式。不同来源的同名技能挂重名徽标，不再静默隐藏。
- **内容审计** — 已启用技能的正文（`SKILL.md`）也体检：裸 ESC 控制字符、Unicode 标签字符、双向控制符，以及编码伪装（文本文件里出现 NUL 字节 / UTF-16 / 非法 UTF-8）—— 这些会让「看过」不等于「看见」，市场导入时直接拒绝落盘；另有零宽字符、`curl … | sh` 式远程执行、SSH/云凭据/钥匙串路径、超长 description，以及单文件 2 MiB / 单技能 10 MiB / 500 文件上限。只有「没有正当用途」的特征才阻断安装，其余为警告，交给人判断。规则是纯本地静态匹配，不跑模型、不出网。市场导入会扫整包（含 `scripts/`），常驻体检只扫 `SKILL.md`（每 5 秒轮询，扫全目录会拖慢面板）。
- **公告预算** — 一层渐进加载注入的 name + description 总量随目录一起返回，面板显示字符数与 token 估算；超过 8000 字符变红提示（超出后客户端会截断尾部条目，表现为「装了却不触发」）。
- **开关** — 单技能开关 + 整组三态开关，跨组冲突弹窗（全部关闭/保留开启）。停用只写 sidecar 策略：发现文件不改名、不删除，由 invocation override 关闭模型自动调用（「/技能名」仍可用）；停用的技能仍留在目录里、可查看正文、可一键重新启用，编辑模式下也可直接移入回收站。仅 `~/.dsh/skills` 与 `~/.agents/skills` 可写，其余只读。
- **整理** — 三个正交维度：**来源**（技能从哪个上游仓库装来）、**位置**（发现目录，如 `~/.dsh/skills` / `Codex`）、**角色**（用户手工编组的技能集合）。来源集合自动聚合；位置由「按目录」视图呈现，每个发现根一张卡、可整目录启停（同一技能在多个根被发现时，归属取注册表胜出者，与行徽标一致）；角色手工维护、可拖拽排序，并支持**切换角色** —— 启用成员、停用其余可切换技能（弹窗里可逐个勾选保留，默认全停用），切换前状态自动留存、可一键还原。未编入任何角色的技能仍可从折叠的「未编入角色」卡片找到。角色视图始终展示完整名单，不受来源/状态筛选影响（搜索与调用方式仍然生效）。角色与来源集合持久化到 `~/.dsh/dsh-skill-shelf.json`，还原快照存在浏览器 localStorage。编辑模式收敛删除/排序控件，阅读视图保持干净。
- **诊断与修复** — provider 跳过的文件给出原因（缺 frontmatter、YAML 非法、名称不一致、描述过短）；每条按「异常」（文件被跳过、技能不会出现在列表里）/「提醒」（技能能加载但有问题）分级标记，标题显示总数与分级计数，异常条标红；可自动修复的（如描述里未加引号的 `:`）一键 Fix 落盘。
- **新建** — 新技能向导，写入 `~/.dsh/skills` 或 `~/.agents/skills`（`SKILL.md` 模板见下）。
- **市场** — 内置精选仓库 + 自定义 `owner/repo`。任何含 `SKILL.md` 的顶层目录都可扫描（无白名单）；`SKILL.md` 直接放在仓库根时，整个仓库算一个技能，技能名取仓库名（`.github/` 等仓库基建不计入）。异步导入，字节级进度+取消。每个源钉一个版本 —— 点 ref 徽标可在发布版/分支/手输之间切换。导入前先过内容审计，命中阻断级规则的技能整包拒绝，临时目录一并清掉（磁盘不留痕）。
- **skills.sh 搜索** — 在内置目录之外按技能名搜索 [skills.sh](https://skills.sh) 索引，结果显示仓库与安装次数，每行两个动作：**安装**直装这一个技能（一步到位，但**不跟踪上游更新** —— 上游只给技能目录名、不给它在仓库里的路径，登记不了来源）；**加为源**把仓库登记为市场源并立即扫描，之后的更新跟踪、版本钉选、回收站与手工添加的源完全一致。两条路都过同一套内容审计。请求走服务端代理（上游没有 CORS 头，也不该把用户出口 IP 交给第三方），`source` 与包内路径都在服务端按严格形态校验后才使用。
- **跟踪更新** — 导入的技能记录 repo+commit 快照。检查全部/一键全更（同时覆盖新发布与技能更新）；每源徽章（已装/可更新/上游已删/新版本）。有新发布时点「更新」会**先把钉版推到该发布再同步**（想留在旧版就点版本徽章手动钉住）。同步弹窗默认只勾选上游实际变化的技能，本地改过的技能会标出并提示覆盖；上游删除跟进移入回收站，恢复保留来源与角色归属。
- **本地改动检测** — 落盘后立刻采集整个技能的内容哈希（路径+大小+内容），检查时与记录比对：不一致的技能挂「本地改动 N 个」徽章，同步确认弹窗里逐个标出会被覆盖的那几个。旧记录没有哈希时按「未知」处理，不误报。
- **从其他 Agent 导入** — 只读扫描 Claude Code / Codex / WorkBuddy / Cursor / Gemini CLI / Copilot / OpenCode / Goose 的技能目录，两层：**用户级**（`~/.claude/skills` 等）收进 `~/.dsh/skills`，**项目级**（`<projectRoot>/.claude/skills` 等，项目根从已登记工作区推出）收进该项目的 `.dsh/skills`。原目录不受影响；扁平技能统一落成目录包；同样过内容审计与体积上限。多个 agent 目录软链到同一份文件（cc-switch 式集中管理）时按真实路径合并成一条，并标出「也在」哪些 agent；WorkBuddy 的 `workbuddy.json` 或 `SKILL.md` frontmatter 里的展示名/简介会映射到本插件的展示名与短描述，`_skillhub_meta.json` 里指向原安装目录的绝对路径与外链在副本中剥掉。
- **项目技能开关** — 项目技能可以停用，方式是**模型调用覆盖**（invocation override）：hub 在每个 agent 的技能层里再注册一次自己的 provider，用同名条目把宿主原生条目盖掉，把该技能的 `modelInvocable` 压成 false —— 模型不再自动调用，「/技能名」手动调用保留，**项目文件一个字节都不动**（git 仓库零污染）。停用状态存在 hub 的 sidecar 里，开关即写即生效；再点一次恢复。
- **从 ZIP 导入** — 选一个 `.zip`：包内每个含 `SKILL.md` 的目录算一个技能，整包是一个技能还是技能集合都支持，逐个独立成败、逐个过内容审计。解压前先拦路径穿越、符号链接、加密包、ZIP64 与解压炸弹；落盘走临时目录 + 原子改名，失败不留半成品；同名已启用的跳过，只有禁用占位或空壳才移入回收站让位（可恢复）。
- **技能进化**（默认关闭）— 一轮对话结束后开始计空闲；闲置 20 秒后，hub 把这段对话里的用户 / 助手 / 工具消息重放一遍，走**一次无工具的一次性模型调用**，问它里面有没有值得复用的经验。回来的建议要先过一道硬门槛才入队：kebab-case 名、描述/正文/理由非空、置信度 ≥ 0.6、`create` 不能撞已有名字、`update` 必须指向已有技能。每条建议都带它涉及技能的**真实台账调用数**（当日 / 本周 / 累计）——「这个值得做成技能」因此有证据，而不是模型的看法。建议只排队，**采纳是一次点击**；只有 `create` 能一键采纳（改进已有技能要并进人写的文件里，那一步永远不替你做）。复盘发生在对话之外：不占轮次、不带工具、不动 prompt cache，任何失败都降级成「这一轮什么也没学到」。
- **调用统计** — 一个只追加的本地台账（`~/.dsh/skill-usage-manager/usage-ledger.jsonl`）记下每次技能调用，按当日 / 本周 / 累计三档汇总，分组头同样汇总；台账独立于会话日志，**删掉会话也不丢**，插件启动时从会话日志回填历史。显示哪些档位、最近调用时间在设置卡片里实时可调。
- **设置卡片** — 注册在 **插件管理页** 的插件自有页面上（侧边栏「插件」→ dsh-skill-shelf，默认折叠，点标题展开）：总开关、向 Agent 公告、调用圆点颜色、GitHub Token、调用统计显示开关。标题行的版本徽标旁会提示新版本（**检查更新** 以 npm registry 的 `latest` 为准 —— 也就是 `dsh plugin add` 实际会装到的版本；GitHub release 仅作兜底，结果缓存 10 分钟），旁边带一个**立即更新**按钮：装在 profile 里的拷贝可以直接点它升级，装好后提示重启生效；被 `link:` 到开发目录的拷贝会被明确拒绝（那份换了会断开开发流程），Electron 独占的 profile 则由宿主自己拒绝。

## 内容审计与公告预算

| 能力 | 说明 |
| --- | --- |
| 内容审计 | 裸 ESC / Unicode 标签字符 / 双向控制符 / 零宽字符 / `curl … \| sh` / SSH 与云凭据路径 / 单文件 2 MiB、单技能 10 MiB、500 文件上限。阻断级（拒绝落盘，市场导入整包拒绝并清掉临时目录）：裸 ESC / Unicode 标签字符 / 双向控制符 / 编码伪装 / 体积上限。警告级（只标记、不阻断，这些有正当用途）：零宽字符、`curl … \| sh` / 凭据路径 / 超长 description。纯本地静态匹配，不出网、不跑模型。 |
| 公告预算 | 一层渐进加载注入的 name + description 总量随目录一起返回，面板显示字符数与 token 估算，超 8000 字符变红 —— 客户端会截断尾部条目，表现为「装了却不触发」。 |
| 插件公告 | 「向 Agent 公告」开启时，往系统提示注入一段 **340 字符**的中文路由说明（管理主页位置、能力概览、可写范围与 sidecar 开关规则、触发词）。**只发中文**：英文段曾是它的逐句翻译，属纯冗余 —— 双语合计 5023 字符、占整个 System Prompt 的 46.8%（issue #23）。 |

`SKILL.md` 模板：

```markdown
---
name: my-skill
description: 一句话说明何时使用。
---
# my-skill
正文...
```

## 工作原理

```text
GitHub 仓库 ──扫描/导入──▶ ~/.dsh/skills
     ▲                        │
     └─检查/同步/删除── ctx.skills ◀─ provider
                              │ snapshot/get
                              ▼
                  /api/skill-shelf/* ──▶ 面板（设置 → 技能书架）
```

宿主仅用 `ctx.skills.snapshot/get`、`ctx.webServer.register`、`ctx.systemPrompt.section`。路由走 dsh 自身的 `/api` 信任栅栏（回环 / 监听器绑定地址 / `--trusted-host`），JSON；**写接口（POST）另要求 `x-dsh-skill-shelf: 1` 头** —— 跨站页面伪造不出自定义头，同源请求不触发预检所以不增加往返。provider 注册在全局技能层，并在每个 live agent 的技能层再注册一次（比 preset 层更近），使模型调用覆盖能盖过宿主原生条目。

## HTTP API

| 端点 | 方法 | 用途 |
| --- | --- | --- |
| `/api/skill-shelf/catalog?cwd=` | GET | 技能+禁用+诊断+重名 |
| `/api/skill-shelf/skill?name=&cwd=` | GET | 技能正文（禁用的也可） |
| `/api/skill-shelf/skill/delete` | POST | 移入回收站（快照来源+角色） |
| `/api/skill-shelf/toggle` | POST | `{name, enabled}` |
| `/api/skill-shelf/toggle-batch` | POST | `{names, enabled}` |
| `/api/skill-shelf/create` | POST | `{name, description?, root?}` |
| `/api/skill-shelf/diagnostic/fix` | POST | `{path}` 自动修 frontmatter |
| `/api/skill-shelf/permanent-stats` | GET | 台账聚合的当日 / 本周 / 累计调用次数 |
| `/api/skill-shelf/evolution` | GET | 待审技能建议、已处理记录、复盘运行 |
| `/api/skill-shelf/evolution/adopt` | POST | `{id, root?}` 把一条 `create` 建议写成真实技能 |
| `/api/skill-shelf/evolution/dismiss` | POST | `{id}` 丢弃一条建议 |
| `/api/skill-shelf/evolution/run` | POST | `{sessionId?}` 立刻复盘一次（忽略冷却） |
| `/api/skill-shelf/config` | GET/POST | 运行时配置（`null` 清除） |
| `/api/skill-shelf/groups` | GET | tags+集合+排序 |
| `/api/skill-shelf/tag` 等 | POST | 新建/重命名、删除、设成员、排序 |
| `/api/skill-shelf/market` 等 | GET/POST | 市场源 列表/添加/删除/钉 ref；`…/source/check` + `…/source/sync` 检查与同步 |
| `/api/skill-shelf/market/source/versions?repo=` | GET | 版本选择器的 releases+branches |
| `/api/skill-shelf/market/skills-sh?q=` | GET | skills.sh 索引搜索（服务端代理，≥2 字符；结果已校验为严格 `owner/repo`） |
| `/api/skill-shelf/market/skills-sh/install` | POST | `{source, skillId}` 直装单个技能（不登记来源，故不跟踪更新） |
| `/api/skill-shelf/repo?repo=` | GET | 发现（任意根） |
| `/api/skill-shelf/repo/import` | POST | 异步任务 `{jobId, total, totalBytes}` |
| `/api/skill-shelf/repo/import/progress?jobId=` | GET | 轮询进度 |
| `/api/skill-shelf/repo/import/cancel` | POST | 取消任务 |
| `/api/skill-shelf/sources` 等 | GET/POST | 来源 列表/检查/同步/删除/恢复/清空回收站 |
| `/api/skill-shelf/foreign` | GET | 其他 agent 技能目录的只读扫描（用户级 + 项目级；项目根从已登记工作区推） |
| `/api/skill-shelf/foreign/import` | POST | `{items:[{agent,name,scope?,projectRoot?}]}` 收编到 `~/.dsh/skills`（用户级）或该项目的 `.dsh/skills`（项目级） |
| `/api/skill-shelf/import/zip` | POST | 原始 `.zip` 字节（`content-type: application/zip`，≤32 MiB）；包内每个含 `SKILL.md` 的目录作为一个技能，逐个审计后落盘 |
| `/api/skill-shelf/update` | GET | 插件最新发布（`?refresh=1` 绕过 10 分钟缓存） |
| `/api/skill-shelf/update/apply` | POST | `{version}` 把该版本装进当前 profile；`link:` 安装与 Electron 独占的 profile 会被拒绝（原因在 `error`，HTTP 仍是 200） |
| 未知的 `/api/skill-shelf/*` | GET/POST | `404 {error}` 且写明路径 —— 拼错路径不该被读成鉴权失败（宿主 SPA fallback 对自己不拥有的 `/api/*` 一律回 401） |

## 开发

```bash
npm run typecheck  # tsc --noEmit
npm test           # 576 tests, 41 suites
npm run build      # tsc + tsdown → lib/index.js + lib/client.js
```

**插件管理页** 的展示元数据与代码一起发布，读取时不需要启用插件：`locale/en.json` + `locale/zh.json`（`meta.title` / `meta.description` / `meta.detail`）、`icon.svg`，以及只含一张图的详情文档 `DETAIL.md` / `DETAIL.zh.md` 与 `preview.svg`。`engines.dsh` 故意写得与 peer 范围一样宽 —— 一旦声明就由它单独判定兼容性，下限收窄会拒绝今天还能用的宿主。`market/index.json` 是社区索引用的 format-1 条目，发版时同步更新其中的 `version` 与 `publishTimestamp`。

> 同一 `$DSH_HOME` + cwd 下勿开两个 `dsh web` — 无会话日志锁，会 `seq gap` 损坏。换 `DSH_HOME` 或先关旧实例。

## 故障排查

- `duplicate loader entry id: skill-hub` — 删掉重复安装（只留一种 `dsh plugin add`）。
- 技能不出现 — 看诊断区（缺 frontmatter / 名称不一致 / 描述过短 / 两种发现形态抢同一个名字：`<name>/SKILL.md` 目录包与 `<name>.md` 扁平文件可以并存，注册表只会留一个）。
- 来源组空壳 — 组内技能已被删除、或停用记录丢失（状态文件被恢复/手改）。启动时先把遗留的 `.disabled` 文件迁移成策略覆盖，再对账记录、**清掉文件已不存在的死记录**；无可见成员的来源组不再渲染。
- 技能建不出来 / 一直显示「已停用」— 停用记录指向的文件已经不在了。启动时会清掉这条死记录、把名字释放出来；点「启用」也只是清掉策略覆盖与记录，不再去找文件。
- `/` 菜单圆点消失 — dsh 内部触发源变更，目录功能不受影响。
- 找不到配置卡片 — 在插件管理页打开本插件（侧边栏「插件」→ dsh-skill-shelf），展开页面顶部的「技能书架」卡片（默认折叠）。dsh 低于 `0.1.7-alpha.1` 时本插件无法加载（它所用的 settings API 在旧版不存在）。

## 社区

[Issues](https://github.com/cheshireez/dsh-skill-shelf/issues) · [讨论区](https://github.com/cheshireez/dsh-skill-shelf/discussions) · [官方展示](https://github.com/deepseek-ai/deepseek-harness/discussions/3161) · [市场收录 PR](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/1746) · [Discord](https://discord.gg/Ycq5dCaS4)

## License

MIT — [LICENSE](LICENSE).
