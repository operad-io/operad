# operad-bot：个人助理，替掉自己的 OpenClaw 场景

- 状态：decided（场景与形状；2026-11-09 owner 定了插件、profile 和主工作目录；2026-11-11 owner 把插件和用户可见的词从 assistant（助理）改名为 bot；2026-11-11 owner 去掉 profile 这个词，对象直接叫 bot；2026-11-11 owner 批了 chat 和 bot 的一批用户词（决定 20）；第三方来源的接入细节未定）
- 涉及 ADR：0021、0025
- 涉及：`operad-conversation.md`；`operad-sandbox.md`；`operad-channels.md`；`operad-plugins.md`；`operad-bot-mcp.md`
- 来源：`operad.md`；owner 的使用场景；`research/2026-11-04-agent-autoloop.md`「拿来即用的场景模板」；`research/2026-11-05-noop.md`「决定、门禁、自治」

## 背景

目标不是 OpenClaw 的市场位置，是自己的几个场景：一个长期存在、手机上随时能聊的 bot；一个个人知识库；每天定时搜集资料。OpenClaw 赢在"真的做事"加零摩擦，输在默认放任（`operad-sandbox.md`）。operad 要在不放任的前提下做到同样的零摩擦：一句话描述需求，agent 写出 flow 或插件，立刻能用。

## 决定（已定）

1. **三个场景，按这个顺序**：长对话（`operad-conversation.md`）；个人知识库（second brain）；每日资料搜集（digest）。后两个是 flow 加 skill，不是新插件，取数据的步骤除外。
2. **知识库是一个插件**：它处理信息、归档、找回；存储是可换的后台，用户现有的 Obsidian 库是其中一个（不要求用户改目录结构），Markdown 目录加 git 是另一个。它最关键的两件事是怎么组织、怎么检索；bot 的记忆是它里面的一个保留命名空间。这个插件和记忆的管理以后单独设计，合约上它需要的是外部对象、`settings`、`secrets`（`operad-contract.md` 决定 3、10、11）。
3. **知识库是三个 flow 加一个 skill**：
   - `brain:capture`：来自 iOS、Telegram 或命令行的一条"记下"事件（文字、链接、转发），agent 按 skill 归档：选目录、写 frontmatter、补 `[[链接]]`、链接的页面抓正文存成附件；写完回一行"存到哪了"。
   - `brain:review`：每天一次 cron，整理 `inbox/`，合并重复，提出三条值得回看的，送一张卡；卡上的动作只有"看过了"和"打开"。
   - 对话里读写：`brain` skill 随 `chat` 的默认访问档一起给 bot，告诉它知识库在哪、怎么写、什么不能删（删除走 ask）。
