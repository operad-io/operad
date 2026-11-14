# operad-harness-claude：第三种 harness，Claude 走 Agent SDK 的客户端，二进制和登录都是用户装的那份

- 状态：接法、二进制来源、凭据、第一版范围已定并进了 ADR；下面只留没进 ADR 的点、任务切分、待决和验收
- 涉及 ADR：0022、0023、0024、0025
- 涉及：`operad-harness.md`；`operad-harness-pi.md`；ADR 0008 D1–D5、0009 D2、0010 D2–D3
- 来源：`research/2026-11-06-harness-sdks.md`「Claude」；`@anthropic-ai/claude-agent-sdk` 0.3.319 的 `sdk.d.ts`；Agent SDK 概览页和 Claude Code 的 Authentication 页；本机实测

## 已定，尚未做或未核实

- 等 ADR 0010 D2 的 `ctx.secrets` 进了 `StepContext`，API key 走 `env: { ANTHROPIC_API_KEY }` 这条路，不换接法。这一句政策写进用户文档。
- 子进程里的 Claude 不做发现这一条里：opencode 关掉自动记忆等的那串环境变量，逐个核对现版本还认不认，认的照抄。

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
