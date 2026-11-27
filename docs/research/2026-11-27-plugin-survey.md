# Paseo、DeepSeek Harness、Hermes Agent 上什么插件装得多，operad 可以拿什么（2026-11-27）

owner 问的问题："看看 Paseo、dsh、Hermes 等有什么流行的 plugin，operad 可以拿进来。"前四节是事实，最后两节是判断，不是决定。

出处的标法：**一手** 是子代理读了仓库的 README、文档、源码目录，或用 `gh` 和 npm 的接口取了数字；**页面** 是经一个会做摘要的抓取工具读的网页，数字不如一手可靠；**第三方** 是别人的报告或榜单；**未核** 是没有验证。调研由三次只读的网页调查完成（2026-11-27），没有安装或运行任何一个产品，写这份笔记时没有逐条回到原页复核。没查的：X、Reddit、V2EX、掘金、知乎。

## 一览

- 三家装得多的都不是编排，而是五类：界面和观察、用量和订阅、通道、触发来源、技能。
- 只有 Paseo 有带安装数的官方插件市场。Hermes 的插件没有任何安装量数据。dsh 没有官方市场，社区榜靠星数，有刷星的投诉。
- 技能市场的量级比插件市场大两个数量级（skills.sh 榜首 460 万次，Paseo 榜首 5,813 次），安全问题也出在这里。
- operad 已有的东西在别家是插件：按 YAML 排多 agent 流水线加审批关卡，在 Paseo 是一个 904 次安装的社区插件。

## 1. Paseo

`github.com/getpaseo/paseo`，Apache-2.0，25,769 星，最新 v0.17.6（2026-11-27）。本机 daemon 加桌面、手机、网页和 CLI 客户端（一手）。

**扩展点（一手，README 和 `docs/plugins.md`）**

| 扩展点 | 做什么 | 怎么打包 |
|---|---|---|
| 插件 | 界面（页面、侧栏、面板、斜杠命令、时间线条目、主题）、agent 生命周期钩子、provider、用量来源 | 一个目录：`paseo-plugin.json`、`index.server.ts`（daemon 的子进程）、`index.client.tsx`（每个客户端里跑）。不隔离，`pluginsEnabled: true` 才开 |
| 内置插件 | provider 适配器、十个 `*-usage-source`、`worktree-include` | 仓库里 `plugins/<id>/`，进程内 |
| 生命周期钩子 | `agent.create.before`、`agent.turn.before/after`、`agent.permission.before/after`、`worktree.create.*`、`command.run.before` 等 | 插件的服务端代码 |
| MCP 服务 | 让 agent 建 agent、worktree、定时和心跳，互相发提示 | daemon 自带，默认不注入 |
| 定时和心跳 | cron 每次起一个新 agent；心跳定时再问一个已有的 agent | 内置 |
| Hub | GitHub、Linear、Slack、Discord、定时、webhook 触发 agent | 单独的服务，触发写在 `.paseo/triggers/*.yml` |
| 语音、Relay | 听写和语音模式；端到端加密的远程访问 | 内置；Relay 是单独的服务 |

**市场**：`paseo.sh/plugins`，672 个插件，333 个作者，索引里的安装数合计 66,946。安装数是"请求安装的次数，不是成功数或用户数"（一手，`PROTOCOL.md`）。

**装得最多的（一手，`plugins.paseo.sh/index.json`）**

| 安装 | 插件 | 做什么 |
|---|---|---|
| 5,813 | better-paseo | 所有 agent 在一块看板上；更快的聊天时间线 |
| 3,620 | progress | 每个 worktree 一块进度面板，读 agent 写的一个文件 |
| 3,170 | cafe | 应用内的插件目录 |
| 3,001 | beautiful-chat | 聊天卡片换样式 |
| 2,322 | skills | 列出、显示、调用 agent 的技能 |
| 2,159 | host-monitor | 侧栏里的 CPU、内存、磁盘 |
| 1,862 | genui | agent 用图表和表单回答 |
| 1,563 | agent-observatory | agent、用量、定时运行的面板 |
| 1,358 | zerosub | 多个 Claude / Codex 订阅，自动切换 |
| 1,324 | sidechat | `/btw`、`/side`、`/fork` 侧聊 |
| 1,270 | bots | 带记忆、定时和团队的个人 bot |
| 904 | playbooks | YAML 写的多 agent 流水线，带审批关卡 |

按分类数：工具 297、侧栏 202、工作区 191、主题 122、编排 106、provider 59。

**呼声高的（一手，`gh`）**：Antigravity CLI 支持（#1131，23 个赞）、Agent SDK 计费变化后的 Claude provider 路线（#1029，13）、接已有的 CLI 会话（#237，10）、沙箱（#1005，7）。讨论区：经远程主机的浏览器代理（10）、把一个对话换到另一个 provider（8）、按事件选通知（7）。

## 2. DeepSeek Harness（dsh）

`github.com/deepseek-ai/deepseek-harness`，287,739 星，最新 v0.2.3-alpha.2（2026-11-22）；`@deepseek-ai/dsh` 一周 681,080 次 npm 下载（一手）。