4. **每日资料搜集是按主题配置的 cron flow** `digest:run`：配置 JSON `{ topic, schedule, sources: [...], deliver: [channel, …] }`，`sources` 的每一项指向一个来源插件（`operad-channels.md` 决定 18）：怎么登录、怎么读都归插件，operad 只拿到统一形状的条目。候选插件：`hn`（免费 API）、`rss`（任意 feed）、`reddit`（要注册 OAuth 应用，每个 client 100 次/分，匿名 `.json` 已经关了）、`x`（只剩按量付费，每读一条 $0.005，默认不开，用不用按费用定）、`web`（给定查询词的搜索）。步骤顺序：来源插件的 `fetch` 步骤取条目 → agent 按 skill 去重、排序、写摘要 → 交给知识库插件归档 → 送一张卡（前 N 条，各带链接）。卡上的反应（有用、没用）记成事实，下一天的 prompt 里把最近的反应当资料带上；没有模型替用户改规则。
5. **来源插件不让 agent 碰密钥，也不让来源内容进指令**：条目作为资料给 agent 读（`operad-contract.md` 决定 7），登录态只在插件自己的 `secrets` 里（决定 11）。
6. **通道只做四个**，顺序按 `operad-channels.md` 决定 17：Telegram、WhatsApp、Slack、iMessage。这三个场景的卡和消息走 Telegram 和 iOS。
7. **技能格式**：bot 和这些 flow 的 skill 用 Agent Skills 的 `SKILL.md` 格式，和 pi、Claude Code 的技能互通，只读文本、不跑技能里的代码；不做技能市场（`operad-plugins.md` 决定 8）。
8. **不做**：语音、Canvas、摄像头和屏幕一类设备动作、暴露在公网的网关、影子 judge 之外任何"模型替人决定"。按页面结构操作的自动化浏览器不在此列，见 `operad-bot-mcp.md` 决定 10。
9. **bot 是一个插件 `bot`，它的对象就叫 bot**（2026-11-09 owner 定；2026-11-11 owner 改名：原来叫 `assistant`、助理，插件名、配置段、动作、目录和用户可见的词一律改成 bot，不留别名；2026-11-11 owner 定：去掉 profile 这个用户词，对象直接叫 bot，原待决问题 6）。用户可见的新词只有 bot。一个 bot 是一套人格和权限：主工作目录、默认 harness、挂载的 skills（`SKILL.md` 目录，contract 决定 13）、访问档（`operad-sandbox.md` 决定 1）、称呼。默认只有一个 bot，叫 `default`；要几个就配几个（比如一个只读的、一个能动知识库的），`bot:chat <bot>` 在其中一个上开对话。bot 写在 `config.json` 的 `bot` 段的 `bots` 下（`bots.default`；contract 决定 10 的插件 `settings`，带 JSON Schema，T-0080 的设置接口能看能改），每个 bot 在列表里是一行，是 bot chat 的父对象。
10. **主工作目录是 `~/.operad/bot/`**，默认 bot 直接用它，别的 bot 各有自己的目录（不写时是 `~/.operad/bot/<名字>`）。知识库和 bot 的记忆以后也住这里。`~/.operad` 的其余部分（事实日志、`secrets`、token）仍在默认访问档的 `denyPaths` 里：bot 的 cwd 是 operad 家目录的一个子目录，不是家目录本身。
11. **bot chat 是 `chat` 基础插件的对象**（`operad-conversation.md` 决定 12）：`bot:chat` 在一个 bot 上新建，harness 当时选、之后不换；skills 和访问档每次回复时从 bot 现读，收紧权限或加一个 skill 不用新建 chat。bot 要碰仓库时通过 operad 的 MCP 工具调 `dev`（看任务、开 task），不自己改仓库文件（`operad-conversation.md` 决定 15）。Telegram 绑进来的 chat 用 `default` bot，以后规则里可以指定。
12. **每个 bot 有一个费用上限，到了就停**（2026-11-11 owner 定，`research/2026-11-11-grok-bot.md`）：bot 上设一个周期预算；这个 bot 的 chat 和定时 flow 的用量（harness 记下的费用事实）加起来到了上限，运行停在当前步骤，成为一个待处理项，人答了才继续或结束。是当场停下，不是事后提醒：Grok Bot 的月上限不在运行中途停，用户抱怨最多的就是这个。
13. **不是人当场发起的运行更严**：bot 的定时 flow 和由事件发起的运行按 `operad-sandbox.md` 决定 8，对外写的动作先问或只存草稿。
14. **对话里回答方的称呼默认是 Operad Bot，可以改**（2026-11-11 owner 定）：transcript 给模型的消息标的是一个称呼，不是 assistant 也不是 bot。`chat` 插件的设置里有一个默认称呼（默认 `Operad Bot`），repo chat 用它；bot chat 用它的 bot 的称呼，没写时用默认值。存下的消息角色仍是 `assistant`（模型在事实和 harness 协议里的角色），只是不显示。
15. **技能可以从一个 git 地址导入，导入和更新都要人确认**（2026-11-11 owner 定，`research/2026-11-11-grok-bot.md`「技能和 MCP」）：不做市场（决定 7），但别家市场里的技能大多是同一种 `SKILL.md` 目录，用户拿地址来就能导入。导入是一个待处理项，展示 `SKILL.md` 全文和文件清单（脚本单独列出），人确认后才进这个 bot 的技能目录；导入的版本钉在一个提交上，不自动更新，更新也是一个待处理项，展示差异。operad 不做搜索和推荐，也不采信市场的扫描结果。`SKILL.md` 头部里别家的私有字段忽略。别家的插件包（技能加 MCP 服务、钩子、子 agent）只导入技能，里面的 MCP 服务按决定 18 单独问，钩子和子 agent 不导入；OpenClaw、Hermes 那种进程内代码的插件不兼容。
16. **技能里的脚本保留，operad 自己永远不执行**：bot 在自己的 shell 里跑它，和跑任何命令一样过访问档。导入来的脚本第一次跑要问（`operad-sandbox.md` 决定 4 的精确 argv 加工作目录，再加脚本内容的摘要：内容变了重新问）；不是人当场发起的运行按 `operad-sandbox.md` 决定 8。不学 Rakazo 导入时丢掉脚本：说明文字本身就能让 bot 去下载并执行代码，防线是访问档，丢脚本挡不住什么，却废掉依赖脚本的技能。壳（`operad-sandbox.md` 决定 7）做出来之前，批准一个带脚本的技能等于信任这段代码，确认页要把这一点和脚本清单写明。
17. **bot 自己写的技能先是待处理项**：bot 写或改一个技能（包括"把刚才的做法存成技能"），人确认后才生效。Rakazo 和 OpenBot 是这样；Hermes 默认直接生效，Grok Bot 的个人 bot 不设卡。
18. **bot 扩展自己一律先问**：加一个 MCP 服务、改自己的设置（称呼、harness、访问档、技能列表）都是待处理项，没人答就不做。照 NanoClaw，不学 Grok Bot（bot 能自己装应用、加 MCP 服务，基本不设卡）。
19. **一个 bot 挂哪些 MCP 服务写在它的设置里**，只有列出的才挂进它的 chat；工具调用的许可按 `operad-sandbox.md` 决定 9，密钥按决定 10。先不做工具的按需加载，装多了再说。登记一个服务时人看到什么、怎么钉版本、浏览器怎么接，见 `operad-bot-mcp.md`。
20. **chat 和 bot 的用户词**（2026-11-11 owner 批，来自 iOS 设计稿 `radian-ios/docs/design/operad/operad-ios-2026-11-11.html`）：`Allow once`、`Always allow`、`Deny`（工具调用和命令的许可，`operad-sandbox.md` 决定 9；`Always allow` 的范围是发起它的 bot 或 repo）；`Continue`（费用上限到了以后继续，决定 12）、`Stop`（停下当前运行）；`I logged in`、`Log in again`（站点登录，`operad-bot-mcp.md` 决定 13、14；`I logged in` 只是提醒 bot 去看，不代替登录）；`Review`（技能和 MCP 服务的导入或更新，决定 15、17、18，在列表上不能直接加，都要先 Review）；`repo`（chat 父对象类型的标签，和 `bot` 并列）；`period`（费用上限的周期）。说话人不是新词：harness 名（claude、pi、radian）只决定用哪个 agent，对话里显示的是决定 14 的称呼。

