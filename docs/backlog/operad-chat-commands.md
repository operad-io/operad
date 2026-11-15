# operad-chat-commands：chat 里的 `/` 命令

- 状态：decided（命令机制和第一批的 `/model`、`/effort`、`/close`、`/help`、`/stop`、`/retry`、`/status` 已落地；第二批和待决问题见文末）
- 涉及 ADR：0013（动作）、0026、0027、0028（chat）、0033（Telegram）、0037（chat 命令）
- 涉及：`operad-conversation.md`（待决 5：上下文费用）、`operad-telegram.md`、`operad-bot.md`（待决 5、7：skills）
- 来源：2026-11-15 对 OpenClaw、Hermes Agent、Orca、Conductor、Vibe Kanban、Kimaki 的调研和 owner 的讨论

## 背景

命令就是动作、命令不进模型、结果在 chat 里留一行，已经落地（ADR 0037）：`/model`、`/effort`、`/close`、`/help`、`/stop`、`/retry`、`/status` 可用，`/usr/local 是什么` 这样的消息照常送给模型。运行中发来的普通消息的插话，以及第二批尚未做。

对手的共同做法：命令由宿主执行、不进模型；一份命令表生成各端的菜单；命令集小；运行中有停止和插话。

## 决定

（决定 1 至 4、`/help` 与决定 5 的 `/status` 已落地，见 ADR 0037。）

6. **第二批**：`/new`（从这里重新开始一个会话，记录留着）、`/compact`（压缩上下文）、`/btw`（旁问：用当前上下文回答，不打断正在写的回复，不进记录）、`/name`（改标题）、bot 的 skills 成为 `/名字`。
7. **只在 Telegram**：`/whoami`（显示发送者的 id，配名单用）；显示工具调用和 thinking 的开关，等进度消息（T-0488）做完再定形式。
8. **只在仓库 chat**：`/diff`（这个 chat 的 worktree 里改了什么）。
9. **不做**：聊天里改配置、权限、名单、插件，重启，跑 shell，子 agent 管理，把外部 agent 绑到当前聊天。这些归命令行和设置页。
10. **Telegram**：命令名只用小写字母、数字、下划线；启动时注册成菜单；有选项的参数没给时回一排按钮；只有名单里的人能执行。
11. **用词（owner 批准）**：stop、status、help、retry、new、compact、btw、name、whoami、diff。model、effort、close 是已有的词。
12. **运行中发来的普通消息默认插话**（owner 2026-11-15）：插进正在写的这一轮，在当前这批工具调用之后送给 agent，不中断、不另起一轮；不加 `/steer` 这个词。不能插话的 agent（radian）照旧排到下一轮。要打断用 `/stop`。

## 待决问题

1. bot 的 `skills` 现在是否真的到了 agent 手里（`chat:reply` 传了参数，harness 一侧没找到读它的地方）。决定 6 的 skills 一项以它为前提。
2. agent 自己上报的命令（Claude Agent SDK 的 `supportedCommands()`、ACP 的 `available_commands_update`）要不要出现在 `/` 菜单里。今天 chat 与用户自己的配置隔离，列表是空的；ADR 0027 D2 写了不记录"可用命令"。
3. 带短 id 的文字审批兜底（Telegram 上按钮不可用时回 `allow <id>`），和 `operad-channels.md` 的卡片协议一起定。

