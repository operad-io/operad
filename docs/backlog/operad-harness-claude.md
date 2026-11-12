# operad-harness-claude：第三种 harness，Claude 走 Agent SDK 的客户端，二进制和登录都是用户装的那份

- 状态：decided（接法、二进制来源、凭据、第一版范围已定；问人一段等合约决定 6 落地）
- 涉及 ADR：0049、0024
- 涉及：`operad-harness.md` 决定 1 到 3、6、8；`operad-harness-pi.md` 决定 2、5、7、8；`operad-contract.md` 决定 6、8、12；`operad-sandbox.md` 决定 1 到 4
- 来源：`research/2026-11-06-harness-sdks.md`「Claude」；`@anthropic-ai/claude-agent-sdk` 0.3.319 的 `sdk.d.ts`；Agent SDK 概览页和 Claude Code 的 Authentication 页；本机实测（下面逐条标了）

## 背景

`harness-pi` 落地后，harness 的形状定型了：hub 一侧一个 `agent` 步骤起子进程，子进程 stdin 一份 JSON、stdout 逐行事件、最后一行 Result，访问档在工具调用前由 `access-match` 判，一次性许可走 `grant_use`/`grant_ack`。Claude 照这个形状接，差别只在子进程里装的是 Agent SDK 的客户端，而 SDK 再起一个 Claude Code 进程。

核实过的事实（SDK 0.3.319，Claude Code 2.1.319）：