## 顺序

`operad-conversation`（ask 闭环 → `chat` 基础插件加 `dev:chat` → `bot` 插件的 bot 对象加 `bot:chat` → app 的输入框）→ `operad-sandbox` 第一版的其余部分 → Telegram 通道 → `brain` 三个 flow → `digest`（先 `hn` 和 `rss`，再 `reddit`，`x` 看费用）。

## 待决问题（未定）

1. Reddit 的 OAuth 应用和 X 的付费是否开通；X 不开的话，主题里的 X 来源用什么替代（RSS 代理不稳定）。
2. `digest` 卡上的反应从 Telegram 怎么回来（表情反应还是按钮），和卡片协议（`operad-channels.md` 决定 1–3）怎么对齐。
3. 知识库的自动提交要不要推远端；推的话凭据怎么给（走 `askCommands` 的 `git push`，还是单独授权）。
4. 影子 judge 保留为以后的想法，不在这三个场景里做。
5. （bot 自己写的技能要人确认，见决定 17。）一个 bot 的 skills 目录由谁写：随 operad 装一份默认的 bot `SKILL.md`，还是第一次用时由 bot 自己按用户的描述写出来（`operad.md` 决定 1 的第六个要求）。
6. 费用上限（决定 12）的周期、默认值和设置里的字段名；费用是估算（订阅登录）时上限怎么算。
7. 导入技能（决定 15）的命令和确认页长什么样；技能存在 bot 的目录里还是可以几个 bot 共用一份。

## 验收

用它替掉自己的 OpenClaw 场景：连续两周无人值守，每天的 digest 按时到 Telegram 和 iPhone，知识库里每天多一个 digest 文件；两周内 `brain:capture` 用过至少 20 次，没有一次需要人去修权限或清理副作用；三个 flow 都是在新引擎上用 flow 文件加 skill 表达的，没有改内核。
