Let me analyze the sessions and extract minimal business subtasks.

Sessions:
1. session-66f4 — coach-admin 工作台重设计（finesse-ui / frontend-design 技能反复用于同一页面）
2. session-b9b8 — coach-admin 抢单大厅卡片间距、卡片尺寸对齐、点击跳转详情页、新建 order-detail 页、学员卡片缩小
3. session-8aec — coach-admin 抢单大厅与我的预约卡片几何统一（H5 预览 + 测量）
4. session-285c — coach-admin 工作台信息层级重排、build:weapp / dist 问题、babel 可选链报错
5. session-368d — 学员卡片移除目标/计划、绑定入口移到详情页、详情页加常去场地
6. session-2763 — DSH 技能面板 usage 统计补丁、按调用量排序
7. session-7012 — skill-usage-manager 进化模块：后台任务化、超时、运行态
8. session-6a9c — 进化模块：prompt 噪音过滤、解析器从后往前找 JSON、会话深度判定
9. session-5ae0 — dsh-superagent GitHub agent 账号对调、侧边栏嵌入插件
10. session-92ec — skillminer 一键挖掘、输入预算
11. session-8cae — C 盘清理审计与执行
12. session-86e0 — 婚礼日程 HTML 审阅与修改、预览截图

Now let me break down into minimal subtasks with counts.

### 会话 session-66f4｜工作区 sports-coach｜用户消息 ~3 条（含系统注入）
- 子任务：教练工作台（coach-admin）页面整体视觉重设计｜1｜证据「使用frontend-design技能对教练工作台做一次整体重设计」
- 子任务：320px 窄屏溢出修复与宽度预算核验｜1｜证据「重点要求：信息层级、间距与留白、按钮的位置和尺寸、窄屏 320px 适配」
- 子任务：构建产物核验（dist 中新样式生效/旧样式残留检查）｜1｜证据「核验编译产物中关键样式生效、旧样式无残留」

### 会话 session-b9b8｜工作区 sports-coach｜用户消息 ~4 条
- 子任务：抢单大厅卡片左右留白对齐上方区块｜1｜证据「调整「抢单大厅」列表卡片的左右间距，让左右留白对称」
- 子任务：卡片点击跳转订单详情页 + 新建页面 + 注册路由｜1｜证据「实现并验证「点击卡片进入课程详情」…需要先新建页面」
- 子任务：开发者工具无变化排查（dist 未重编译）｜1｜证据「开发者工具打开为什么没有变化？」
- 子任务：学员信息卡片尺寸收紧｜1｜证据「定位并调小学员页的学员信息卡片」

### 会话 session-8aec｜工作区 sports-coach｜用户消息 ~1
- 子任务：抢单大厅与我的预约卡片几何统一（共用选择器/等高/单行省略）｜1｜证据「让两种订单卡片共用同一套几何尺寸 mixin」
- 子任务：H5 预览截图 + 元素盒模型实测比对｜1｜证据「我先量出真实尺寸和位置，再动手改」

### 会话 session-285c｜工作区 sports-coach｜用户消息 ~2
- 子任务：工作台信息层级重排（头部/概览/快捷入口/待处理/时间轴）｜1｜证据「教练端工作台已按新的信息层级重排」
- 子任务：dist/app.json ENOENT 与开发者工具编译排查｜1｜证据「ENOENT: no such file or directory, open 'dist/app.json'」
- 子任务：小程序可选链 ?. 编译报错修复（babel 插件）｜1｜证据「invalid file: pages/booking/index.js … Unexpected token .」

### 会话 session-368d｜工作区 sports-coach｜用户消息 ~4
- 子任务：学员卡片移除目标/计划展示｜1｜证据「学员卡片不需展示目标和计划」
- 子任务：绑定/更换计划入口从卡片页迁到详情页（含抽屉、storage 复用、死代码清理）｜1｜证据「不再保留「绑定计划…」入口；把这些查看与操作统一移到学员详情页」
- 子任务：学员详情页新增「常去场地」字段｜1｜证据「学员详情页添加学员常去的场地」

### 会话 session-2763｜工作区 deepseek-harness｜用户消息 ~1
- 子任务：DSH 技能面板调用次数统计补丁（zstd 多帧解码、字段名修正、增量缓存）｜1
- 子任务：按调用量排序按钮注入｜1

### 会话 session-7012｜工作区 deepseek-harness｜用户消息 ~1
- 子任务：进化模块改后台任务 + 运行态轮询 + 明确超时错误｜1

### 会话 session-6a9c｜工作区 deepseek-harness｜用户消息 ~3
- 子任务：复盘输入噪音过滤 + 头尾各半截断｜1
- 子任务：复盘超时预算（10s→150s）｜1
- 子任务：模型回答解析器从后往前找 JSON｜1
- 子任务：会话「对话深度」判定替代消息条数门槛｜1

### 会话 session-5ae0｜工作区 deepseek-harness｜用户消息 ~4
- 子任务：GitHub agent 账号角色对调（device flow、git 身份、凭据助手、policy 收窄）｜1
- 子任务：把已安装插件嵌入 DSH 左侧边栏｜1

### 会话 session-92ec｜工作区 deepseek-harness｜用户消息 ~3
- 子任务：skillminer 一键挖掘路由 + 草稿生成｜1
- 子任务：挖掘输入预算按天均分 + 失败日志｜1

