# operad-harness：一种 harness 一个描述文件，原生 SDK 或 ACP 两种接法

- 状态：idea（方向已定：做；会话记录归属未定）
- 涉及 ADR：0049、0024、0043
- 来源：`operad.md`；`research/2026-11-04-agent-autoloop.md`「接 radian 的可行性」；`research/2026-11-05-noop.md`「架构」；`research/2026-11-06-harness-sdks.md`

## 背景

hub 的会话路由只认 radian 的 journal 和 control port，worker 只有 `radian acp`。目标是一个 operad app 列出并驾驭这台机器上任何 harness 的会话（看记录、跟直播、发消息、答权限和问题、取消），任务也用同一份描述起 harness。Zed 的 agent servers 配置和 bb 的 provider bridge 是会话一侧的先例。

各家 harness 对外的程序接口不一样（`research/2026-11-06-harness-sdks.md`）：Claude 有一个把续接、权限回调、工具限制、钩子、进程内 MCP、预算都放在一起的 Agent SDK；Codex 的 SDK 只能设策略，真正的接口是 app-server 的 JSON-RPC，ACP 适配器就建在它上面；Gemini 没有发布的 SDK，只有 `--acp` 和 `-p`；pi 是进程内库。统一只能统一在 operad 这一侧。

## 决定（已定）

1. **harness 插件接口是 operad 自己的**：一种 harness 一个描述文件，内容是名字、启动方式、接法（`sdk` 或 `acp`）、能力声明（续接、用量、工具集限制、权限模式、对话视图、取消）。任务一次性跑和会话交互跑用同一份；加新类型只写这个文件加接法代码，`operad plugin check` 跑一遍 harness 契约。iOS 看到的会话、待处理、回答都是 operad 的对象，不是任何一家协议的对象。
2. **两种参考接法**。`sdk`：harness 的官方库在 operad 进程内当客户端，agent 仍是子进程。`acp`：ACP 客户端（`session/new`、`session/load`、`session/prompt`、`session/cancel`、`session/update` 流、`request_permission`），一份代码接所有有 ACP 入口的 harness。两种接法对上面的能力声明给出同一组事实。
3. **各家的接法**：
   - Claude 走 `@anthropic-ai/claude-agent-sdk`，`sdk` 接法。原生二进制随包装，子进程用 stream-json 控制协议，`executable: 'bun'`。对应关系：`resume` 就是合约的 `resumeSession`；`canUseTool` 回调里调 `ctx.ask`；访问档的 deny 清单翻成带范围的 `disallowedTools`（在所有权限模式下都拒）；`settingSources: []` 不读用户的 `~/.claude`；operad 的工具以 stdio MCP server 给（`mcpServers`，启动 `@operad-io/mcp` 的 `stdio.ts`）；`createSdkMcpServer` 要 `zod` 作直接依赖，目前没有任务要求加（2026-11-10，T-0188）；`maxBudgetUsd`、`maxTurns`、`abortController` 做上限和取消；`includePartialMessages` 打开，逐字增量按 `operad-conversation.md` 决定 25 走日志行，不落盘。许可：Anthropic 不允许第三方产品提供 claude.ai 登录或配额；owner 自己的订阅跑自己的工具不在此列，operad 作为产品发出去时只能 API key。界面上叫 `claude`，不叫 "Claude Code"。
   - pi 走 `@earendil-works/pi-coding-agent`，`sdk` 接法，进程内库，装在一个 Bun 子进程里；权限门是扩展的 `tool_call` 钩子（async，可 block），`customTools` 进程内。pi 是第二种 harness，形状、第一版范围和任务切分在 `operad-harness-pi.md`。Claude 是第三种，照 pi 的形状，见 `operad-harness-claude.md`。
   - radian 走 `radian acp`；Codex 走 `@agentclientprotocol/codex-acp`（建在 `codex app-server` 上，审批、续接、中断、token 用量都有；`codex mcp-server` 已删除）；Gemini CLI 走 `gemini --acp`；opencode、Cursor、Kimi 走各自的 ACP 入口。都是 `acp` 接法。
