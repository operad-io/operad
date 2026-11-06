# operad-harness：任务和会话都走 ACP，一种 harness 一个描述文件

- 状态：idea（方向已定：做；会话记录归属与 pi 的接法未定）
- 涉及 ADR：0049、0024、0043
- 来源：`operad.md`；`research/2026-11-04-agent-autoloop.md`「接 radian 的可行性」；`research/2026-11-05-noop.md`「架构」

## 背景

hub 的会话路由只认 radian 的 journal 和 control port，worker 只有 `radian acp`。目标是一个 arc app 列出并驾驭这台机器上任何 harness 的会话（看记录、跟直播、发消息、答权限和问题、取消），任务也用同一份描述起 harness。Zed 的 agent servers 配置和 bb 的 provider bridge 是会话一侧的先例。

## 决定（已定）

1. 会话的统一协议是 ACP：`session/new`、`session/load`、`session/prompt`、`session/cancel`、`session/update` 流、`request_permission`。hub 是每个 harness 的 ACP 客户端；iOS 看到的会话、`pending`、回答都是 ACP 的对象。
2. 一种 harness 是一个描述文件：名字、启动命令、协议（`acp` 或某个桥）、能力声明（续接、用量、工具集限制、权限模式、对话视图）。任务一次性跑和会话交互跑用同一份；加新类型只写这个文件，`operad plugin check` 跑一遍 ACP 契约。
3. radian 走 `radian acp`；Codex 和 Gemini CLI 走各自的 ACP 入口；Claude Code 走已有的 ACP 适配器；没有 ACP 的（pi 一类）用一个桥进程翻译成 ACP。
4. 任务的 command 适配器保留为兜底（提示词进、最后一条消息出，回执在消息末尾的 JSON 代码块），给只能一次性跑、不能交互的工具；它没有会话面。回执至少含 `done` | `nothing` | `failed` | `needs_decision` | `waiting`，`waiting` 带 `wait_check`。
5. ACP 的 `request_permission` 由引擎按 graph 给的 access 档回答，或转给手机上的人；harness 碰不到权限决定。每个 harness 一张机械禁用表（Claude Code 是 `--disallowedTools`，radian 是 tier），owner 批准只对该运行解锁一次。

## 待决问题（未定）

1. 会话记录归谁：hub 自己把每个会话的 `session/update` 流落盘，所有 harness 一个形状；或者每个桥负责历史（`session/load` 的重放）。
2. 会话续接：hub 重启、手机离线、机器睡眠后各 harness 怎么接回；`session/load` 哪些真支持。
3. pi 的接法：有没有 ACP 入口，没有就写桥；桥放哪、怎么分发。
4. 契约里每项的来源（续接、用量、对话视图、取消、工具集限制、权限模式）对 Claude Code、Codex、Gemini CLI、pi 逐个核实；不通过的项在该 harness 上降级，iOS 显示随之变少，要写明。
5. Claude Code 的 ACP 适配器丢掉的东西（工具调用细节、权限请求、续接）多到手机上不可用时，是否写自己的桥。

## 验收

iOS app 列出并驾驭一个 Claude Code 会话：看记录、跟直播、发消息、在手机上答一次权限请求；加第三个类型（Codex 或 Gemini CLI）只写描述文件；同一份 `claude` 描述把一个任务从创建跑到 `review.awaiting_human` 并续接一次。