### 会话 session-8cae｜工作区 deepseek-harness｜用户消息 ~4
- 子任务：C 盘扫描审计并产出可清理/不可清理清单｜1
- 子任务：提权执行清理（回收站/缓存/旧版本/驱动/DISM/卸载 Android Studio）｜1

### 会话 session-86e0｜工作区 无（Downloads）｜用户消息 ~4
- 子任务：婚礼日程 HTML 文档审阅找遗漏与不一致｜1
- 子任务：HTML 正文批量修改 + 结构校验（标签平衡）｜1
- 子任务：无头浏览器整页截图分段预览｜1

Now cross-session merge:

**A. 微信小程序（Taro + React）页面样式改造与验证闭环** — 出现在 session-66f4、b9b8、8aec、285c、368d。具体子任务：
- 页面/卡片视觉重设计（finesse-ui / frontend-design 应用）— 66f4、285c、8aec
- 卡片尺寸/间距对齐与统一（共用几何、等高、单行省略）— b9b8、8aec、66f4、368d
- 窄屏/响应式宽度预算核验（320/375/390）— 66f4、8aec、285c
- 编译产物 dist 核验（新样式生效、旧样式无残留、定宽清除）— 66f4、b9b8、8aec、285c、368d
- `npm run build:weapp` 后开发者工具看不到变化的排查 — b9b8、285c
- 页面跳转 + 新建页面 + 注册路由 — b9b8
- 卡片信息字段增删 + 入口迁移（含死代码/孤儿样式清理）— 368d、b9b8

统计：
- 「Taro 小程序页面样式改造 + tsc/test/build + dist 产物核验」这个完整闭环：66f4、b9b8、8aec、285c、368d = **5 次**
- 「卡片几何统一/对齐/等高」：b9b8、8aec、66f4、368d ≈ 4 次
- 「320/375/390 窄屏溢出核验」：66f4、8aec、285c = 3 次
- 「开发者工具读 dist，改源码后必须重编译」：b9b8、285c = 2 次（且是踩坑点）
- 「小程序可选链 ?. 编译报错 → babel 插件」：285c = 1 次

**B. sports-coach 游泳馆/运动陪练专属业务子流程**
sports-coach 是运动陪练平台（项目描述「运动陪练小程序：按运动项目和距离筛选上门教练…」）。会话里出现的业务子任务：
- 教练工作台（coach-admin）：抢单大厅、我的预约、待确认预约、今日安排时间轴、体验课成交率、本月收入、手动录入课时、扫码上课/下课
- 学员档案：学员列表卡片、学员详情（训练目标、训练计划、常去场地、备注、上课历史）、绑定/更换训练计划
- 订单：OrderStatus pending/confirmed/ongoing/to_confirm/done、抢单（coachId 为空=抢单模式）、确认预约、订单详情页
- 场地：venues（朝阳区游泳馆 v2 等）、课程 course、课包

按规则：sports-coach 游泳馆专属业务子流程，出现 ≥2 次 → 必须标【细分专项】，优先级「中」。

哪些 ≥2 次？
- 教练工作台（抢单大厅 + 我的预约 + 待确认 + 今日安排）：66f4、b9b8、8aec、285c = **4 次** ✅ 细分专项
- 学员档案（列表卡片 + 详情页字段/入口）：368d（3 次子任务）、b9b8（学员卡片缩小）= **2 次** ✅ 细分专项
- 订单状态流转与详情页跳转：b9b8 = 1 次（但抢单/确认在多会话中出现，属于工作台一部分）
- 排课/课程表：285c 今日安排时间轴 = 1 次

**C. DSH 插件/技能面板开发（deepseek-harness 工作区）**
- 修改已安装插件源码 + 构建 + 热重载验证：2763、7012、6a9c、92ec、5ae0 ≈ 5 次
- 已有技能 `dsh-plugin-dev-loop` 和 `locate-dsh-plugin-source` 覆盖这个 —— 但会话里大量踩坑（CRLF 换行导致替换失败、vm sandbox 动态 import、zstd 多帧、dist 与 src 不一致核验），说明现有技能可能不够。

现有 `dsh-plugin-dev-loop` 正文：定位源码目录 → 改代码 → typecheck → 构建 → 热重载验证。但会话里的真实坑：
- 文件是 CRLF，`old_string` 按 `\n` 拼接匹配不上 → 需要按索引切片（6a9c 明确记录「这是这个仓库的一个坑」）
- 构建后必须确认探针文件 mtime 晚于 build mtime，才算插件真的重新 apply
- `pending=1` 是别的插件重启项，与本插件无关，不要误判
- src 与 lib 一致性核验（关键符号 grep）
- vm 沙箱测试需要注入 `USERPROFILE` + 动态 import loader

这些是 dsh-plugin-dev-loop 的**优化提案**素材，而不是新建。

**D. 技能进化模块（skill-usage-manager）自身**
7012、6a9c、92ec = 3 次，都是同一个项目内的迭代。但这是「开发一个产品」，不是重复流程。不过其中反复出现的是：
- 模型输出解析（从后往前找 JSON、空返回判定、超时预算）
- 输入预算裁剪（噪音过滤、头尾各半、按天均分）
- 后台任务化 + 运行态轮询 + 失败可诊断

这些是「LLM 驱动的分析任务工程化」模式，跨 3 个会话出现（7012、6a9c、92ec）。这是一个可提炼的技能：**LLM 分析任务的三件套：输入预算、输出解析容错、失败可诊断 + 后台化**。