**扩展点（一手）**：一切都是 Cordis 插件，以 bundle 分发（一个 npm 包，`package.json` 里声明往配置里插哪些插件行），`dsh plugin add <包|git|路径>` 安装。

| 扩展点 | 怎么打包 |
|---|---|
| 工具 | 进程内 `ctx.tools.register` |
| 钩子 | 进程内事件；另有桥，能直接跑 Claude Code 的 `hooks.json` 和 Codex 的钩子 |
| 技能 | 带 `SKILL.md` 的目录，监视变化即时生效 |
| MCP 服务 | 配置，或由插件登记 |
| 连接器 | bundle：厂商的 CLI 加一份 `SKILL.md`，或一个带 OAuth 的远程 MCP 服务 |
| 模型 provider | 进程内 `LlmAdapter` |
| webhook | 进程内规则，建会话（实验） |

没有"通道"这个概念。

**自带的（一手）**：连接器有飞书、钉钉、企业微信、腾讯会议（CLI 加 `SKILL.md`）、Notion（远程 MCP）、Linear、腾讯文档。可选 bundle 默认关：cua、timeline、session-search、ralph、terminal、session-titles、voice-input、auto-review、liveshare、tool-worktree 等。自带的没有使用量数据。

**市场**：没有官方市场。官方的发现方式是 GitHub topic `dsh-plugin`，35,236 个仓库，被无关仓库蹭标签（一手）。社区的 `awesome-dsh-plugin` 25,734 星，自称收 13,445 个插件，不排名（第三方）。

**星数高的社区项目（星数一手，描述是作者自己写的，星数是否自然未核；讨论 #5777 有人投诉广告和自顶）**

| 星 | 项目 | 自称做什么 |
|---|---|---|
| 88,467 | dsh-our-free-model | 不用 key 的免费模型 |
| 36,932 | dsh-desktop（anywhere-labs） | 桌面客户端 |
| 32,889 | dsh-Go | 手机上远程控制 |
| 13,611 | dsh-market | 应用内市场界面 |
| 12,985 | dsh-purge | 越狱提示词管理 |
| 10,660 | dsh-web | 网页界面插件包 |
| 8,332 | dsh-TUI | 终端界面 |
| 5,544 | dsh-context | 上下文查看器 |
| 3,833 | dsh-im | IM bot：飞书、微信、Telegram、Slack 等 |
| 3,112 | dsh-agent-teams | agent 团队 |

**呼声高的（一手）**：独立客户端、CLI 和 VS Code 插件（#172，179 票）；带安全审查的官方插件市场（#1115，93 票）；TUI（#45，32 票）。

## 3. Hermes Agent

`github.com/NousResearch/hermes-agent`，266,453 星（一手）。

**扩展点（一手，`website/docs/` 和仓库目录）**

| 种类 | 怎么打包 |
|---|---|
| 插件 | 目录：`plugin.yaml` 加 `__init__.py` 的 `register(ctx)`；`hermes plugins enable` 才开 |
| 插件目录 | `plugin-catalog/` 里每个插件一份 YAML，钉到 40 位提交，维护者合并。2,686 份：官方 21、厂商认证 15、其余社区 |
| 技能 | `SKILL.md` 目录；自带 44 个，可选 141 个 |
| Skills Hub | `hermes skills install`，来源有官方、skills.sh、GitHub tap、ClawHub 等，装时扫描 |
| 记忆 provider | 单选的插件 |
| 通道 | `plugins/platforms/<名字>`，树里 26 个 |
| MCP | `config.yaml` 里的 `mcp_servers`；68 个预设 |
| 钩子 | 四套：gateway 钩子、插件钩子、shell 钩子、对外 webhook |
| 其他 provider | 网页搜索 12 个后端、图片生成 8 个、模型 provider 37 个 |

**官方目录的 21 个（一手）**：advanced-delegation、agent-importers、blender、bubblewrap、camofox、claude-subscription-directsdk、elevenlabs（两个）、hermes-memory-wiki、hermes-security、homeassistant、langfuse、mcp-serve、meshy、snyk、spotify、touchdesigner、xchat 等。README 点名的通道是 Telegram、Discord、Slack、WhatsApp、Signal。**Hermes 插件的安装量：没有数据。**

**呼声高的扩展（一手，issue 按赞数）**：Claude Agent SDK provider 加订阅登录（#25267，57，已成官方插件）；远程 agent、本地执行工具（#18715，52）；Mistral provider（38）；SearXNG 搜索（30）；A2A 协议（29）；通用 ACP 客户端（27）。

**社区仓库（一手）**：前端最大，hermes-webui 19,646 星、hermes-workspace 6,851 星。单个社区插件都小，没有超过约 220 星的。

## 4. 技能市场

**skills.sh 总榜（页面；覆盖所有 agent，不只 Hermes；页面上的合计数比榜首还小，计数自相矛盾）**：find-skills 460 万、agent-browser 170 万、hyperframes 系列各约 170 万、design-mobile-apps 170 万、grill-me 160 万、reddit-automation 160 万、frontend-design 120 万。

