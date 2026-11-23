# operad-long-chat：长对话和 Routines，让 chat 不再越来越多

- 状态：proposed（owner 2026-11-23 的讨论；"已定"一节是 owner 当场定的，"做法"一节的细节是提议）
- 涉及 ADR：0026（chat，D3、D11、D16、D18）、0028（D10 默认入口）、0030（D10 定时、D11 提议、D13 夜间整理）、0033（Telegram，D5）、0037（chat 命令）、0023（pi，压缩）、0015（层级）、0018（创建的对象）
- 涉及：`operad-chat-commands.md`（第二批 `/new`）、`operad-chat-next.md`（第 1、4 条）、`operad-conversation.md`（待决 3、5）、`operad-telegram.md`（待决 1）、`operad-desktop.md`
- 来源：owner 2026-11-23 "现在 chat 太多了"；Claude Duet 的公开资料和评测；OpenClaw 的会话文档（session、compaction、session-pruning、cron-jobs）；`docs/research/2026-11-19-pi-durable.md`；`docs/research/2026-11-15-memory.md`

## 背景

两周 42 个 chat，2026-11-23 有 14 个 open。来源有三个：

- 定时任务每次触发新开一个 chat（ADR 0030 D10），open 的里面 8 个是这种（7 个定时、1 个 Memory tidy），每天约 4 个。
- 客户端没选 chat 时在默认 bot 上新开（ADR 0028 D10），每问一件事多一个。
- 没有任何东西会自动收起（`operad-conversation.md` 待决 3）。

调研的结论：

- **Claude Duet**：默认一个持续的线程。有用户说单线"撑了大约两周"就乱了，补救是按主题的频道加任务列表；后台运行只在需要注意时才发消息。所以长对话不能是唯一形态，定时的结果不该各占一个对话。
- **OpenClaw**：私聊默认共用一个滚动的主会话；自动翻篇（按天、按空闲）是可选的，默认关，长度靠压缩；修剪旧工具结果和压缩是两件事，修剪等提示缓存过期后才做；定时运行默认是用完即弃的独立会话，结果靠送达回到聊天，无事可报不送达；30 天不活动的会话归档，定时这类会话直接清。
- **pi-durable**：解决的是一次回复跨崩溃续跑，和 chat 数量无关，11 月 19 日"先不用"的结论不变。

## 已定（owner 2026-11-23）

1. **定时的运行不是 chat。** 它不进 chat 列表，不占 chat 的编号。
2. **侧边栏新开一栏 Routines。** 定时的东西有自己的入口。
3. **用词：Routine 替换 Scheduled。** 英文统一 Routine / Routines；"Run now / 立即运行"不变。
4. **Memory tidy 改名 Dreaming，中文"梦境整理"。** 只改用户看得到的文字；代码里的 `tidy`、设置键 `tidyTime` 和文件名不动。它是 Routines 里的一条内置项。
5. **Telegram 绑定的 chat 是默认 bot 的主 chat。** 客户端没选 chat 时回到 bot 最近的 chat，新开变成显式操作（改 ADR 0028 D10）。
6. **多话题这一轮不做**（Telegram 话题、一个 bot 多条线）。
7. **侧边栏里 Routines 是一项**，和待处理、运行中、知识库平级；点它在中栏显示 routine 列表，和待处理、运行中一致（owner 2026-11-23 改定）。列表平铺，每行带 bot 名，不按 bot 分组。
8. **Routine 的中文继续用"定时任务"。**
9. **有内容的结果送进 bot 的主 chat，追问在主 chat 里进行。**
10. **天数**：routine 的运行历史保留 30 天；没绑通道的 chat 闲置 7 天自动关闭，绑定通道的不参与。
11. **现有的定时 chat 和 Memory tidy 的 chat 在改完时一次性关闭。**
12. **仓库 chat 不合并成长 chat**，一件事一个 chat 照旧。

## 做法（细节是提议，拆任务时定）

**Routine 是对象**

- Routine 是 `bot` 插件的一个对象类型，父对象是所属的 bot。今天它只是 bot 对象上的字段，侧边栏列不出来。
- 每次运行是它的历史。行上显示名字、下次运行时间、上次结果（成功、无事可报、失败）。
- 新建、修改、暂停、立即运行从 routine 自己的页面做。bot 写的 routine 仍是提议（ADR 0030 D11）。
- 梦境整理保留"先出待处理卡片、等 Run 或 Skip"的开关。
- 实现上倾向复用 chat 的回复和过程记录机制，但界面上完全看不出它是 chat；拆任务时读代码再定。