出现次数：7012（后台任务、超时、空返回）、6a9c（噪音过滤、头尾截断、解析器、深度判定、超时预算）、92ec（输入预算按天均分、失败日志、零候选提示）= **3 次** ✅ 满足 ≥3 次新建门槛。

**E. C 盘清理审计（8cae）** = 1 次，但现有技能 `mole` 覆盖磁盘清理。不过 mole 是 CLI 驱动，而这里是「扫描 → 出可清理/不可清理清单 → 提权执行」。1 次，不推荐新建。

**F. 无头浏览器截图预览（86e0、8aec、285c）**
- 86e0：Chrome headless 被沙箱拦（命名管道）→ 需要完全访问权限；整页截图 → Pillow 切段
- 8aec：ego-browser 量盒模型 + 截图，隐藏 agent 浮标
- 285c：Edge headless CDP 截图
出现 ≥3 次 ✅ 但现有 `finesse-ui` / `impeccable` 提到「taking screenshots to review」，没有具体方法。这是一个可新建的技能：**Windows 沙箱下用无头浏览器出页面预览图**。

出现次数：86e0、8aec、285c = 3 次 ✅

嗯，但我需要克制。让我评估优先级。

主要提案：

### 新建技能
1. **taro-miniapp-page-verify**（或叫 `taro-weapp-page-change`）— Taro 微信小程序页面改造与验证闭环。出现 5 次。优先级高。
   - 包含：改 src → tsc --noEmit → npm test → npm run build:weapp → 核验 dist 产物（新类名在、旧类名 0 处）→ 开发者工具需 Ctrl+B / compileHotReLoad:false → 窄屏宽度预算算术核验
   - 现有技能无覆盖（finesse-ui 是通用 UI 设计，不涉及 Taro/dist/开发者工具）

2. **【细分专项】sports-coach-coach-workbench**（教练工作台业务）— 出现 4 次。优先级中。
   - 依赖通用技能 taro-miniapp-page-verify（若采纳）+ finesse-ui
   - 减少重复交代：抢单大厅/我的预约两个 tab 共用一份 index.scss 与 index.tsx（scope 切换）；OrderStatus 五态；抢单=coachId 为空；卡片几何必须共用选择器、等高、标题单行省略；工作台区块顺序
   - 风险：页面结构仍在变（每轮重设计）

3. **【细分专项】sports-coach-student-records**（学员档案）— 出现 2 次。优先级中。
   - 依赖 taro-miniapp-page-verify + sports-coach-coach-workbench
   - 减少重复交代：coachStudents.ts 数据模型（goal/favoriteVenue/history）、STUDENT_PLAN_KEY storage、选计划抽屉只能在详情页、卡片只展示头像/姓名/课包/状态/电话/排课

4. **llm-analysis-task-hardening**（LLM 分析任务工程化）— 出现 3 次。优先级中/高。
   - 输入预算（噪音过滤、头尾各半、按天均分）、输出解析容错（从后往前找 JSON、空返回≠无结果）、失败可诊断（写 prompt/answer 到磁盘）、后台任务化 + 运行态轮询 + 明确超时
   
5. **headless-page-preview**（Windows 沙箱无头浏览器出预览图）— 出现 3 次。优先级中。
   - Chrome/Edge headless 在沙箱里会因命名管道被拒 → 需完全访问权限
   - 整页截图 → Pillow 按高度切段 → present
   - 隐藏 agent 操作浮标

嗯，5 个新建 + 2 个细分专项有点多。但规则要求细分专项必须输出。让我合并一下：第 4 和第 5 是否真的需要？

第 4（LLM 分析任务工程化）出现 3 次，都是同一个项目（skill-usage-manager）的同一功能（进化/挖掘）。规则说「只出现一次的临时需求」不推荐，但这里是 3 个会话反复踩同类坑（解析器、预算、超时），确实是「每次要重复说明、反复纠正」。而且它不属于 sports-coach，走 ≥3 次通用规则。我认为可以推荐，但优先级「中」，且潜在风险写明「集中在单一项目，泛化性待验证」。

第 5（无头预览）出现 3 次但分布在不同项目（婚礼 HTML、sports-coach H5、工作台）。这是真实的环境事实型技能，收益明确（沙箱限制、坐标换算、切段）。推荐，优先级「中」。

不过我要注意：不要过度生成。让我保留 5 条新建（含 2 个细分专项），并给出 2 条已有技能优化提案。

### 已有技能优化
1. **修改 dsh-plugin-dev-loop**：缺少「构建后确认插件真的重新 apply（探针 mtime > build mtime）」「src 与 lib 一致性核验」「CRLF 文件替换失败」「pending=1 可能是别的插件」「vm 沙箱测试需注入环境变量 + 动态 import loader」。这些在 2763、7012、6a9c、92ec、5ae0 反复踩。

2. **修改 locate-dsh-plugin-source**？其实它和 dsh-plugin-dev-loop 有重叠。会话里 5ae0 找 `dsh-superagent-prototype` 源码、2763 找 `@michengai/dsh-skills-manager`。locate-dsh-plugin-source 已覆盖。可以不提。

3. **合并**：`locate-dsh-plugin-source` 与 `dsh-plugin-dev-loop` 的第一阶段（定位）重复。可以提「合并」提案，把定位作为 dev-loop 的第 1 步，减少一次技能调用。

