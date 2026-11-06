# operad-assistant：个人助理，替掉自己的 OpenClaw 场景

- 状态：decided（场景与形状；第三方来源的接入细节未定）
- 涉及 ADR：0021、0025
- 涉及：`operad-conversation.md`；`operad-sandbox.md`；`operad-channels.md`；`operad-plugins.md`
- 来源：`operad.md`；owner 的使用场景；`research/2026-11-04-agent-autoloop.md`「拿来即用的场景模板」；`research/2026-11-05-noop.md`「决定、门禁、自治」

## 背景

目标不是 OpenClaw 的市场位置，是自己的几个场景：一个长期存在、手机上随时能聊的助理；一个个人知识库；每天定时搜集资料。OpenClaw 赢在"真的做事"加零摩擦，输在默认放任（`operad-sandbox.md`）。operad 要在不放任的前提下做到同样的零摩擦：一句话描述需求，agent 写出 flow 或插件，立刻能用。

## 决定（已定）

1. **三个场景，按这个顺序**：长对话（`operad-conversation.md`）；个人知识库（second brain）；每日资料搜集（digest）。后两个是 flow 加 skill，不是新插件，取数据的步骤除外。
2. **知识库是一个 Markdown 目录**（Obsidian 兼容：frontmatter、`[[链接]]`、一文件一主题），位置由用户定（默认 `~/brain`），用 git 做版本（每天一次自动提交的步骤），回滚免费。没有向量索引：检索靠 agent 用 grep 读原文，文件数到几千再谈索引。它同时是助理的跨对话记忆（`operad-conversation.md` 决定 8）。
3. **知识库是三个 flow 加一个 skill**：
   - `brain:capture`：来自 iOS、Telegram 或命令行的一条"记下"事件（文字、链接、转发），agent 按 skill 归档：选目录、写 frontmatter、补 `[[链接]]`、链接的页面抓正文存成附件；写完回一行"存到哪了"。
   - `brain:review`：每天一次 cron，整理 `inbox/`，合并重复，提出三条值得回看的，送一张卡；卡上的动作只有"看过了"和"打开"。
   - 对话里读写：`brain` skill 随 `chat` 的默认访问档一起给助理，告诉它知识库在哪、怎么写、什么不能删（删除走 ask）。
4. **每日资料搜集是按主题配置的 cron flow** `digest:run`：配置 JSON `{ topic, schedule, sources: [...], deliver: [channel, …] }`，`sources` 的每一项是一种取数步骤：`hn`（免费 API）、`rss`（任意 feed）、`reddit`（要注册 OAuth 应用，每个 client 100 次/分，匿名 `.json` 已经关了）、`x`（只剩按量付费，每读一条 $0.005，默认不开，用不用按费用定）、`web`（给定查询词的搜索）。步骤顺序：取数（纯代码，带作用域密钥，不经过 agent）→ agent 按 skill 去重、排序、写摘要 → 写进知识库 `digests/<日期>-<主题>.md` → 送一张卡（前 N 条，各带链接）。卡上的反应（有用、没用）记成事实，下一天的 prompt 里把最近的反应当资料带上；没有模型替用户改规则。
5. **取数步骤不让 agent 碰密钥，也不让来源内容进指令**：来源内容写成文件给 agent 读（`operad-channels.md` 决定 10、15），密钥只在取数步骤的 HTTP 调用里出现（`operad-sandbox.md` 决定 6）。
6. **通道只做四个**，顺序按 `operad-channels.md` 决定 17：Telegram、WhatsApp、Slack、iMessage。这三个场景的卡和消息走 Telegram 和 iOS。
7. **技能格式**：助理和这些 flow 的 skill 用 Agent Skills 的 `SKILL.md` 格式，和 pi、Claude Code 的技能互通，只读文本、不跑技能里的代码；不做技能市场（`operad-plugins.md` 决定 8）。
8. **不做**：语音、Canvas、摄像头和屏幕一类设备动作、暴露在公网的网关、影子 judge 之外任何"模型替人决定"。

## 顺序

`operad-conversation`（含 iOS 后端）→ `operad-sandbox` 第一版 → Telegram 通道 → `brain` 三个 flow → `digest`（先 `hn` 和 `rss`，再 `reddit`，`x` 看费用）。

## 待决问题（未定）

1. Reddit 的 OAuth 应用和 X 的付费是否开通；X 不开的话，主题里的 X 来源用什么替代（RSS 代理不稳定）。
2. `digest` 卡上的反应从 Telegram 怎么回来（表情反应还是按钮），和卡片协议（`operad-channels.md` 决定 1–3）怎么对齐。
3. 知识库的自动提交要不要推远端；推的话凭据怎么给（走 `askCommands` 的 `git push`，还是单独授权）。
4. 影子 judge 保留为以后的想法，不在这三个场景里做。

## 验收

用它替掉自己的 OpenClaw 场景：连续两周无人值守，每天的 digest 按时到 Telegram 和 iPhone，知识库里每天多一个 digest 文件；两周内 `brain:capture` 用过至少 20 次，没有一次需要人去修权限或清理副作用；三个 flow 都是在新引擎上用 flow 文件加 skill 表达的，没有改内核。
