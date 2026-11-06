# 各家 harness 的程序接口：谁有 Claude Agent SDK 那样的东西（2026-11-06）

`operad-harness.md` 原来写的是"会话的统一协议是 ACP，Claude Code 走已有的 ACP 适配器"。这份笔记核对各家 harness 今天对外的 SDK 和协议，决定 1 到 4 据此改写。判断单列，其余是核实过的事实；标 **未核** 的是没找到一手出处的。

## 要对照的能力

operad 的合约要 harness 给出这几样：续接会话（`resumeSession`，`ctx.ask` 超时后接回同一步）、宿主权限回调（`ctx.ask`）、按访问档限工具、宿主钩子（记事实）、把 operad 的工具给 agent、流式事件、用量、预算上限、取消。

## Claude：`@anthropic-ai/claude-agent-sdk`

- TypeScript 包，Claude Code 原生二进制作为平台可选依赖随包装（如 `@anthropic-ai/claude-agent-sdk-darwin-arm64`），装不上时 `pathToClaudeCodeExecutable` 指向用户自己的 `claude`。在宿主进程里起子进程，stream-json 控制协议。`executable` 接受 `'bun' | 'deno' | 'node'`，自动检测；`bun build --compile` 时要把二进制嵌进去再 `extractFromBunfs()`。
- `query({ prompt, options })` 返回 `AsyncGenerator<SDKMessage>`；`prompt` 给 `AsyncIterable<SDKUserMessage>` 进入流式输入模式，才有 `interrupt()`、`setPermissionMode()`、`setModel()`。
- 控制项：`resume`、`forkSession`、`resumeSessionAt`；`canUseTool`（只在要弹窗时触发；`allowedTools`、规则或 `permissionMode` 放行的不触发）；`permissionPrompts: 'none'` 把本来要问的直接拒（Claude Code ≥ 2.1.259）；`disallowedTools` 裸名字把工具从上下文拿掉，带范围的 `"Bash(rm *)"` 在所有模式下拒，含 `bypassPermissions`；`settingSources: []` 不读用户、项目、本地设置；`systemPrompt` 字符串或 `{ type: 'preset', preset: 'claude_code', append }`；`hooks`；`mcpServers` 加 `createSdkMcpServer()` 进程内 MCP；`sandbox: SandboxSettings`（内容未读）；`maxTurns`、`maxBudgetUsd`（客户端估算，可能超）、`abortController`、`includePartialMessages`、`env`（整体替换子进程环境）。
- 政策，概览页原文："Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK." 品牌：允许 "Claude Agent"、"Powered by Claude"，不允许 "Claude Code"。
- opencode 2.2.3 的 Claude Agent provider 是现成的接法参考：隔离参数（`settingSources: []`、`disableAllHooks`、`tools: []`、`strictMcpConfig`、`permissionMode: dontAsk`、只放行自己的 `mcp__opencode__*`）、工具桥、按 Claude 会话 id 续接、空提示词探测登录状态。

## Codex

- `@openai/codex-sdk` 0.167.0：README 原文 "The TypeScript SDK wraps the `codex` CLI from `@openai/codex`. It spawns the CLI and exchanges JSONL events over stdin/stdout."，实际是 `codex exec --experimental-json`，二进制经钉死版本的 `@openai/codex` 依赖解析。`resumeThread(id)`。审批**没有回调**，只有 `approvalPolicy`（never | on-request | on-failure | untrusted）和 `sandboxMode`（read-only | workspace-write | danger-full-access）；钩子是文件式（`hooks.json`，有 `PermissionRequest` 事件）；事件 `thread.started`、`turn.completed{usage}`、`item.*`；用量只有 token，无费用无预算；`AbortSignal` 杀子进程。Bun **未核**。
- `codex app-server`：stdio 上的 JSON-RPC 2.0，`codex app-server generate-ts` 生成版本精确的类型；稳定面加 `experimentalApi` 开关。`thread/start|resume|fork`、`turn/start|steer|interrupt`；审批是服务端发起的请求 `item/commandExecution/requestApproval`（accept、acceptForSession、decline、cancel、acceptWithExecpolicyAmendment）、文件改动审批、`item/permissions/requestApproval`；`thread/tokenUsage/updated`；`dynamicTools` 实验性。官方 Python SDK 建在它上面。文档说自动化场景用 SDK，富客户端用 app-server。
- `codex mcp-server` 已删除（sdk.md 原文："The `codex mcp-server` command and standalone `codex-mcp-server` binary have been removed. Use the Codex app server for existing integrations."）。
- ACP：`@zed-industries/codex-acp` 0.16.0 已废弃，README 指向 `agentclientprotocol/codex-acp`，"built on the new Codex App Server"。`@agentclientprotocol/codex-acp` 2.5.0：shell、文件改动、权限请求、MCP 工具调用、token 用量事件；审批和沙箱选择；客户端 MCP server；子 agent 会话；中途 steering 扩展。