嗯，这个合并提案有道理。但风险是 locate-dsh-plugin-source 也有独立价值（只定位不改）。我可以提「合并」但标为低优先。

实际上让我聚焦：一个「修改」提案（dsh-plugin-dev-loop），一个「修改」提案（finesse-ui？）。

finesse-ui 的问题：66f4 里第一轮用 finesse-ui 做出来的东西，第二轮用 frontend-design 自查发现「正好命中三条 AI 生成痕迹」（深色卡+酸绿渐变、四张同款圆角卡+同灰阴影、用「·」拼接 meta）。这说明 finesse-ui 的 product register 缺少「自查生成痕迹」这一步，或者自查清单不够前置。这是一个真实的技能缺陷：**finesse-ui 应该在动手前先跑一遍 anti-slop 自查，而不是靠另一个技能事后发现**。

这个提案很有价值。变更类型：修改。目标技能：finesse-ui。

不过 finesse-ui 正文节选里其实提到了「zero AI-slop」「audit visual quality」。但实践中确实没拦住。可以提案增加「开工前的 anti-slop 自检清单（三条具体形状：深色块+单一亮色强调、N 张同款卡片+同一阴影、分隔符拼接的 meta 串）」。

好，两条优化提案：
1. 修改 `finesse-ui`：开工前 anti-slop 自查清单前置
2. 修改 `dsh-plugin-dev-loop`：补构建后 apply 确认、src/lib 一致性、CRLF、沙箱测试四类分支

现在写草稿。要注意格式要求，草稿要含名称、描述、触发条件、执行步骤、测试用例。

我要控制篇幅，但内容要完整。让我写。

关于会话标题，我用前 12 位 id。

用户消息数：我大致数一下。session-66f4 里真实用户消息：checkpoint 摘要 + 「使用frontend-design技能…」= 2 条实质。session-b9b8: 「开发者工具打开为什么没有变化？」「调整抢单大厅列表卡片左右间距」「点击卡片进入课程详情」「学员卡片…」= 4 条。session-8aec: 1 条（从工具输出看是纯执行）。session-285c: 2 条（ENOENT、可选链）。session-368d: 4 条。session-2763: 1 条（隐含）。session-7012: 1。session-6a9c: 3。session-5ae0: 4。session-92ec: 3。session-8cae: 4。session-86e0: 4。

我会标注大致条数，用「约」避免精确错误。实际上模板要求 `<n> 条`，我给个数字。

好，开始写输出。要严格按格式，不要闲聊。

对于细分专项草稿，必须写明「该技能是游泳馆业务专属，依赖已有通用基础技能」，指出依赖哪个通用技能，写明减少哪些重复交代的业务规范。

sports-coach 项目实际是「运动陪练」综合平台（滑雪、乒乓球、增肌、陪驾、游泳馆场地 v2「朝阳区游泳馆」）。按提示规则，sports-coach 的游泳馆专属业务子流程要标细分专项。教练工作台里出现的是「朝阳区游泳馆」场地、教练上门/场馆上课、体验课成交率。我就按「游泳馆/运动陪练场馆业务」来写，说明是 sports-coach 场馆陪练业务专属。

开始写。

注意：草稿技能要写清触发条件防误调用。

我尽量精炼但完整。# 技能进化提案汇总

## 一、新建技能推荐清单

| 序号 | 优先级 | 技能名称 | 适用场景 | 出现次数 | 收益 | 潜在风险 | 建议 |
|---|---|---|---|---|---|---|---|
| 1 | 高 | `taro-weapp-page-change` | Taro+React 微信小程序页面/卡片改造后的完整验证闭环：tsc → test → build:weapp → 核验 dist 产物 → 开发者工具可见性排查 → 窄屏宽度预算 | 5 | 消除「改完源码开发者工具没变化」「dist 残留旧样式」「窄屏溢出靠肉眼猜」三类高频返工 | 项目脚手架差异（webpack5/vite、页面是否被 tab 组件引入）需在触发条件里写清 | 新建 |
| 2 | 中 | `sports-coach-coach-workbench` | sports-coach 教练端工作台：抢单大厅/我的预约双 tab、待确认预约、今日安排时间轴、体验课成交率、手动录入课时 | 4 | 免去每轮重复交代双 tab 共用文件、OrderStatus 五态、抢单语义、卡片几何必须共用 | 页面结构仍在被重设计，流程未完全固定 | 【细分专项】 |
| 3 | 中 | `sports-coach-student-records` | sports-coach 学员档案：学员列表卡片字段取舍、学员详情页（训练目标/计划/常去场地/历史）、绑定训练计划入口归属 | 2 | 免去重复交代「卡片只留头像姓名课包状态」「入口只能在详情页」「storage key 复用」 | 数据模型仍可能扩展字段 | 【细分专项】 |
| 4 | 中 | `llm-analysis-task-hardening` | 用模型做离线分析任务（复盘/挖掘/归类）时的工程化三件套：输入预算、输出解析容错、失败可诊断 + 后台化 | 3 | 避免「跑完没内容」「模型答了却被解析器丢弃」「超时文案甩锅网络」三类空转 | 目前集中在单一项目，跨项目泛化性待验证 | 新建 |
| 5 | 中 | `headless-page-preview` | 在 Windows 沙箱里用无头浏览器给 HTML/H5 页面出整页预览图并切段呈现 | 3 | 免去每次重新摸索沙箱限制、坐标换算、切段与临时浮标隐藏 | 沙箱策略变化会失效；依赖本机浏览器路径 | 新建 |

