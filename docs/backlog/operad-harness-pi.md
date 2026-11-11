# operad-harness-pi：第二种 harness，pi 走进程内库，装在一个 Bun 子进程里

- 状态：decided（接法、进程边界、第一版范围已定；决定 9 改为用用户装的 pi，待落实；问人一段等合约决定 6 落地）
- 涉及 ADR：0049、0024
- 涉及：`operad-harness.md` 决定 1 到 3、6；`operad-contract.md` 决定 6、8、11、12；`operad-sandbox.md` 决定 1 到 3
- 来源：`research/2026-11-06-harness-sdks.md`「pi」；pi 1.5.0 源码 `packages/coding-agent/docs/{sdk,extensions,cli-integration,message-types}.md`、`src/core/{sdk,agent-session,session-manager,auth-storage}.ts`、`src/core/tools/bash.ts`、`examples/sdk/*.ts`

## 背景

dogfood 跑通了 `harness-radian`。`operad-harness.md` 决定 1 说一种 harness 一个描述文件加接法代码，决定 2 给了 `sdk` 和 `acp` 两种接法，但两种接法都还只有 radian 这一个 `acp` 的影子。pi 是合约对应得最整齐的一家：续接、工具限制、工具前钩子、进程内工具、每条消息的费用、取消，全在一个 TypeScript 库里，不要子进程协议，也不要 MCP。它适合做第二种 harness，把"描述文件加接法"这件事从一家变成两家，Claude 的 Agent SDK 随后照同一个形状接。

核实过的 pi 事实（1.5.0）：

- `@earendil-works/pi-coding-agent` 是进程内库，文档原文 "embeds Pi in a Node.js or Bun process"；`engines.node >= 22.19`，Bun 只有文档一句话，没有 CI 证据。
- `createAgentSession({ cwd, agentDir, modelRuntime, sessionManager, settingsManager, resourceLoader, tools, excludeTools, customTools })`；不传 `resourceLoader` 就自动发现用户 `~/.pi/agent` 下的扩展、技能、提示模板、上下文文件。
- 会话是 JSONL 文件树：`SessionManager.create(cwd, sessionDir)`、`open(path)`、`continueRecent`、`fork()`；`session.sessionFile` 是路径。
- 扩展钩子 `tool_call` 在工具执行前触发，处理器是 async 的，返回 `{ block: true, reason?, terminate? }` 拒绝；`event.input` 可改。并行工具调用时同一条消息的兄弟调用先逐个预检再并发执行。
- `message_end` 事件带 `usage`：`input`、`output`、`cacheRead`、`cacheWrite`、`totalTokens`、`cost.total`（美元）。没有预算上限。
- `prompt()` 在一次 run 结束时返回，含自动重试；`agent_end` 之后还可能自动续跑，`agent_settled` 才是真的停。`steer()` 插在当前轮后，`followUp()` 排在整次 run 后；`abort()` 等到空闲。
- 凭据：`ModelRuntime.create({ authPath, modelsPath })` 指定文件；`setRuntimeApiKey(provider, key)` 只在内存里给。`auth.json` 的读写走 `proper-lockfile`，多个 pi 进程共享一份是它支持的用法。
- `createBashTool` 接受 `operations`（换执行器）、`spawnHook`（改命令、cwd、env）、`commandPrefix`。
- `AgentSession` 接受 `uiContext`；不给时 `ctx.ui.confirm()` 这类对话在扩展里返回默认值。
- **Bun 1.3.14 下全部跑通（2026-11-06）**：显式 `resourceLoader`、`SettingsManager.inMemory()`、临时 `agentDir`、`ModelRuntime.create({ authPath, modelsPath })`、自定义 provider 的 `streamSimple`、`message_end.usage`、`SessionManager` 落盘与 `open(path)` 续接、`abort()`、`proper-lockfile` 两个进程写同一份 `auth.json` 都在 `packages/harness-pi/test/spike.test.ts` 通过，不需要 Node；锁的测试是确定性的：一个进程按 pi 的锁参数（`proper-lockfile`、`realpath: false`、`stale: 30s`）持锁并等测试创建释放文件，另一个进程先以 `retries: 0` 撞锁拿到 `ELOCKED`，释放后再走 `ModelRuntime.login` 的读改写，结束时两份凭据都在；关掉锁的对照会丢掉一份凭据；这两个断言由 `auth.json locking blocks a second writer until the lock is released`（事件栅栏强制争用）和 `the same read-modify-write without the lock loses a credential`（无锁对照丢掉一份凭据）两个测试证明。pi 1.5.0 的包根没有导出 `AuthStorage` / `FileAuthStorageBackend`（只有 `readStoredCredential`），所以从 API 无法在外面持锁，spike 用同一把 `proper-lockfile` 锁同一个路径。pi-ai 自带的 faux provider 没有从 `pi-coding-agent` 公开导出，spike 按任务 3 的退路注册自定义 provider。

## 决定（已定）

