# operad-chat-next：竞品调研后 chat 还值得做的事

- 状态：proposed（owner 2026-11-15 要求记下；每一条排任务前还要定细节）
- 涉及 ADR：0026、0027、0028（chat）、0030（bot）、0033（Telegram）、0022（harness）、0008（问人）
- 涉及：`operad-chat-commands.md`、`operad-skills.md`、`operad-conversation.md`、`operad-telegram.md`、`operad-channels.md`、`operad-harness.md`、`operad-harness-pi.md`
- 来源：2026-11-15 对 OpenClaw、Hermes Agent、Orca、Conductor、Vibe Kanban、Happy、Paseo、Kimaki、Claude Code Remote Control 和 Channels 的调研

## 背景

调研里已经排上任务的不在这里：失败显示、结尾空窗、Telegram 进度消息、日志计时（P-0074），Codex 走 app-server（P-0075），命令第一批和默认插话（P-0076），skills 和按选择建 bot（P-0077）。这里是剩下的。

## 值得做（按价值排）

1. **任务的结果回到发起它的 chat。** bot 在 chat 里用 operad 的工具建了计划或任务之后，任务做完、卡住、等人确认时，那个 chat 收到一条消息（Telegram 绑定的 chat 也就收到）。今天这些只出现在待处理和任务页。出处：OpenClaw 的子 agent 做完在发起的聊天里报告；Orca 的协调者收到 worker 的完成和提问。要先定：哪些事件回报（等人、结束、转圈）；回报只是显示，还是也进模型的上下文让 bot 接着处理；chat 怎样记住它发起了哪些对象。
2. **pi 的 chat 自动压缩上下文。** pi 的 worker 关掉了压缩（`packages/harness/pi/src/worker.ts`），chat 聊久了会撞上限，每轮也越来越贵。手动的 `/compact` 在命令第二批；这里是自动的一半：到一定比例时压缩，压缩前让 agent 先把要记的写下来（OpenClaw 约 75%，压缩前有一轮静默的记忆落盘）。和 `operad-conversation.md` 待决 5 一起定。落盘那一轮的约束可以照 OpenClaw：只许往当天的每日记录追加，其他文件只读，没东西可记就什么都不写，落盘失败不挡压缩（`research/2026-11-15-memory.md`）。
4. **等人的问题会提醒。** 过了宽限期的问题今天只留在待处理里，没有提醒也不过期（C-0016 的问题挂了三天）。隔一段时间在绑定的通道上再发一次；要不要过期、过期算什么（OpenClaw：30 分钟过期按拒绝）另定，lead 倾向只提醒。
5. **通知只在该响的时候响。** 把"需要你处理"和"做完了"分成两类，人正在某个端上看这个 chat 时不推送（Claude Code Remote Control 的做法）。iOS 推送今天沿用旧通道，不区分。

## 可以做，不急

6. **从 chat 对一个正在跑的任务 worker 说话。** 任务一侧已经支持运行中插话，缺 chat 这边的入口（OpenClaw 把聊天绑到一个 agent 会话）。
7. **Telegram 群。** 群里默认要 @ 才响应，回复 bot 的消息算 @；没被 @ 的消息只作为上下文留着（`operad-telegram.md` 待决 1）。
8. **Telegram 语音消息转成文字。**（Kimaki、Orca）
9. **回到某条消息重来，或从这里分出一个新 chat。**（Orca 的"倒回这里"、OpenClaw 的 `/fork`）
10. **手机离线时消息先存着，连上后按顺序发。**（Orca）
11. **工具调用折叠成卡片。** `operad-conversation.md` 已定未做，需要显示接口有结构化的块。
12. **导入在 operad 之外开的会话**（终端里的 Claude Code、pi）。`operad-conversation.md` 写了第一版不做。（Orca、Happy）
13. **更多 agent**：OpenCode、Gemini CLI、Cursor 走现成的 ACP 客户端（`operad-harness.md` 待决 3）。
15. **chat 记录可以全文搜索。** 给 chat 记录建 SQLite FTS5 的索引，bot 能搜自己过去的对话（Hermes 的 `session_search` 是纯 FTS5，不过模型；Obelisk 用一个 skill 教 agent 现场写查询）。2026-11-15 的记忆调研（`research/2026-11-15-memory.md`）加的：原始记录可搜是 bot 记忆的地基，research consultant 认为它应该排在整理过的笔记之前；排序由 owner 和 lead 定。要先定：谁能搜哪些 chat（一个 bot 只搜自己的），被压缩掉的部分是否仍可搜。

## 不做

共享的主会话；按块分段推送；定时结果发到"最近的聊天"；切回原始终端；可拖动重排的排队卡片；在聊天里改配置、权限、重启。