---

### 候选技能草稿 1：`taro-weapp-page-change`

**名称**：taro-weapp-page-change

**描述**：修改 Taro + React 微信小程序页面（tsx/scss）后，走完「类型检查 → 单测 → 小程序构建 → 编译产物核验 → 开发者工具可见性确认 → 窄屏宽度预算」的闭环，并把结果以 diff + 尺寸对照表输出。

**触发条件**（必须同时满足）：
- 工作区存在 `project.config.json` 且 `miniprogramRoot` 指向 `dist/`
- 任务涉及 `src/pages/**` 或 `src/components/**` 下的 `.tsx` / `.scss` 改动
- 用户提到「小程序」「开发者工具」「编译」「卡片间距/尺寸」「窄屏」

**不触发**：纯 H5 项目、纯后端改动、只读代码审查、只写文档。

**执行步骤**：
1. 读 `project.config.json`，确认 `miniprogramRoot`、`compileHotReLoad`、`es6` 三项。
2. 读 `package.json` scripts，确认 `build:weapp`、`test`、`typecheck` 的真实命令，不要自造。
3. 定位目标页面是否被别的页面以组件方式引入（如 `coach-admin` 被 `coach-tabs` 引入 → 产物落在 `dist/pages/coach-tabs/`，不存在 `dist/pages/coach-admin/`）。这一步决定后面核验哪个 wxss。
4. 改源码，只改约定范围内的样式/结构。
5. 依次运行：`npx tsc --noEmit` → `npm test` → `npm run build:weapp`。三者任一失败先修，不继续。
6. 核验编译产物（这是本技能的核心价值）：
   - 新增的类名在目标 wxss 中出现 ≥1 次
   - 被删除的类名出现 0 次
   - 被替换的定宽/旧值（如 `padding-left:46rpx`）出现 0 次
   - 若某类名残留，先用 grep 定位是别的页面共用类，不要误判为「没生效」
7. 若用户反馈「开发者工具没变化」：先确认 dist 里已是新代码，再让用户 Ctrl+B 编译；仍不行则清缓存或重开项目根目录（不是 dist 子目录）。**不要**在构建进行中让开发者工具编译（会撞 ENOENT）。
8. 窄屏宽度预算：按目标宽度（320/375/390）做算术核验——容器内宽 − 左右 margin − 定宽列 − 右侧动作区，结果必须 > 0；不要只靠「看起来没问题」。
9. 输出：改动文件清单、diff、改前/改后关键尺寸对照表、三项检查结果、需人工目视确认的点。

**测试用例**：
- 正向 1：改某卡片 padding 24px→20px，build 后 dist wxss 中该卡片规则为 20rpx，旧值 0 处。
- 正向 2：删除一个废弃类 `.x__bind`，tsx 与 scss 均无残留，dist 中 0 处。
- 正向 3：320px 下宽度预算为正，输出每个区块的 x/w 数值。
- 边界异常：目标页面被 tab 组件引入，`dist/pages/<page>/` 不存在——技能必须提示去 `dist/pages/<tab>/index.wxss` 核验，而不是报「构建失败」。
- 边界异常：开发者工具报 `invalid file: ... Unexpected token .`——提示这是 `?.` 未降级，检查 `babel.config.js` 是否含 optional-chaining / nullish-coalescing 插件。

---

### 候选技能草稿 2：【细分专项】`sports-coach-coach-workbench`

**名称**：sports-coach-coach-workbench

**描述**：sports-coach 运动陪练平台教练端工作台页面的业务规范与改动约束。**该技能是游泳馆/场馆陪练业务专属，依赖已有通用基础技能 `taro-weapp-page-change`（验证闭环）与 `finesse-ui`（视觉工艺），本身不重复这两者做的事，只承载业务事实。**

**触发条件**：
- 工作区路径含 `sports-coach`
- 任务涉及 `src/pages/coach-admin/` 或 `src/pages/coach-tabs/`
- 用户提到「教练工作台」「抢单大厅」「我的预约」「待确认」「今日安排」「体验课成交率」

**减少哪些重复交代的业务规范**（每轮都要重讲的部分）：
1. **双 tab 是同一个文件**：`我的预约` 与 `抢单大厅` 是 `coach-admin/index.tsx` 里的两个 scope，共用同一份 `index.scss`，不存在两个独立页面文件。改一个必须检查另一个。
2. **抢单语义**：`Order.coachId` 为空 = 抢单模式（学员未指定教练）；抢单只接受未指派订单。
3. **订单五态**：`pending`（待教练确认）→ `confirmed`（已确认）→ `ongoing`（上课中）→ `to_confirm`（待学员确认课时）→ `done`。
4. **卡片几何必须共用**：`.ord-card` 与 `.hall-card` 用并列选择器共享外壳/时间列/标题/meta/动作区，不各写一份；外壳固定 `min-height`，标题单行省略，否则卡片会随右侧按钮数量变高变矮。
5. **左右留白基准 32rpx**：与分段胶囊、四格数据卡、功能宫格一致；抢单大厅没有时间轴，不要继承「我的预约」那层 46rpx 轴槽 padding。
6. **工作台区块顺序**：身份卡 → 经营概览 → 快捷入口 → 体验课成交率 → 待处理 → 今日安排时间轴 → 学员评价。
7. **数据来源**：`getOrders()` / `updateOrder()` / `data/orders.ts`，云层是 `services/cloud/orders.ts`（乐观更新 + localStorage 兜底）。