- SDK 包本身是客户端代码（4.9 MB，另带 `@anthropic-ai/sdk` 25 MB 做类型），Claude Code 二进制在八个按平台的 `optionalDependencies` 里（本机那份 317 MB）。`pathToClaudeCodeExecutable` 指向用户自己的 `claude` 时不需要平台包；用 `overrides` 把八个平台包换成 `empty-npm-package`，`bun install --frozen-lockfile` 之后仍是空包，SDK 照常工作（实测）。
- **订阅直接可用。** 用户装的 `claude` 的登录在 macOS Keychain（Linux 在 `~/.claude/.credentials.json`），SDK 起的进程读同一份。实测：零 token 探针（`initializationResult()`、`accountInfo()`）报 subscriptionType "Claude Max"、apiProvider firstParty；一次真实请求 `apiKeySource: none` 跑通，result 带 `total_cost_usd`，那是按 API 价目估的数，订阅不按它收费。
- 无浏览器的机器：`claude setup-token` 生成一年期 OAuth token，放 `CLAUDE_CODE_OAUTH_TOKEN`，文档原话 "This token authenticates with your Claude subscription"，给 CI 和脚本用；bare mode 不读它。
- 政策，Agent SDK 概览页原话："Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK." 品牌：可以叫 "Claude Agent" 或 "Claude"，不能叫 "Claude Code"。
- `CLAUDE_CONFIG_DIR` 换目录时 Keychain 登录项也按目录分，所以不能用它隔离会话文件而保留登录。SDK 的会话文件写在用户的 `~/.claude/projects/<cwd 的 slug>/` 下，`session_id` 是 UUID。
- `permissionMode` 不给时默认是 `auto`，一个分类器自己批工具调用；要人工答必须显式 `'default'` 加 `canUseTool`。`canUseTool(toolName, input, { signal, suggestions })` 回 `{ behavior: 'allow', updatedInput? }` 或 `{ behavior: 'deny', message, interrupt? }`。
- result 消息：`usage`（`input_tokens`、`output_tokens`、`cache_read_input_tokens`、`cache_creation_input_tokens`）、`total_cost_usd`、`num_turns`、`is_error`、`permission_denials`、`session_id`、`result`（最后一条文本）、`modelUsage`。流里另有 `rate_limit_event`（`rateLimitType` 是 `five_hour`、`seven_day` 等）。
- 钩子有 `PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`PermissionDenied` 等；`settingSources: []` 不读 `~/.claude` 和项目的设置，也不读 CLAUDE.md；`resume: <uuid>`、`forkSession`、`maxTurns`、`maxBudgetUsd`、`abortController`、`stderr` 回调、`executable: 'bun'`。

## 决定（已定）

1. **Claude 是 operad 的第三种 harness，`sdk` 接法**，包名 `@operad-io/harness-claude`，步骤 `harness-claude/agent`，流程 `harness-claude:prompt`（2026-11-11 改名：插件名 `claude`，步骤 `claude/agent`，流程 `claude:prompt`，见 `operad-harness.md` 决定 9）。参数、结果名、事实形状和 `harness-pi` 完全一样；`args` 读 `--model <名字>` 和 `--effort <low|medium|high|xhigh|max>`，其余条目按 `harness-pi` 的规则拒绝。界面和文档里叫 `claude`，不叫 "Claude Code"。
2. **两层子进程，二进制是用户装的。** hub 起 `bun worker.ts`；`worker.ts` import SDK，SDK 用 `pathToClaudeCodeExecutable` 起 PATH 上的 `claude`（设置 `command` 可改，和 `harness-radian` 一样）。operad 不自带 Claude Code：`package.json` 的 `overrides` 把八个 `@anthropic-ai/claude-agent-sdk-<平台>` 包换成 `empty-npm-package`，SDK 客户端写范围（`^0.3.319`），不钉精确版本。`operad plugin check` 跑 `claude --version` 和 `claude auth status`，报 Claude Code 版本、SDK 版本、登录方式；Claude Code 低于 worker 写时的版本下限（现在 2.1.319）或没登录时拒绝并说出来，SDK 版本只报不拒。
3. **凭据就是用户自己的 claude 登录，operad 什么都不传。** 订阅登录在 Keychain，SDK 起的进程自己读。无浏览器的机器由用户把 `claude setup-token` 的结果放进环境里的 `CLAUDE_CODE_OAUTH_TOKEN`，worker 原样透传。等合约决定 11 的 `ctx.secrets` 进了 `StepContext`，API key 走 `env: { ANTHROPIC_API_KEY }` 这条路，不换接法。政策：用户用自己的订阅跑自己的工具；operad 作为产品发给别人时不替用户做 claude.ai 登录，只走 API key。这一句写进用户文档。
4. **子进程里的 Claude 不做发现**：`settingSources: []`，`permissionMode: 'default'` 显式给（不接受默认的 `auto` 分类器），`permissionPrompts: 'host'`，`canUseTool` 是唯一的权限面；系统提示用 SDK 自带的 `claude_code` 预设，不追加；工具集用 SDK 的默认集，operad 自己的工具第一版不接；不加载插件、技能、钩子文件。opencode 关掉自动记忆等的那串环境变量逐个核对现版本还认不认，认的照抄。
5. **会话文件留在用户的 `~/.claude/projects/`。** 这是决定 3 的后果：换 `CLAUDE_CONFIG_DIR` 就丢登录。`sessionId` 是 SDK 的 `session_id`，续接给 `resume`；用户自己的 `claude --resume <id>` 能接上同一个会话。和 pi 相反，不另设会话目录。
6. **访问档在 `canUseTool` 里判**，`enforces: ["denyPaths", "denyCommands"]`。工具名先映射（`Bash` 到 `bash`，`Read`、`Write`、`Edit`、`Glob`、`Grep` 到小写，`input.command` 和 `input.file_path` 照 `access-match` 已认的字段），再调同一个 `match()`；拒绝回 `{ behavior: 'deny', message }`，日志记一条 `blocked`。一次性许可和 `harness-pi` 一字不差：`findGrant` 命中后写 `grant_use`，等 `grant_ack`，`used: true` 才放行。`askCommands` 不在 `enforces` 里。
7. **事实的来源**：`usage` 从 result 的四个计数来，`cache_creation_input_tokens` 对应 `cache_write`；`cost.micros` 是 `total_cost_usd` 乘一百万取整，登录是订阅时（`accountInfo().subscriptionType` 有值）质量标 `estimated`，API key 时标 `exact`；`finalMessage` 是 result 的 `result`；`model` 是步骤的 `--model`，没有就取 `modelUsage` 的第一个键；日志行是 `PreToolUse`、`PostToolUse` 钩子写的 `tool_execution_start`、`tool_execution_end`（停滞逻辑不改）和 `tool_output`，流事件写的 `text_delta`、`thinking_delta`，assistant 消息写的 `text_end`、`thinking_end`（`operad-conversation.md` 决定 25），加 `message_end`（每条 assistant 消息）、`blocked`、`result`；`rate_limit_event` 转成 `modelError`，`kind` 是 `usage_limit`，`message` 带 `rateLimitType`；result 的 `is_error` 为真时步骤 `failed`，reason `model_error`。
8. **取消和上限**：SIGTERM 到 worker 就 `abortController.abort()`，写 `cancelled` 的 Result，退出码 143。设置 `maxTurns`（默认不限）和 `budgetUsd`（默认不设，给 API key 用户）翻成 SDK 的 `maxTurns`、`maxBudgetUsd`。
9. **问人一段随合约决定 6 一起来**，形状同 `operad-harness-pi.md` 决定 8：`canUseTool` 是 async 的，到时在里面 `await ctx.ask(...)`。
10. **版本**：SDK 客户端不钉版本，`package.json` 写 `^0.3.319`，bun.lock 记当下测过的那一版，`bun update` 往前挪，verify 的 `--frozen-lockfile` 照旧可重现；SDK 的版本号跟着 Claude Code 走（0.3.319 对 2.1.319），它跳到 0.4 时手动改一次范围。Claude Code 是用户的、会自动更新，下限在它身上；`plugin check` 报两边版本，worker 用 `initializationResult().claude_code_version` 记进日志。SDK 落后于 Claude Code 是常态，不拒绝；Claude Code 低于下限才拒绝。
## 建议的任务切分

1. **spike**：Bun 下 `worker.ts` 原型：`overrides` 换空包、`pathToClaudeCodeExecutable`、零 token 探针、一次真实请求；记下 `settingSources: []` 之外还要关什么。
2. **`worker.ts` 和协议表**：stdin 字段（prompt、cwd、resumeSession、model、effort、access、maxTurns、budgetUsd、command）、stdout 行、Result、退出码，README 和 `test/protocol.test.ts` 照 `harness-pi` 的表；测试用 `spawnClaudeCodeProcess` 换一个假进程回放固定的 stream-json，不打真模型。
3. **`agent` 步骤和 `harness-claude:prompt` 流程**：hub 一侧，复用 `harness-process`；`plugin check` 的两个版本和登录检查。
4. **访问档和一次性许可**：`canUseTool` 接 `access-match`，工具名映射有表有测试；`grant_use`/`grant_ack` 复用 pi 的 hub 侧代码（提到 `harness-process` 里，不复制）。
5. **dogfood 切换和文档**：operad 仓库 `worker.use` 换成 `harness-claude/agent` 跑一个真任务到 `review`；`docs/dogfood.md` 加 "Using claude as the worker"：登录、`setup-token` 在无浏览器机器上怎么用、政策那一句、会话文件在哪。

## 待决问题（未定）

1. `-p` 和 SDK 跑的量是否和交互式一样计入订阅配额；没有核实，dogfood 期间对照 `/usage`。
2. SDK 和 Claude Code 哪一边先坏：Claude Code 自动更新到 SDK 不认识的版本，或 `bun update` 把 SDK 推过了本体的下限；`initializationResult` 报的版本进日志，坏了再定下限怎么升。
3. opencode 那串隔离用的环境变量（关自动记忆、自动压缩、工具搜索等）现版本哪些还有效，任务 1 核。

## 验收

operad 仓库里一个 dogfood 任务从创建跑到 `review`，worker 是 `harness-claude/agent`，用的是用户自己的 claude 订阅登录；事实里有 `usage`、标 `estimated` 的微美元 `cost`、会话 UUID；第二个步骤用 `resumeSession` 接上同一个会话；一次命中 `denyCommands` 的 `Bash` 调用被拒，日志有原因，agent 继续跑完；带 `askCommands` 的访问档在启动时被拒并说出字段；`operad plugin check` 报 Claude Code 和 SDK 两个版本；worker 被 `kill -9` 后步骤以 `interrupted` 结束而 `operad serve` 不受影响；`bun install --frozen-lockfile` 之后 `node_modules/@anthropic-ai/` 下没有任何一个平台二进制（八个平台包都是空包）。
