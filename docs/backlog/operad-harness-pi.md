# operad-harness-pi：第二种 harness，pi 走进程内库，装在一个 Bun 子进程里

- 状态：接法、进程边界、第一版范围已定并进了 ADR；下面只留没进 ADR 的点、任务切分、待决和验收
- 涉及 ADR：0022、0023、0024、0025
- 涉及：`operad-harness.md`；`operad-contract.md` 决定 6、8、11、12
- 来源：`research/2026-11-06-harness-sdks.md`「pi」；pi 1.5.0 源码 `packages/coding-agent/docs/{sdk,extensions,cli-integration,message-types}.md`、`src/core/{sdk,agent-session,session-manager,auth-storage}.ts`、`src/core/tools/bash.ts`、`examples/sdk/*.ts`

## 已定，尚未做或未核实

- 等合约决定 11 的 `ctx.secrets` 进了 `StepContext`，再加 API key 一条路（`setRuntimeApiKey`），不换接法。
- `steer`、`followUp`、逐 token 流（`message_update` 的 `text_delta`）留给 `operad-conversation`，第一版不接。
- 第三方扩展的 `confirm`：`uiContext` 接到 `ctx.ask`，不再静默返回假。

## 建议的任务切分

给 lead 参考，每条一个子系统；顺序是依赖顺序，1 不通后面都不做。

1. **spike**：在 Bun 下跑通 pi 的 `examples/sdk/01-minimal.ts` 和 `11-sessions.ts`（显式 `resourceLoader`、`SettingsManager.inMemory()`、`agentDir`、`authPath`），记下哪些 API 在 Bun 下不工作。结论写进这个文件的「待决」或直接删掉待决 1。
2. **共用的进程助手**：把 `harness-radian` 的 `process.ts`、`jsonl-log.ts` 提到 `@operad-io/harness-process`，`harness-radian` 改为引用，行为不变，测试搬过去。
3. **`worker.ts`**：子进程程序。stdin 一份 JSON（prompt、cwd、resumeSession、model、thinkingLevel、access、authPath、agentDir），stdout 逐行事件，最后一行 Result；只有一个内联扩展，第一版的 `tool_call` 只记日志不拒。测试用一个假的 `Model`（pi 的 `ModelRuntime` 接受自定义 provider，先核实它的测试里怎么造的），不打真模型。
4. **`agent` 步骤和 `harness-pi:prompt` 流程**：hub 一侧，起 `bun worker.ts`，读 Result 成 `AgentResultData`，`resumeSession` 透传；用 `harness-radian` 现有的 `plugin.test.ts` 形状写测试。
5. **访问档匹配器**：独立模块 `access-match`，输入访问档和一次工具调用（工具名、参数），输出放行或阻断原因；拆链、内联代码、路径前缀各有测试；`worker.ts` 的 `tool_call` 接上它，`enforces` 声明两项。
6. **dogfood 切换**：`dev` 的 `worker.use` 在 operad 仓库里换成 `harness-pi/agent`，跑一个真任务到 `review`；`docs/dogfood.md` 加 pi 一节（怎么登录 pi、默认模型从哪来、会话文件在哪）。

## 待决问题（未定）

1. 两份凭据同时刷新 OAuth 令牌，pi 的文件锁够不够；dogfood 期间观察 `auth.json` 有没有被互相覆盖。（spike 已证明锁在 Bun 下串行化读改写，见上；dogfood 观察的是令牌刷新语义。）
2. 会话文件归属：放在 operad 的 `agentDir` 下意味着用户自己的 `pi` 命令看不到这些会话；要不要反过来放到用户的会话目录里，让 `pi --continue` 能接上，继承 `operad-harness.md` 待决 1。

## 验收

operad 仓库里一个 dogfood 任务从创建跑到 `review`，worker 是 `harness-pi/agent`，用的是用户自己的 pi 登录；它的事实里有 `usage`、以微美元计的 `cost`、会话文件路径；第二个步骤用 `resumeSession` 接上同一个会话并在日志里看到旧消息在上下文中；一次命中 `denyCommands` 的 `bash` 调用被阻断，日志有原因，agent 继续跑完；一个带 `askCommands` 的访问档在启动时被拒并说出字段名；`operad plugin check` 对 `harness-pi` 通过；worker 子进程被 `kill -9` 后步骤以 `interrupted` 结束而 `operad serve` 不受影响。

### 验收怎么分

测试覆盖的（`bash scripts/verify.sh`，不打真模型，不用用户的 pi 登录）：

- 事实里有 `usage`、微美元 `cost`、会话文件路径：`worker.test.ts` 的 `a prompt that ends writes the lines in order and a Result with usage, cost and sessionId`，步骤一侧是 `plugin.test.ts` 的 `a done run has the facts harness-radian records for the same data`；都用假 provider。
- `resumeSession` 接上同一个会话、旧消息在上下文里：`worker.test.ts` 的 `resume: the second run sees the first answer in the context the fake model receives`，透传是 `plugin.test.ts` 的 `resumeSession is passed through to the worker's stdin`。
- 命中 `denyCommands` 的 `bash` 被阻断、有原因、run 继续到 `done`：`worker.test.ts` 的 `a denied bash call is blocked, a blocked line is written, the model gets the reason and the run ends done`，匹配器本身在 `access-match` 的测试里。
- 带 `askCommands` 的访问档在启动时被拒并说出字段名：`plugin.test.ts` 的 `a profile with askCommands is refused at start and the field is named`。
- `operad plugin check` 对 `harness-pi` 通过：`plugin.test.ts` 的 `passes with the default worker program`（插件的 `check()`）。
- `dev` 的 `worker.use` 换成 `harness-pi/agent`：`packages/dev/test/harness-pi.test.ts`（假 worker 把任务带到 `review`）和 `packages/dev/test/dogfood-config.test.ts`（本仓库 `.operad/dev.json` 换成 pi 后通过校验，启用插件后该步骤能解析）。
- worker 被 `SIGKILL` 后步骤以 `interrupted` 结束，测试进程不受影响：`plugin.test.ts` 的 `a worker killed with SIGKILL ends interrupted and leaves the test alive`（杀的是测试自己起的子进程，不碰 `operad serve`）。

合并后由 lead 手工核的（测试不能做，也不该做）：

- 真实的 pi 登录：`pi` 里 `/login`，operad 用这份登录跑通一次真模型，默认模型来自用户的 pi。
- 真实的续接：同一任务的第二个步骤用上一个 `sessionId` 接上，真模型的回答里看得到旧消息。
- 真实的 `kill -9`：对 `operad serve` 起的真 worker 子进程 `kill -9`，步骤以 `interrupted` 结束，`operad serve` 不受影响。
- 一个 dogfood 任务从创建跑到 `review`，worker 是 `harness-pi/agent`，事实里的 `usage` 和 `cost` 是真数。
- 待决 1 的观察：dogfood 期间 `auth.json` 有没有被互相覆盖。