**执行步骤**：
1. 确认改动落在 `coach-admin`，并判断影响的是 `mine` scope、`hall` scope 还是两者共用样式。
2. 读 `data/orders.ts` 的 `OrderStatus` 与 `Order` 接口，确认字段名，不自造字段。
3. 按上述业务规范改，样式改动优先落在共用选择器上。
4. 交给 `taro-weapp-page-change` 走验证闭环。
5. 若新增页面跳转，先查 `app.config.ts` 是否已有目标路由；没有则先确认用户是否授权新建页面，不要自造路由。

**测试用例**：
- 正向 1：调整抢单卡左右留白，改后 `.hall-wrap` 无 `padding-left`，卡片 x 与「我的预约」一致。
- 正向 2：给抢单卡绑定点击跳详情，卡内「抢单」按钮加 `stopPropagation`，点击按钮不触发跳转。
- 正向 3：长姓名（>10 字）下卡片高度不变，标题单行省略。
- 边界异常：右侧动作区在「确认 / 扫码上课+手动录入 / 金额+抢单」三种形态间切换时，卡片高度必须一致；若不一致，说明外壳缺 `min-height`。

---

### 候选技能草稿 3：【细分专项】`sports-coach-student-records`

**名称**：sports-coach-student-records

**描述**：sports-coach 学员档案的展示分工与数据约定。**该技能是游泳馆/场馆陪练业务专属，依赖 `taro-weapp-page-change`（验证闭环）与 `sports-coach-coach-workbench`（订单与工作台上下文）。**

**触发条件**：
- 工作区路径含 `sports-coach`
- 任务涉及 `src/pages/coach-students/`、`src/pages/coach-student-detail/`、`src/data/coachStudents.ts`
- 用户提到「学员卡片」「学员详情」「训练目标」「训练计划」「常去场地」

**减少哪些重复交代的业务规范**：
1. **职责分工**：列表卡片只放「头像 / 姓名 / 课包 / 状态标签 / 电话联系 / 排课 / 点击进详情」；目标、计划、绑定入口一律在详情页，卡片页不留重复入口。
2. **状态三态**：`active`（在训中）/ `renew`（待续课）/ `done`（已结课）。
3. **数据模型**：`CoachStudent { id, name, packageTitle, done, total, lastTime, nextTime, status, phone, goal, note, history[], favoriteVenue }`；只调整展示位置时**不要删字段**。
4. **计划绑定**：`STUDENT_PLAN_KEY` 的 storage 持久化，抽屉 UI 只在详情页保留一份；从卡片页移除入口时要连带清理孤儿样式（`plan-mask` / `plan-sheet` / `plan-opt` / `@keyframes`）。
5. **卡片尺寸基准**：对齐项目卡片规范 padding 24px / radius 28px / 头像 72px / 按钮 60px / 卡片间距 18px。

**执行步骤**：
1. 判断改动在列表页还是详情页，读 `coachStudents.ts` 确认字段是否已存在（`favoriteVenue` 已存在则直接展示，不要重复加）。
2. 改 tsx 与 scss；删入口时同步删样式与 state/import，避免死代码。
3. 全局 grep 确认无残留类名引用。
4. 交给 `taro-weapp-page-change` 走验证闭环。

**测试用例**：
- 正向 1：学员卡片不再出现「目标」「计划」「绑定训练计划」任何文案。
- 正向 2：详情页可看到「训练目标 / 训练计划 / 常去场地」，且可完成绑定/更换，刷新后仍生效（storage）。
- 正向 3：删除卡片页抽屉后，`index.scss` 中无 `plan-sheet` / `plan-opt` 残留。
- 边界异常：只删 JSX 不删 scss → 技能必须要求跑一遍残留类名 grep；只删 scss 不删 JSX → 构建会报未定义样式但界面静默变丑，必须双向核对。

---

### 候选技能草稿 4：`llm-analysis-task-hardening`

**名称**：llm-analysis-task-hardening

**描述**：给「用模型做离线分析」的功能做工程加固：输入预算、输出解析容错、失败可诊断、长任务后台化。适用于复盘、挖掘、归类、评审等非实时任务。

**触发条件**：
- 代码里有一处「把大量上下文丢给模型，期待返回结构化 JSON」的调用
- 用户报告「跑完了但没内容」「没有可提的建议」「请求超时」且文案与实际不符
- 用户提到「复盘」「挖掘」「分析」「模型返回空」

**不触发**：实时对话、单轮问答、纯前端改动。

**执行步骤**：
1. **量输入**：统计实际送进模型的字符数/token 数。若 > 上下文一半，先做预算。
2. **做预算**：
   - 过滤宿主注入的噪音（`<system-reminder>` 等），那不是用户说的话
   - 截断用「头尾各半」而非「只留尾部」，否则会丢掉原始需求
   - 多文件/多天输入用**均分**而非「最近优先吃满」，否则最老那份被挤成残片，跨天模式无证据
   - 截断落在行/句边界
