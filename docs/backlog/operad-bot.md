# operad-bot：个人助理，替掉自己的 OpenClaw 场景

- 状态：decided（场景与形状已定；已做的决定移入 ADR，本文件留未做的部分；第三方来源的接入细节未定）
- 涉及 ADR：0030、0031、0011、0025、0032
- 涉及：`operad-conversation.md`；`operad-sandbox.md`；`operad-channels.md`；`operad-plugins.md`；`operad-bot-mcp.md`
- 来源：`operad.md`；owner 的使用场景；`research/2026-11-04-agent-autoloop.md`「拿来即用的场景模板」；`research/2026-11-05-noop.md`「决定、门禁、自治」

## 背景

目标不是 OpenClaw 的市场位置，是自己的几个场景：一个长期存在、手机上随时能聊的 bot；一个个人知识库；每天定时搜集资料。OpenClaw 赢在"真的做事"加零摩擦，输在默认放任（`operad-sandbox.md`）。operad 要在不放任的前提下做到同样的零摩擦：一句话描述需求，agent 写出 flow 或插件，立刻能用。

## 已定但还没做（留在这里，做完移入 ADR）

1. **三个场景，按这个顺序**：长对话（`operad-conversation.md`）；个人知识库（second brain）；每日资料搜集（digest）。后两个是 flow 加 skill，不是新插件，取数据的步骤除外。
2. **知识库是一个插件**：它处理信息、归档、找回；存储是可换的后台，用户现有的 Obsidian 库是其中一个（不要求用户改目录结构），Markdown 目录加 git 是另一个。它最关键的两件事是怎么组织、怎么检索；bot 的记忆是它里面的一个保留命名空间。这个插件和记忆的管理以后单独设计，合约上它需要的是外部对象（`operad-contract.md` 决定 3，留在 backlog）、`settings` 和 `secrets`（ADR 0010 D1、D2）。
3. **知识库是三个 flow 加一个 skill**：
   - `brain:capture`：来自 iOS、Telegram 或命令行的一条"记下"事件（文字、链接、转发），agent 按 skill 归档：选目录、写 frontmatter、补 `[[链接]]`、链接的页面抓正文存成附件；写完回一行"存到哪了"。
   - `brain:review`：每天一次 cron，整理 `inbox/`，合并重复，提出三条值得回看的，送一张卡；卡上的动作只有"看过了"和"打开"。
   - 对话里读写：`brain` skill 随 `chat` 的默认访问档一起给 bot，告诉它知识库在哪、怎么写、什么不能删（删除走 ask）。