**ClawHub 按下载（页面；每个技能两个没有标签的数，下面取看起来是下载的那个）**：self-improving agent 49.6 万、Skill Vetter 28.5 万、Github 20.7 万、ontology 20.3 万、Gog 20.1 万、Weather 17.5 万、Multi Search Engine 16.7 万、Agent Browser 16.1 万、Humanizer 13.6 万、Obsidian 11.4 万、Notion 10.6 万。

**安全**：Snyk 2026 年 2 月查了 ClawHub 和 skills.sh 的 3,984 个技能，534 个（13.4%）有严重问题（第三方）。CVE-2026-9353 是 Hermes 技能扫描器的注入漏洞；CVE-2026-82021 是它自带的一条 MCP 目录项指向可变分支而不是钉住的提交（都是第三方，只见到摘要）。没有查到经 Hermes 自己的目录分发恶意技能的确认案例。

## 5. 对 operad 的判断

operad 现有的插件：`dev`、`chat`、`bot`、`memory`、`pool`、`shell`、`source-cron`、`telegram`、`mcp` 和 `harness` 下的几个。

**建议拿的，按顺序**

1. **用量和订阅额度的显示。** Paseo 内置十个用量来源，zerosub 1,358 次安装，Hermes 呼声最高的扩展 issue 是订阅登录。operad 这边额度用完后的处理已有：worker 可以写 `fallback`，没有 fallback 的 pool 按 `retry_after_secs` 等（ADR 0021）；订阅登录的花费记为未知（ADR 0022）。缺的是事前那一半：每个账号用了多少、离限额多远。做成给 `pool` 报用量的来源，客户端显示。
2. **GitHub 来源。** issue、PR、评论变成一次运行。Paseo 的 Hub、dsh 和 Hermes 的 webhook 都是这个。`operad-channels.md` 已定 HTTP 来源和来源插件的 `fetch`，都没做；今天只有 cron。
3. **第二个通道。** Hermes 有 26 个，dsh 官方连接器是飞书、钉钉、企业微信，dsh-im 3,833 星。operad 只有 Telegram，第二个通道同时要做卡片协议（ADR 0033 D1）。选哪个要看用户在哪：中文用户是飞书，英文是 Slack 或 Discord。
4. **从技能市场装技能。** 量最大的一类。operad 的 skill 目录和交给 agent 的办法已定（`operad-skills.md`），没有安装这一步。要做就照 MCP 服务的登记办法（ADR 0031）：钉提交、装前给人看内容、确认后才生效；13.4% 这个数说明不能直接装。
5. **导出运行轨迹。** Hermes 官方目录收了 langfuse。operad 的 history 本来就是事件日志，导出估计是个薄插件，工作量没有估过。

**可以晚点看的**

- 侧聊（`/btw`、`/fork`）：sidechat 1,324 次。并进 `operad-chat-commands.md`。
- 回复里带图表和表单：genui 1,862 次。是客户端的活。
- 多 agent 看板和进度面板：Paseo 装得最多的两个。属于 desktop 和 TUI，不是插件。
- 心跳：定时再问一个已有的 agent。`source-cron` 每次起新的。
- 搜索后端：SearXNG、Tavily、Brave 在 Hermes 呼声不低。operad 这边挂 MCP 服务，不做插件。
- 直接跑 Claude Code 的 `hooks.json`：dsh 有这座桥。operad 的步骤模型不同，先不看。

**不拿的**

- 主题、聊天美化、应用内市场界面。
- dsh 榜首的"免 key 模型"和越狱提示词管理。
- YAML 流水线加审批关卡：operad 的 flow 就是这个，可以当宣传点。

## 6. 一个旁证

三家里插件市场最规整的 Paseo，插件是不隔离的进程内代码；Hermes 的插件目录钉提交、要维护者合并，出过"目录项指向可变分支"的 CVE；dsh 没有官方市场，讨论区票数第二高的插件类诉求是"带安全审查的官方市场"。operad 按 npm 包名装插件（ADR 0012），真要开目录，钉版本和装前确认要先有。

## 出处

- Paseo：`github.com/getpaseo/paseo`（README、`docs/plugins.md`）、`paseo.sh/plugins`、`plugins.paseo.sh/index.json`、`github.com/getpaseo/plugins/blob/main/PROTOCOL.md`
- dsh：`github.com/deepseek-ai/deepseek-harness`（`docs/`、`packages/`、Discussions）、`github.com/awesome-dsh-plugin/awesome-dsh-plugin`
- Hermes：`github.com/NousResearch/hermes-agent`（`website/docs/`、`plugins/`、`plugin-catalog/`）、`hermes-agent.nousresearch.com/marketplace`
- 技能市场：`skills.sh`、`clawhub.ai/skills?sort=downloads`
- 安全：`snyk.io/blog/toxicskills-malicious-ai-agent-skills-clawhub`（地址未试）、`advisories.gitlab.com/pypi/hermes-agent/CVE-2026-9353/`、`rapid7.com/db/vulnerabilities/cve-2026-82021/`