## Gemini CLI 0.67.0

- `@google/gemini-cli-core` 发了包，docs 说 "can be used as a standalone package in other projects, if needed"，但没有公开 API 合约。
- 仓库里有 `packages/sdk`（`@google/gemini-cli-sdk`，0.69.0-nightly），npm 404，未发布；`session.ts` 写死 `policyEngineConfig: { defaultDecision: PolicyDecision.ALLOW }`，注释 "TODO: Revisit this default when we have a mechanism for wiring up approvals"。
- 可用的：`gemini --acp`（旗标已从 `--experimental-acp` 改名；`initialize`、`authenticate`、`newSession`、`loadSession`、`prompt`、`cancel`、`setSessionMode`；用 `session/request_permission`；文件系统经客户端代理）；`gemini -p --output-format stream-json`（`init`、`message`、`tool_use`、`tool_result`、`result` 带用量）加 `--resume`。策略引擎是 `~/.gemini/policies/*.toml` 的 allow/deny/ask 规则；钩子是命令脚本。

## opencode

- `@opencode-ai/sdk` 1.19.5：`opencode serve` 的 OpenAPI 客户端（`createOpencode()` 起服务加客户端，`createOpencodeClient({ baseUrl })` 接已有的，`GET /doc` 是 3.1 规范）。会话 create/list/get/messages/prompt/fork/revert/summarize；权限：SSE `GET /event` 上来 `permission.asked`，`POST /session/:id/permissions/:permissionID` 回 `{response, remember?}`；规则 `{action, resource, effect}` 最后匹配的赢，无匹配即 ask；`session.abort`。
- v2 已出，npm 上的 SDK 还是 v1，权限配置字段不同（v2 用 `permissions`、`shell`、`subagent`），要钉版本。`opencode run --format json` 非交互时自动拒绝权限请求。`opencode acp` 有。

## pi

- 已改名：`@earendil-works/pi-coding-agent` 1.5.0，仓库 `earendil-works/pi`；`@mariozechner/*` 停在 0.73.1（2026-05-07）。
- 进程内库，sdk.md 原文 "embeds Pi in a Node.js or Bun process"。`createAgentSession()` → `prompt()`、`steer()`、`followUp()`、`abort()`、`subscribe()`；会话是 JSONL 树，可 fork，`SessionManager.inMemory()`；`tools`、`excludeTools`、`customTools`（进程内）；扩展 `pi.on("tool_call")` 在执行前触发，可改 `input` 或返回 `{ block: true, reason }`，没有 `canUseTool` 式回调；MCP 要加 `createMcpExtension()`；`message.usage.cost` 每条消息带费用；无预算上限。子进程模式 `--mode json`、`--mode rpc`。ACP 经第三方 `pi-acp`。

## 其他

- Cursor `@cursor/sdk` 1.3.1：本机 agent 循环在进程内、推理在 Cursor 托管模型；Node ≥ 22.13，"The flat build runs on Bun"；`Agent.create/resume`、`send()` 返回 `Run`（`stream()`、`wait()`、`cancel()`、`steer()`），内联 `mcpServers`，`Agent.getUsage()` 带美元；**没有权限回调**，原文 "there's no human-in-the-loop prompt in headless mode. To gate tool calls, configure hooks ... or run with local.sandboxOptions.enabled: true"；钩子只能文件；`agent acp` 有。
- Factory Droid `@factory/droid-sdk` 0.10.0：起 PATH 上的 `droid`；`createSession`、`resumeSession`、`interrupt()`、`permissionHandler(request)` 回调、SDK MCP 工具、钩子、`tokenUsage`；Node ≥ 20。细节只见章节标题，**未核**。
- Qwen Code `@qwen-code/sdk` 0.1.29（"A minimum experimental TypeScript SDK"）：照 Claude SDK 的形状，`query({ prompt, options })`、`resume`、`canUseTool`（60 秒不答自动拒）、`permissionMode`、`allowedTools`、`excludeTools`、`createSdkMcpServer()`、`interrupt()`、`maxSessionTurns`、`includePartialMessages`；CLI 随包；Node ≥ 22。钩子、用量、预算**未核**。
- Amp `@ampcode/sdk`：`execute()` 流 `system`/`assistant`/`result`，`continue` 续接线程；权限只说 "Use a custom plugin to control tool use"。Kimi `@moonshot-ai/kimi-agent-sdk` 0.1.8 能力**未核**，`kimi acp` 有。

