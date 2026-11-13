# operad-harness：一种 harness 一个描述文件，原生 SDK 或 ACP 两种接法

- 状态：idea（方向已定：做；会话记录归属未定）。已定且已做的点进了 ADR。
- 涉及 ADR：0022、0023、0024、0025
- 来源：`operad.md`；`research/2026-11-04-agent-autoloop.md`「接 radian 的可行性」；`research/2026-11-05-noop.md`「架构」；`research/2026-11-06-harness-sdks.md`

## 背景

hub 的会话路由只认 radian 的 journal 和 control port，worker 只有 `radian acp`。目标是一个 operad app 列出并驾驭这台机器上任何 harness 的会话（看记录、跟直播、发消息、答权限和问题、取消），任务也用同一份描述起 harness。Zed 的 agent servers 配置和 bb 的 provider bridge 是会话一侧的先例。

## 已定，尚未做或未核实

1. **ACP 不带的四样由 operad 补**：费用从 token 用量事实按模型价目算；预算由 operad 看着用量断（超了 `session/cancel`）；宿主钩子不要，事实从 `session/update` 流记；operad 的工具以 stdio MCP server 的形式给 ACP 类 harness。能力声明里这四项对 `acp` 接法照实标"operad 侧"。
2. 每个 harness 一张机械禁用表（Claude 是 `disallowedTools`，radian 是 tier，Codex 是 sandbox 策略加 execpolicy）。
3. Claude 的对应关系里没进 ADR 的：`canUseTool` 回调里调 `ctx.ask`；访问档的 deny 清单翻成带范围的 `disallowedTools`（在所有权限模式下都拒）；operad 的工具以 stdio MCP server 给（`mcpServers`，启动 `@operad-io/mcp` 的 `stdio.ts`）；`createSdkMcpServer` 要 `zod` 作直接依赖，目前没有任务要求加；`maxBudgetUsd`、`maxTurns`、`abortController` 做上限和取消；`includePartialMessages` 打开，逐字增量按 `operad-conversation.md` 决定 25 走日志行，不落盘。许可：Anthropic 不允许第三方产品提供 claude.ai 登录或配额；operad 作为产品发出去时只能 API key。
4. `sdk` 接法的版本耦合里没进 ADR 的：本体有版本下限（已在 ADR 0022 D6、0023 D9、0024 D2）。

## 待决问题（未定）

1. （chat 一侧已定，见 `operad-conversation.md` 决定 23：operad 自己记一份给人看的条目记录，所有 harness 一个形状；agent 的会话文件只用于续接。任务一侧的 worker 记录仍在步骤日志里，未定。）会话记录归谁：引擎自己把每个会话的事件流落盘，所有 harness 一个形状；或者每个接法负责历史（`session/load` 的重放、SDK 的 `resume`）。
2. 会话续接：引擎重启、手机离线、机器睡眠后各 harness 怎么接回；`session/load` 哪些真支持（ACP v2 草案才有带重放的 `session/resume`）。
3. 契约里每项的来源（续接、用量、对话视图、取消、工具集限制、权限模式）对 Codex、Gemini CLI、opencode、Cursor 逐个核实；不通过的项在该 harness 上降级，iOS 显示随之变少，要写明。Claude 和 pi 的清单已核（`research/2026-11-06-harness-sdks.md`）。

## 验收

iOS app 列出并驾驭一个 Claude 会话：看记录、跟直播、发消息、在手机上答一次权限请求；加第三个类型（Codex 或 Gemini CLI）只写描述文件；同一份 `claude` 描述把一个任务从创建跑到 `review.awaiting_human` 并续接一次；一个 `acp` 接法的 harness 在预算用尽时被 operad 取消并在历史里留下用量。