4. **ACP 不带的四样由 operad 补**：费用从 token 用量事实按模型价目算；预算由 operad 看着用量断（超了 `session/cancel`）；宿主钩子不要，事实从 `session/update` 流记；operad 的工具以 stdio MCP server 的形式给 ACP 类 harness。能力声明里这四项对 `acp` 接法照实标"operad 侧"。
5. 任务的 command 适配器保留为兜底（提示词进、最后一条消息出，回执在消息末尾的 JSON 代码块），给只能一次性跑、不能交互的工具；它没有会话面。回执至少含 `done` | `nothing` | `failed` | `needs_decision` | `waiting`，`waiting` 带 `wait_check`。
6. 权限请求（ACP 的 `request_permission`、SDK 的 `canUseTool`）由引擎按 graph 给的 access 档回答，或转给手机上的人；harness 碰不到权限决定。每个 harness 一张机械禁用表（Claude 是 `disallowedTools`，radian 是 tier，Codex 是 sandbox 策略加 execpolicy），owner 批准只对该运行解锁一次。
7. **radian 在 operad 里只当 agent 用。** `harness-radian` 只调用 `radian exec` 和 `radian acp`；operad 不调用、不启动、不依赖 `radian hub` 和 `radian arc`，`dev` 插件不读也不写仓库里的 `.radian/arc/`。编排（计划、任务、门禁、合并、推送）只在 operad 里。目前这是 operad 一侧的约定，radian 二进制里仍带着这两个子命令；以后 radian 会去掉编排功能，operad 不需要为此改动。
8. **harness 本体不随 operad 装，用用户装的那份。** radian 本来就是 PATH 上的命令；pi 从 PATH 上的 `pi` 找到它的库再 `import()`；Claude 从 PATH 上的 `claude` 起进程，operad 只带 Agent SDK 的客户端代码，八个平台二进制包用 `overrides` 换成空包。理由：登录态、自动更新、配额都属于用户装的那份，operad 不替用户再下一份几百 MB 的二进制，也不替用户登录。`sdk` 接法的版本耦合由此定形：operad 带的客户端库不钉版本，`package.json` 写范围，lock 记当下测过的那一版，`bun update` 往前挪；本体有版本下限；`operad plugin check` 报两边版本，只有本体太旧或没登录才拒绝。落实见 `operad-harness-pi.md` 决定 9 和 `operad-harness-claude.md` 决定 2、10。
9. **harness 的名字就是它接的 agent 的名字（2026-11-11 owner 定）。** 插件名是 `claude`、`pi`、`radian`：`config.json` 的 `plugins.<名字>`、步骤 `claude/agent`、流程 `claude:prompt`、`dev.json` 的 `worker.use`、chat 存的 harness 都用这个名字，界面上也只显示它；`harness-claude` 一类的写法只是 npm 包名（`@operad-io/harness-claude`，不变），用户看不到。包放在 `packages/harness/` 下：`claude`、`pi`、`radian`、`process`。旧名字不再认，不留别名：用过它们的只有 owner 的家目录和三个仓库，改名时一次迁好。下面各项和 `operad-harness-pi.md`、`operad-harness-claude.md`、`operad-plugins.md` 里写的 `harness-*` 插件名、步骤名按此读。
10. **codex harness**（2026-11-12 owner 定，来自 tkrs 出图的需求）：插件名 `codex`，包 `@operad-io/harness-codex`，步骤 `codex/agent`，接法 `acp`（决定 3）：启动用户装的 `codex-acp`（arc 用的是 codex-acp 2.2.2），默认命令用 PATH 上的 `bun` 运行 PATH 上的 `codex-acp`，因为它的 `#!/usr/bin/env node` 只在 fnm 的 shell 里找得到 node；设置 `command` 可改。凭据是用户本机 Codex 的 ChatGPT 登录，operad 不碰（决定 8）。模型能直接用 Codex 自带的 image_gen。
    - 用量：订阅登录算不出钱，费用记为未知，不挡预算检查；每次 attempt 记 image_gen 调用次数（额度按出图次数算）；每次工具调用照 `session/update` 流记进步骤日志，返工时能查。
    - 时间：一次 image_gen 几分钟没有输出，是正常的；按 worker 的 `stallSecs`、`wallTimeSecs` 设（tkrs 的出图 worker 设 stall 够长，wall 约 2 小时），harness 不另算卡住。
    - 沙箱：codex 自己的沙箱写不了 `.git`，所以出图 flow 的 work stage 用 `commit`（`operad-dev-flows.md` 决定 9）；它要能联网、能写任务的工作目录。

## 待决问题（未定）

1. （chat 一侧已定，见 `operad-conversation.md` 决定 23：operad 自己记一份给人看的条目记录，所有 harness 一个形状；agent 的会话文件只用于续接。任务一侧的 worker 记录仍在步骤日志里，未定。）会话记录归谁：引擎自己把每个会话的事件流落盘，所有 harness 一个形状；或者每个接法负责历史（`session/load` 的重放、SDK 的 `resume`）。
2. 会话续接：引擎重启、手机离线、机器睡眠后各 harness 怎么接回；`session/load` 哪些真支持（ACP v2 草案才有带重放的 `session/resume`）。
3. 契约里每项的来源（续接、用量、对话视图、取消、工具集限制、权限模式）对 Codex、Gemini CLI、opencode、Cursor 逐个核实；不通过的项在该 harness 上降级，iOS 显示随之变少，要写明。Claude 和 pi 的清单已核（`research/2026-11-06-harness-sdks.md`）。

## 验收

iOS app 列出并驾驭一个 Claude 会话：看记录、跟直播、发消息、在手机上答一次权限请求；加第三个类型（Codex 或 Gemini CLI）只写描述文件；同一份 `claude` 描述把一个任务从创建跑到 `review.awaiting_human` 并续接一次；一个 `acp` 接法的 harness 在预算用尽时被 operad 取消并在历史里留下用量。