## ACP

- `@agentclientprotocol/sdk` 2.4.0；v2 草案加 `session/resume`（带重放）、`session/fork`、`session/delete`。协议有 `session/request_permission`（agent → client）、`session/cancel`、按 `loadSession` 能力的 `session/load`；**没有**预算、宿主钩子、费用，工具和钩子留在各 agent 自己的配置里。
- 注册表（agentclientprotocol.com/get-started/agents）上有 Codex（适配器）、Gemini CLI、Cursor、Factory Droid、OpenCode、Kimi CLI、Qwen Code、Pi（pi-acp）、Claude（适配器）、OpenClaw、Hermes、Goose、Copilot 等；Amp 不在。
- Claude 适配器 `@agentclientprotocol/claude-agent-acp` 0.101.0 内部包的是 Agent SDK 0.3.318；支持工具调用带权限请求、编辑审阅、子 agent 记录、终端、客户端 MCP；`canUseTool`、`hooks`、`maxBudgetUsd`、`settingSources` 是否透给宿主 README 没写，**未核**，从形状看没有。

## 对照表

| harness | 接口 | 续接 | 宿主权限回调 | 限工具 | 宿主钩子 | 进程内工具 | 用量 | 预算 | 取消 |
|---|---|---|---|---|---|---|---|---|---|
| Claude | Agent SDK，子进程，二进制随包 | 有 | 有 | 有 | 有 | 有 | 有 | 有 | 有 |
| Codex SDK | `exec --json` 子进程 | 有 | 无，只有策略 | 部分 | 文件 | 无 | token | 无 | 有 |
| Codex app-server | JSON-RPC 子进程 | 有 | 有 | 部分 | 文件 | 实验 | token | 无（未核） | 有 |
| Gemini `--acp` / `-p` | 子进程 | 有 | ACP 有，`-p` 无 | TOML 策略 | 文件 | ACP 客户端 MCP | token | 未核 | 有 |
| opencode | HTTP 服务加客户端 | 有 | 有 | 规则 | 服务内插件 | 插件 | 未核 | 未核 | 有 |
| pi | 进程内库，Bun | 有 | 部分（钩子 block） | 有 | 有 | 有 | 每条费用 | 无 | 有 |
| Cursor | 进程内循环 | 有 | 无 | 文件钩子或沙箱 | 文件 | 内联 MCP | token 加美元 | 未核 | 有 |
| Factory Droid | 子进程，PATH | 有 | 有 | 有 | 有 | 有 | token | 未核 | 有 |
| Qwen Code | 子进程，CLI 随包 | 有 | 有 | 有 | 未核 | 有 | 未核 | 回合数 | 有 |

## 判断

1. 只有 Claude 把合约要的九样放在一个 SDK 里；Qwen 和 Droid 形状接近，可以沿用同一个 `sdk` 接法。
2. Codex 的 TS SDK 不够用，app-server 够用，而 `@agentclientprotocol/codex-acp` 已经在 app-server 上做了 ACP，不必自己写客户端。
3. Gemini 没有可用的 SDK，`--acp` 是唯一有权限回调的路。
4. pi 是进程内库且支持 Bun，可以是第二个 `sdk` 接法，不需要桥。
5. ACP 缺的费用、预算、钩子、进程内工具四样，operad 侧都能补，所以 `acp` 接法作为通用兜底成立。
6. 版本耦合是 `sdk` 接法的代价：Agent SDK 的功能按 Claude Code 版本开关，Qwen 的 SDK 自称实验性，pi 的接口随发布变。

## 出处

- code.claude.com/docs/en/agent-sdk/overview 与 /typescript（2026-11-06 读取）
- github.com/openai/codex/tree/main/sdk/typescript；developers.openai.com/codex/sdk.md；developers.openai.com/codex/app-server；github.com/agentclientprotocol/codex-acp
- github.com/google-gemini/gemini-cli：docs/cli/acp-mode.md、docs/cli/headless.md、packages/sdk
- opencode.ai/docs/sdk、/server、/permissions、/acp；github.com/anomalyco/opencode
- github.com/earendil-works/pi：packages/coding-agent/docs/sdk.md、extensions.md、cli-integration.md
- cursor.com/docs/sdk/typescript；github.com/Factory-AI/droid-sdk-typescript；github.com/QwenLM/qwen-code/tree/main/packages/sdk-typescript；ampcode.com/manual/sdk
- agentclientprotocol.com/get-started/agents；github.com/agentclientprotocol/claude-agent-acp