1. **pi 是 operad 的第二种 harness，`sdk` 接法**，包名 `@operad-io/harness-pi`，步骤 `harness-pi/agent`，流程 `harness-pi:prompt`（2026-11-11 改名：插件名 `pi`，步骤 `pi/agent`，流程 `pi:prompt`，见 `operad-harness.md` 决定 9）。参数、结果名、事实形状和 `harness-radian` 完全一样（`AgentStepParams`、`AgentResultName`、`AgentResultData`），一个 flow 把 `use` 从 `harness-radian/agent` 换成 `harness-pi/agent` 就能跑；`dev` 的 `worker.use` 也是这么换。
2. **库装在一个 Bun 子进程里，不装在 hub 进程里。** 插件分两半：hub 一侧的 `agent` 步骤只起 `bun <worker.ts>`，和 `harness-radian` 一样用 `runAgent` 看墙钟和停滞、用 `JsonlLog` 落日志、读最后一条 Result 记录；子进程里的 `worker.ts` 才 import pi 的库，从 stdin 读一份 JSON 参数，把 pi 的事件逐行以 JSON 写到 stdout，最后一行是 Result。理由：一个跑两小时的任务挂掉或漏内存不能带倒 iOS 连着的 hub；等人时杀子进程就是"没有进程"，续接就是新起一个；以后的沙箱壳包整个子进程；形状和"agent 是子进程"的 Claude 一致。代价是一行一个 JSON 的薄格式，不另设协议。`harness-radian` 的 `process.ts` 和 `jsonl-log.ts` 提到一个两家共用的包里，不复制。
3. **子进程里的 pi 不做发现**：显式 `resourceLoader`（只带 operad 自己的一个内联扩展，不加载用户扩展、技能、提示模板、主题、上下文文件）、`SettingsManager.inMemory()`、`agentDir` 为 `~/.operad/harness/pi/`，会话文件在 `~/.operad/harness/pi/sessions/`。和 Claude 那边 `settingSources: []` 是同一条原则：harness 的行为由 operad 的描述文件决定，不随用户个人配置变。
4. **凭据第一版复用用户自己的 pi 登录**：`ModelRuntime.create({ authPath: ~/.pi/agent/auth.json, modelsPath: ~/.pi/agent/models.json })`。用户的 pi 用的是 Anthropic 和 OpenAI 的 OAuth 订阅，不是 API key，`ctx.secrets` 给不了；pi 自己对 `auth.json` 加文件锁，TUI 和 operad 同时刷新令牌是它设计内的。描述文件里 `model` 和 `thinkingLevel` 两个设置，默认跟用户 pi 的默认模型。等合约决定 11 的 `ctx.secrets` 进了 `StepContext`，再加 API key 一条路（`setRuntimeApiKey`），不换接法。
5. **事实的来源**：`sessionId` 是会话文件路径；`usage` 从每条 `message_end` 累加，`cache_read`、`cache_write` 对应 `cacheRead`、`cacheWrite`；`cost.micros` 是 `cost.total` 累加后乘一百万取整，pi 算不出价的模型记 `null`；`finalMessage` 是 `getLastAssistantText()`；日志是 pi 事件的子集（`message_end`、`tool_execution_start`、`tool_execution_end`、`agent_settled`、阻断记录），不是全部 delta。
6. **续接**：`resumeSession` 是会话文件路径，子进程 `SessionManager.open(path)` 后把新 prompt 发进去。`steer`、`followUp`、逐 token 流（`message_update` 的 `text_delta`）留给 `operad-conversation`，第一版不接。
7. **访问档第一版只执行 deny**：`enforces: ["denyPaths", "denyCommands"]`。`tool_call` 处理器拿到访问档：`bash` 的命令按 `operad-sandbox.md` 决定 4 拆链（`&&`、`;`、`|`）后逐段匹配 `denyCommands`，内联代码（`bash -c`、`python -c`、`node -e`、`osascript -e`、`find -exec`、`xargs`）第一版一律拒；`read`、`write`、`edit`、`bash` 涉及的路径匹配 `denyPaths`。命中返回 `{ block: true, reason }`，日志记一条阻断记录。`askCommands` 不在 `enforces` 里，带它的访问档按合约决定 12 在启动时被内核拒绝并说出字段；这不是绕过，是第一版的边界。这个匹配器写成 operad 的一个独立模块，Claude 和命令适配器以后共用。
8. **问人一段随合约决定 6 一起来，不在这个 plan 里。** `tool_call` 是 async 的，到时就是在处理器里 `await ctx.ask(...)`：宽限期内答了放行，超时返回 `block` 加 `abort()`，步骤以 `waiting` 结束带会话路径；续接按决定 6 开原文件，一次性许可在处理器里放行那一条。`uiContext` 届时也接到 `ctx.ask`，第三方扩展的 `confirm` 不再静默返回假。
9. **不自带 pi，用用户装的 pi。** `@earendil-works/pi-coding-agent` 不在 `dependencies` 里，只在 `devDependencies` 里供类型和测试的假模型用。worker 启动时找库：取 PATH 上的 `pi` 命令（设置 `command` 可改）的真实路径，往上走到 `package.json` 的 `name` 是 `@earendil-works/pi-coding-agent` 的目录，`import()` 它 `exports["."]` 指的入口（现在是 `dist/index.js`）。bun 全局装（`~/.bun/install/global/node_modules/…`）和 npm 全局装都是这个形状；从外部脚本 `import()` 全局装的那份已核能用。worker 里对库的 import 改成动态的，类型仍是 `import type`。`operad plugin check` 读那个 `package.json` 的版本，低于 worker 写时的版本下限（现在 `1.5.0`）或没有 `pi` 命令时拒绝并说出两边版本。升级 pi 是用户的事；worker 用到的接口变了，operad 改下限。这是 `operad-harness.md` 决定 8 对 pi 的落实，Claude 同样处理（`operad-harness-claude.md` 决定 2）。
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