3. **修解析**：不要用 `indexOf('[')` 找 JSON。模型常先输出思考过程，里面就有方括号。改为从**后往前**找 `[`，用真 `JSON.parse` 逐个候选验证，返回第一个合法数组。保留「`[]` 是合法答案」的语义。
4. **区分三态**：调用失败 / 超时 / 成功但零结果。三者文案必须不同，不能都显示「没有可提的建议」。
5. **失败落盘**：把实际发出的 prompt 与模型原始回答写到 sidecar 文件（如 `*-last-prompt.txt` / `*-last-answer.txt`），下次不必猜。
6. **超时对齐**：客户端超时必须 ≥ 服务端超时，否则客户端先掐断并报出误导性文案（例如把模型超时报成「上游 GitHub 响应慢」）。让服务端超时先生效。
7. **长任务后台化**：POST 立即返回 `{started}`，GET 暴露 `running / elapsedMs / lastError`；前端点击后立即进入「分析中（已 N 秒）」，2 秒轮询，切页面回来能接着显示。

**测试用例**：
- 正向 1：模型回答前有大段思考文本、末尾才是 JSON 数组 → 能正确提取。
- 正向 2：模型回答末尾是 `[]` → 识别为「真的没有」，不报错。
- 正向 3：输入 10 万字符 → 压到预算内且每份输入都保留实质内容。
- 边界异常：模型返回空字符串 → 判为失败并给出明确原因，而不是「没有可提的建议」。
- 边界异常：模型永不返回 → 超时后返回可读文案（含已读会话数/消息数），且客户端文案与服务端原因一致。

---

### 候选技能草稿 5：`headless-page-preview`

**名称**：headless-page-preview

**描述**：在 Windows 沙箱里用无头浏览器把本地 HTML / H5 页面渲染成整页预览图，按高度切段后呈现给用户。

**触发条件**：
- 用户说「预览」「看看效果」「截个图」「渲染一下」
- 产物是本地 `.html` 文件或本地 dev server 的页面
- 环境是 Windows + 沙箱

**不触发**：需要交互操作的页面验收（那用浏览器控制类工具）、纯代码审查。

**执行步骤**：
1. 找浏览器：优先 `C:\Program Files\Google\Chrome\Application\chrome.exe`，其次 `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`。不要假设在 PATH 里。
2. **沙箱限制先说明**：Chromium 在受限沙箱下会因命名管道被拒而自杀（`platform_channel.cc: Check failed: 拒绝访问`、`crashpad OpenProcess 拒绝访问`）。这时需要一次完全访问权限，不是浏览器装错了。
3. 用 `--headless=new --disable-gpu --hide-scrollbars --screenshot --window-size=W,H` 出图；整页需要把 H 设得足够大（如 9000），再按内容底部裁掉空白。
4. 若页面依赖 CDN（Tailwind 等）且离线不可用，先说明「样式会缺失」，或改用内联样式版本。
5. 图片过高时按高度切成 3–4 段，每段保持可读比例，逐段呈现并标注该段对应页面哪个区块。
6. 页面里若有 agent 操作浮标（如 `#ego-agent-cursor-overlay`、`DeepSeek` 角标），截图前隐藏，并说明「浮标不属于页面本身」。

**测试用例**：
- 正向 1：本地 HTML 渲染成功，输出整页图并按区块切成 4 段。
- 正向 2：页面依赖 CDN 且可联网 → 样式完整；不可联网 → 明确提示并给出离线方案。
- 正向 3：隐藏操作浮标后重新截图，图中无工具角标。
- 边界异常：直接调用浏览器报 `Check failed: 拒绝访问` → 技能应判定为沙箱限制并申请完全访问权限，而不是重试同一命令。

---

## 二、已有技能优化提案

### 提案 A

**变更类型**：修改

**目标技能**：`finesse-ui`

**痛点总结**：
在教练工作台的重设计中，第一轮按 `finesse-ui` 的 product register 产出的界面，被第二轮用 `frontend-design` 自查时判定**正好命中三条典型生成痕迹**：
1. 深色底 + 单一酸绿强调（`$ink` 深色 hero + `#a3e635` 渐变）
2. N 张同款圆角卡片 + 同一个 `rgba(0,0,0,.04)` 灰阴影
3. 用「·」拼接的 meta 串（`套餐 · 地点`）

这说明 `finesse-ui` 虽然写了「zero AI-slop」，但**自查发生在交付之后、且依赖另一个技能来发现**。缺的是「开工前先跑一遍可判定的反模式清单」这一步——三条痕迹都是动手前就能避开的形状，不是事后审美问题。

**新版技能源码**（在 `finesse-ui` 的 §0 之后插入一节，md 格式）：

```md
## §0.5 开工前的反模式自检（必做，不许跳）

在写第一行样式之前，先对着下面的清单检查你**打算**采用的方案。命中任意一条，
就必须换一个来自 brief 本身的形状，而不是微调数值。

| 反模式 | 判定方式（可机械检查） | 换法 |
|---|---|---|
| 深色块 + 单一高饱和强调色 | hero/header 用深色底，且全页只有一种亮色（常是酸绿/荧光青） | 深色块只承载身份信息，指标移到浅色区；或整个换掉深色块 |
| N 张同款卡片 + 同一个灰阴影 | 同页出现 ≥3 个 `border-radius` 相同、`box-shadow` 相同的容器 | 让卡片形态随内容分化（列表行/账本行/时间轴），阴影只在需要抬升的元素上用 |
| 分隔符拼接的 meta 串 | 代码里出现 `{a} · {b}`、`{a} / {b}` 这类模板 | 拆成两行、或改成标签+数值对、或直接删掉次要信息 |
| 四格等宽数字卡 | 一排 4 个 `flex:1` 的统计卡，字号一致 | 选一个真正的主动指标放大（金额/剩余课时），其余降级为小字 |
| 全页圆角档位 > 3 种 | 统计不同 `border-radius` 值 | 锁定 3 档：大容器 / 卡片 / 小控件，胶囊单独算 |

自检结论要在动手前用一句话写出来：「本方案的主形状是 X，避开了 Y 和 Z」。
如果写不出这句，说明方案还没成形，不要开始写样式。
```