**结果送达**

- 有内容的结果作为一条消息送进 bot 的主 chat，绑定的 Telegram 也收到；取代单独的通知命令。
- 无事可报的不送达，只在 routine 的历史里留一行。失败总是送达。
- 送达的结果进主 chat 的模型上下文但不触发回复：搭在下一条消息上带给模型（和 ADR 0026 D18 的记忆笔记同一个做法）。追问在主 chat 里进行，不再能在那次运行里接着聊。
- 这和 `operad-chat-next.md` 第 1 条（任务的结果回到发起它的 chat）是同一套机制。

**长 chat 的前置**

- `/new`：同一个 chat 开新会话，记录保留；自动进 Telegram 的命令菜单。
- pi 自动压缩和压缩前一轮静默的记忆落盘、`/compact`：已做（ADR 0023 D12、0037 D12）。
- 修剪旧工具结果：等提示缓存过期后再做，pi 先做。pi 已做（T-0767，ADR 0023 D13）：用 pi 的 `context` 钩子，缓存过期且至少能腾出 20,000 字符才修剪；Claude 和 codex 没做。
- 自动翻篇（按天、按空闲）：这一轮不做；以后做成 bot 的设置，默认关。

**清理**

- 没绑通道的 chat 闲置 7 天自动关闭；绑定通道的 chat 不参与，否则下一条消息又开一个新的。
- Routine 的运行历史保留 30 天；routine 上的最近三次结果摘要照旧。
- 现有的定时 chat 和 Memory tidy 的 chat 在改完时一次性关闭。

## 顺序

前两项互不依赖，可以并行：

1. `/new`。
2. 修剪旧工具结果（pi 自动压缩和压缩前落盘已做）。
3. Routine 对象、历史和结果送达；改名 Dreaming / 梦境整理。
   - 已落地（T-0768，见 ADR 0030 D10、D13）：Routine 对象（父对象是 bot，行、页面、历史里每次运行的过程和结果、页面上的操作）、运行不是 chat（`R-` 编号，不进 chat 列表）、Dreaming 作为内置 Routine、改名、30 天历史、现有定时 chat 一次性关闭。`bot:schedule-*` 和 `bot schedule` 保留旧名。
   - 已落地（T-0770，见 ADR 0030 D10、0026 D19）：有内容的结果作为一条带 `Routine · 名字` 标题的消息送进主 chat（绑定 Telegram 的 chat 优先，否则最近的 chat；规则是 `mainChatOf`），绑定的 Telegram 也收到；无事可报不送达，失败总是送达；不触发回复，下一条消息只带结果的摘要，完整记录按需用工具读；routine 不再走 `notify` 命令。
4. 客户端：服务端给出"bot 最近的 chat"，再改桌面、iOS 和 `operad` 命令的默认入口；桌面和 iOS 的侧边栏加 Routines。
5. 闲置自动关闭和运行历史的清理。

## 待决问题（未定）

1. Telegram 的 bot 私聊支持话题（Bot API 9.3 起，9.4 起 bot 可建话题，见 `docs/research/2026-11-23-long-chat.md`）；多话题这一轮仍不做。
2. 自动翻篇（按天、按空闲）这一轮不做，以后是否做成 bot 的设置。

## 新的用户可见词

- **Routine / Routines**（owner 2026-11-23 批准，替换 Scheduled）。中文"定时任务"不变。
- **Dreaming / 梦境整理**（owner 2026-11-23 批准，替换 Memory tidy）。

## 分段（owner 2026-11-23，T-0775，服务端已落地）

`/new` 和压缩各开一段；transcript 在每段开头标出标题和日期（不编号）；可从某段、某天、某条消息读起；可在一个 chat 里搜索。规则写在 ADR 0026 D22 和 0038 D9。标题由第一轮问答之后用 harness 的后台模型生成，`/new` 带目标时用目标。桌面和 iOS 的按段跳转、按日期跳转、聊天内搜索各有自己的任务。没有新的用户可见词（owner 2026-11-23：分隔线只显示标题和日期；`segment:<n>` 只是内部的游标值）。