4. **每日资料搜集是按主题配置的 cron flow** `digest:run`：配置 JSON `{ topic, schedule, sources: [...], deliver: [channel, …] }`，`sources` 的每一项指向一个来源插件（`docs/backlog/operad-channels.md` 的登录与读取一条）：怎么登录、怎么读都归插件，operad 只拿到统一形状的条目。候选插件：`hn`（免费 API）、`rss`（任意 feed）、`reddit`（要注册 OAuth 应用，每个 client 100 次/分，匿名 `.json` 已经关了）、`x`（只剩按量付费，每读一条 $0.005，默认不开，用不用按费用定）、`web`（给定查询词的搜索）。步骤顺序：来源插件的 `fetch` 步骤取条目 → agent 按 skill 去重、排序、写摘要 → 交给知识库插件归档 → 送一张卡（前 N 条，各带链接）。卡上的反应（有用、没用）记成事实，下一天的 prompt 里把最近的反应当资料带上；没有模型替用户改规则。
5. **来源插件不让 agent 碰密钥，也不让来源内容进指令**：条目作为资料给 agent 读（ADR 0009 D1），登录态只在插件自己的 `secrets` 里（ADR 0010 D2）。
6. **不做**：语音、Canvas、摄像头和屏幕一类设备动作、暴露在公网的网关、影子 judge 之外任何"模型替人决定"。按页面结构操作的自动化浏览器不在此列，见 `operad-bot-mcp.md` 决定 10。
7. **费用只做软提示，不硬停**（费用多是估算，订阅登录时尤其如此，按估算硬停不合适）。bot 页显示这个 bot 本期（`period`）的花费，注明是估算；bot 的设置里可以写一个提示线，可不写。本期花费过了提示线，bot 页和这个 bot 的 chat 页显示一行提示，运行照常继续，不成为待处理项，不停下。以后有了准确的费用再议硬停（原来的理由见 `research/2026-11-11-grok-bot.md`）。
8. **不是人当场发起的运行更严**：bot 的定时 flow 和由事件发起的运行按 `docs/backlog/operad-sandbox.md` 的后台运行一条，对外写的动作先问或只存草稿。
9. **技能可以从一个 git 地址导入，导入和更新都要人确认**（`research/2026-11-11-grok-bot.md`「技能和 MCP」）：不做市场，但别家市场里的技能大多是同一种 `SKILL.md` 目录，用户拿地址来就能导入。导入是一个待处理项，展示 `SKILL.md` 全文和文件清单（脚本单独列出），人确认后才进这个 bot 的技能目录；导入的版本钉在一个提交上，不自动更新，更新也是一个待处理项，展示差异。operad 不做搜索和推荐，也不采信市场的扫描结果。`SKILL.md` 头部里别家的私有字段忽略。别家的插件包（技能加 MCP 服务、钩子、子 agent）只导入技能，里面的 MCP 服务按 ADR 0030 D4 单独问，钩子和子 agent 不导入；OpenClaw、Hermes 那种进程内代码的插件不兼容。
10. **技能里的脚本保留，operad 自己永远不执行**（ADR 0030 D7）。还没做的部分：导入来的脚本第一次跑要问（ADR 0025 D3 的精确 argv 加工作目录，再加脚本内容的摘要：内容变了重新问）；不是人当场发起的运行按 `docs/backlog/operad-sandbox.md` 的后台运行一条。不学 Rakazo 导入时丢掉脚本：说明文字本身就能让 bot 去下载并执行代码，防线是访问档，丢脚本挡不住什么，却废掉依赖脚本的技能。壳（ADR 0025 D6）做出来之前，批准一个带脚本的技能等于信任这段代码，确认页要把这一点和脚本清单写明。
11. **chat 和 bot 的用户词**（来自 iOS 设计稿 `radian-ios/docs/design/operad/operad-ios-2026-11-11.html`）：`Allow once`、`Always allow`、`Deny`（工具调用和命令的许可，ADR 0025 D4；`Always allow` 的范围是发起它的 bot 或 repo）；`Continue`（原为费用上限到了以后继续；费用改成软提示后不再用于费用）、`Stop`（停下当前运行）；`I logged in`、`Log in again`（站点登录，`operad-bot-mcp.md` 决定 13、14；`I logged in` 只是提醒 bot 去看，不代替登录）；`repo`（chat 父对象类型的标签，和 `bot` 并列）；`period`（费用的统计周期）。`Review`、`approve`、`reject` 已在 ADR 0030 D4。说话人不是新词：harness 名（claude、pi、radian）只决定用哪个 agent，对话里显示的是 ADR 0026 D12 的称呼。
12. **bot 页是这个 bot 的设置页**：上面是称呼、harness、模型、工作目录、本期花费和上限、技能、MCP 服务、登录过的站点；能直接改的项走设置接口（ADR 0017），技能和 MCP 服务的增加和更新走 `Review`。bot 页上没有 Chat 按钮，新建 chat 只从 chat 的入口进（ADR 0028 D5）。`bot` 不占自己的 tab，bot 列在设置下面（ADR 0018 D3）。

## 顺序

`operad-conversation`（ask 闭环 → `chat` 基础插件加 `dev:chat` → `bot` 插件的 bot 对象加 `bot:chat` → app 的输入框）→ `operad-sandbox` 第一版的其余部分 → Telegram 通道 → `brain` 三个 flow → `digest`（先 `hn` 和 `rss`，再 `reddit`，`x` 看费用）。

## 待决问题（未定）

1. Reddit 的 OAuth 应用和 X 的付费是否开通；X 不开的话，主题里的 X 来源用什么替代（RSS 代理不稳定）。
2. `digest` 卡上的反应从 Telegram 怎么回来（表情反应还是按钮），和卡片协议（`operad-channels.md` 决定 1–3）怎么对齐。
3. 知识库的自动提交要不要推远端；推的话凭据怎么给（走 `askCommands` 的 `git push`，还是单独授权）。
4. 影子 judge 保留为以后的想法，不在这三个场景里做。
5. （bot 自己写的技能要人确认，见 ADR 0030 D4。）一个 bot 的 skills 目录由谁写：随 operad 装一份默认的 bot `SKILL.md`，还是第一次用时由 bot 自己按用户的描述写出来（ADR 0001 D1 的第六个要求）。
6. 费用提示（上文第 7 条）的周期和默认的提示线（建议：按月，默认不设提示线，只显示花费）；设置里的字段名。
7. 导入技能（上文第 9 条）的命令和确认页长什么样；技能存在 bot 的目录里还是可以几个 bot 共用一份。

## 验收

用它替掉自己的 OpenClaw 场景：连续两周无人值守，每天的 digest 按时到 Telegram 和 iPhone，知识库里每天多一个 digest 文件；两周内 `brain:capture` 用过至少 20 次，没有一次需要人去修权限或清理副作用；三个 flow 都是在新引擎上用 flow 文件加 skill 表达的，没有改内核。