**测试用例**：
- 正向 1：给一个「教练工作台」brief，技能应先输出反模式自检结论，再开始写样式。
- 正向 2：方案里出现 4 张同款卡片 → 技能必须要求分化形态后才继续。
- 正向 3：方案里出现 `{a} · {b}` 拼接 → 技能必须要求改写。
- 边界异常：brief 本身要求「统一的卡片列表」（如设置页）→ 自检应允许同款卡片，但要求阴影/圆角档位仍收敛到 ≤3 种，不得机械拒绝。

**风险评估**：可能让简单页面过度设计。缓解：自检只在「新建/整体重设计」时强制，「微调单个组件」时跳过。

**收益对比**：把「事后被另一个技能判定为 AI 味」提前成「动手前 30 秒的自检」，避免整页重写（本次实际发生了一次 775 行 scss 的推翻重来）。

---

### 提案 B

**变更类型**：修改

**目标技能**：`dsh-plugin-dev-loop`

**痛点总结**：
该技能当前正文只覆盖「定位源码 → 改代码 → 类型检查 → 构建 → 热重载验证」主干，但实际 5 次插件改造中反复踩到 4 类分支，每次都要重新摸索：

1. **构建成功 ≠ 插件已加载**。必须比对「探针文件 mtime > build mtime」才能确认真的重新 apply；`unlag` 报的 `pending=1` 可能是**别的插件**的重启项，不能当成自己失败。
2. **src 与 lib 可能不一致**。改了 `src/` 但产物在 `lib/`，需要用关键符号 grep 双向核对；核对时要注意转义差异会造成假阴性（本次 `call.config ??` 在 src 检测为 False，实际存在）。
3. **文件是 CRLF**。用 `\n` 拼的 `old_string` 匹配不上，替换静默失败两次，最后只能按索引切片。这是仓库级事实。
4. **vm 沙箱测试需要额外注入**：`USERPROFILE`（否则读不到会话目录，扫出 0 个文件）、动态 `import()` loader（否则 `A dynamic import callback was not specified`）、以及合并缓存窗口要等过再断言。

**新版技能源码**（在「步骤」后追加一节，md 格式）：

```md
## 验证的四道关（缺一不可）

构建退出码 0 只证明「能编译」，不证明「页面在跑新代码」。按顺序过这四关：

1. **构建产物存在**：`lib/index.js`、`lib/client.js` 的 mtime 是本次构建时间。
2. **插件真的重新 apply**：比对插件自写的探针文件 mtime 与 build mtime，
   探针晚于构建才算加载成功。若 `unlag` 报 `pending=N`，先确认这 N 项
   是否属于本插件——其他插件的重启项不要当成自己的失败去反复 reload。
3. **src 与 lib 一致**：挑 2–3 个本次改动引入的**新符号**（新函数名、新常量名、
   新路由路径）在 `src/` 与 `lib/` 各 grep 一次，两边都要命中。
   注意：带 `?`、`??`、`|`、`(` 的字符串在 shell 里会被当元字符或转义，
   检测结果为 False 时先用纯字母数字符号复核，不要直接判定「没同步」。
4. **行为可验证**：能脱离 UI 验证的逻辑（解析器、缓存、统计）写一个独立脚本
   用真实数据跑一遍，比反复重启界面点按钮可靠。

## 这个仓库的两个坑

- **CRLF**：`src/client/api.ts` 等文件是 CRLF。用 `\n` 拼接的 old_string 匹配不上，
  替换会静默失败。替换前先读原始片段确认换行符；匹配失败就改用按索引切片。
- **vm 沙箱测试**：用 `node:vm` 加载插件片段做单测时，必须额外提供
  `process.env.USERPROFILE`（否则路径解析拿不到家目录，会扫出 0 个文件）、
  动态 `import()` 的加载器（否则报 `A dynamic import callback was not specified`），
  以及注意插件内部的合并缓存窗口——断言「只重读 1 个文件」前要先等过这个窗口。
```

**测试用例**：
- 正向 1：改完插件构建成功，探针 mtime 晚于 build mtime → 判定为已加载。
- 正向 2：`unlag` 报 `pending=1` 但探针已更新 → 判定为本插件正常，`pending` 属其他插件，不重复 reload。
- 正向 3：src 与 lib 对新符号双向命中 → 判定一致。
- 边界异常：grep 新符号在 src 返回 False，但该符号含 `??` → 技能必须要求换纯字母数字符号复核，而不是直接判定「没同步」并重写文件。
- 边界异常：vm 测试扫出 0 个会话 → 技能必须提示先注入 `USERPROFILE`，而不是判定「测试数据不存在」。

**风险评估**：四道关会让简单改动变慢。缓解：纯文案/locale 改动可只过第 1、2 关。

**收益对比**：本次 5 次插件改造中，至少 4 次因为「构建成功但没生效」「grep 假阴性」「CRLF 替换失败」「vm 扫出 0 文件」各多花 1–3 轮。封装后可直接跳过这些弯路。