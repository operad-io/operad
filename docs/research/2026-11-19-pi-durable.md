# pi-durable 能不能做 operad bot 聊天背后的 agent（2026-11-19）

owner 问的问题：`@earendil-works/pi-durable` 能不能放在 bot 聊天后面，让一次回复在 worker 死掉或 `operad serve` 重启后接着跑。事实和判断分开写：前五节是事实，标 **实测** 的是在临时目录里跑过的探针（不在 operad 仓库里），标 **代码** 的读自 operad `main`（`de50ff8f`）或 pi-durable 1.5.2 的 `dist/`，标 **文档** 的只出自它的 README，标 **未核** 的没有验证；最后两节是判断，都还不是决定。

探针用的版本：pi-durable 1.5.2（npm `latest`，2026-11-10 发布），Bun 1.3.14，Node 24.18.1，macOS arm64，owner 全局安装的 pi 1.5.2。

## 一览

- **它是什么（文档）**：一个库，不是 CLI。会话、模型回合、工具调用和宿主自己的状态都先提交到存储再显示；每个工具调用是一个带检查点的任务，进程死后重开存储就从上一个检查点继续。README 第一行标着 Experimental，API 不预告就改。
- **pi CLI 不用它（代码）**：`pi-coding-agent` 1.5.2 的依赖里没有 pi-durable，owner 的全局安装里也没有这个包。operad 今天的 pi harness 走的是 `createAgentSession` 加 pi 的会话文件，和 pi-durable 是两套东西。
- **崩溃恢复是真的（实测）**：工具跑到一半 `SIGKILL`，重开后回复接着跑完，用户消息不用重发。
- **Bun 下自带的 SQLite 存储不能用（实测）**，要自己写约 40 行的 `bun:sqlite` 适配层，或者用 JSONL 存储。
- **owner 的 OAuth 登录能用（实测）**：把 owner 那份 pi 的 `ModelRuntime` 交给它，`openai-codex/gpt-5.6-terra` 正常回答。
- **等人回答的闸门和可停放的工具还没发布（代码）**：这两样只在 GitHub `main` 的 README 里，1.5.2 的包里没有。

## 1. 在 Bun 下能不能跑，能不能用 owner 的登录

**存储（实测）**

| 存储 | Bun 1.3.14 | Node 24 |
|---|---|---|
| `storage/sqlite/node`（`openNodeSqliteStorage`） | 不能：`error: No such built-in module: node:sqlite` | 能 |
| `storage/sqlite`（可移植核心）加自写的 `bun:sqlite` 适配层 | 能，崩溃恢复通过 | 未测 |
| `storage/jsonl/node` | 能，崩溃恢复通过 | 未测 |

- 自带的 Node 适配层在 `@earendil-works/chord/sqlite/node` 里直接 `import { DatabaseSync } from "node:sqlite"`（代码），Bun 没有这个模块。
- 可移植核心只要一个异步的 `SqliteDatabase` 门面：`exec`、`run`、`runCounted`、`get`、`all`、`transaction`、`close`（代码）。探针里的 `bun:sqlite` 版本约 40 行，开了 WAL。它没有跑过 pi-durable 自带的存储一致性测试（`registerStorageConformance`），**未核**。
- 文档说 JSONL 存储把整段历史留在内存里，长期运行的 agent 建议用 SQLite。
- SQLite 存储支持表名前缀（`{ prefix: "pi_" }`），文档说可以和宿主的表共用一个库；和 operad 的库共用没有试，**未核**。
- 包的 `engines` 写的是 `node >=22.19.0`，没有声明支持 Bun。

**登录和模型（实测）**

- `pi-coding-agent` 导出 `ModelRuntime`，它实现了 pi-ai 的 `Models` 接口，读 `~/.pi/agent/auth.json` 和 `models.json`。探针从 owner 的全局 pi 安装里动态加载它，原样传给 `Harness.open` 的 `models`。
- 用 `openai-codex/gpt-5.6-terra`（OAuth 登录）发了一句 "Reply with exactly: ok"，回答 `ok`，`pi.usage` 记下 21 入、5 出和成本。一共发了两次这样的请求。
- 这次 pi-durable 自带的 pi-ai 和 owner 那份 pi 的 pi-ai 都是 1.5.2。两边版本不一致时是否还能混用，**未核**。
- 探针在 `harness.close()` 之后进程没有自己退出，原因没查，**未核**（怀疑是 `ModelRuntime` 留了句柄）。
- `zai` 和 `models.json` 里的自定义 provider 没有试，**未核**。

## 2. 今天 worker 中途死掉，一次回复丢什么

全部出自 operad 的代码。

- **回复结束前什么都不是事实**：`packages/chat/src/reply.ts:1237` 的注释写着 "None of this is stored until the harness returns"。开跑前只写一条 `chat.run`；工具调用、文字、思考的条目和最后的 `chat.message` 都在 harness 返回之后才写。回复进行中的文字只在这一步的 JSONL 日志里，`tail` 视图从那里读（ADR 0027 D4）。
- **worker 被杀**：
  - 新起的 worker 被信号杀掉且没有结果行，这一步是 `interrupted`（`packages/harness/process/src/step.ts:270-280`）；保留的 worker 在第一行之后死掉是 `failed`/`no_result`。
  - 聊天记下已完成的条目，加一条 "stopped" 或 "The reply failed: …"。
  - 用户的消息保持未回答，要等下一条消息或 `/retry` 才进下一轮的提示词。没有自动重试。
- **serve 重启**：
  - `chat:reply` 是 `replay: "unsafe"`（`packages/chat/src/index.ts:78`），恢复时内核写 `step_interrupted`（原因 `recover_unsafe`）并走到 `cancelled`。
  - 这一步的收尾不会运行，所以连已完成的条目和 "stopped" 都不写，这次回复在记录里什么都不留。
- **工具调用**：operad 没有工具级的幂等。下一轮模型看到的是 pi 会话文件里上一次成功回复之后的上下文，可能把同样的调用再做一遍。崩溃的那一轮 pi 自己往会话文件里写了多少，**未核**。
- **用量**：失败或中断的一步，用量只在这一步的结果数据里，不进 `chat.message`。
- **测试**：有杀 worker 的测试（`packages/harness/pi/test/heavy/plugin.test.ts:592` 等），没有找到在回复中途重启 serve、或在回复中途杀保留 worker 的测试。
- **和 ADR 的一处出入**：ADR 0026（`docs/adr/0026-chat.md:23` 附近）说重启后重跑的一步会看到回复已在并跳过；代码里这一步不安全、不重跑。

所以今天的损失是：这一轮已经花掉的模型调用和工具结果；serve 重启时还丢掉这一轮的全部记录；用户要再发一次或 `/retry`。

## 3. 换成 pi-durable，一次回复能不能跨过重启

**探针（实测）**：一个假模型先调用一个睡 4 秒的工具，再给出答案。工具开始后 0.5 秒 `kill -9`，然后用同一个存储重开、`resume()`、用同一个 `requestId` 再提交一次。Bun 加 `bun:sqlite`、Bun 加 JSONL、Node 加自带 SQLite 三种组合结果一致：

| 工具声明 | 重开后发生什么 |
|---|---|
| 默认（不是 `replay: "safe"`） | 工具不重跑；模型收到错误结果 "Tool slow was interrupted and may have partially run"，再请求一次模型，给出答案 |
| `replay: "safe"` | 工具重跑一遍，正常结果，再给出答案 |

- 两种情况下提交都以 `done` 结束，同一个 `requestId` 找回的是原来那次提交，用户消息没有重复。
- 第一次模型调用没有重发：标记文件里模型只被调用两次（工具前一次，工具后一次）。
- 内置的 `bash` 不是 replay-safe，所以被打断的命令不会重跑，模型自己决定怎么办。

**没有实测的部分（文档）**

- 进程死在模型请求中途：算一次失败的尝试，按 `settings.retry` 退避重试；已流出的部分答案留作 aborted 条目。部分答案和工具输出默认最多每 100 ms 提交一次、最迟约 1 秒落盘，崩溃最多丢这一窗口。
- 同一任务连续被打断 `settings.restartLimit`（默认 5）次后结束，不再重跑。
- 一个存储同一时间只能有一个进程写，没有跨进程锁。

**它的存储和 operad 事实的关系**

这是最大的设计问题，下面是两边各自的事实，怎么接是判断（见最后一节）。

- **operad 一侧（ADR 0027 D2、D6）**：聊天记录的唯一来源是 operad 的事实，"不依赖 agent 自己的会话文件"；pi 的会话文件只是模型的上下文。
- **pi-durable 一侧（文档）**：它自己就是一份完整的记录：不可变条目的 transcript、`pi.usage`（按 provider/model 和按工具，失败和中止的尝试也算）、`pi.inbox`（排队的输入）、`pi.live`（进行中的回合和工具输出）。
- **往外同步的接口（文档）**：`watch()` 给出每次提交的条目和操作；`observeCommits()` 给出实际落盘的内容；`submit(tx, draft)` 让宿主把自己的状态和一次提交放进同一个原子提交。
- **回复中途的消息**：`whenBusy: "steer"` 在当前工具轮之后放入，`follow-up` 在回答之后开始下一轮，条目按提交顺序排。这和 ADR 0022 D1 的 `takesMessagesMidRun`、今天 pi harness 的 `streamingBehavior: "steer"` 是同一种语义。T-0565 已合并的排序（条目带 `startedAt`）和未合并的 T-0566 能否直接换成按 pi-durable 的条目顺序，**未核**。
- **两个存储之间没有原子性**：pi-durable 的库和 operad 的事实库是两个提交点。除非让 pi-durable 的表用前缀住进 operad 的库并共用一个连接（文档说可行，**未核**），否则同步只能是幂等的追赶。

## 4. 访问档案、询问和 MCP 能不能对上

**访问档案（ADR 0025、0023 D7）**

- 1.5.2 的 `beforeTool` 钩子可以返回 `{ block }` 或改写参数，抛错等于拦截（代码，`dist/harness/types.d.ts:973`）。今天 worker 的 `tool_call` 钩子做的"判定、拦截并给理由"可以原样搬过来。
- 钩子能看到嵌套调用的 `call.parent`，所以 codemode 脚本里的调用也过同一个闸门（文档）。

**询问（ADR 0023 D8、0025 D4）**

- **1.5.2 里没有可持久的询问（代码）**：`dist/` 的类型里没有 signal、park 或 sleep 型的钩子返回值。钩子可以是异步的，所以能像今天一样在内存里等 `ctx.ask`，但这个等待不跨重启。
- **GitHub `main` 的 README 有，npm 上还没有（文档）**：
  - `beforeTool` 可以返回 `{ sleep: { signals, until } }` 把调用停在执行之前。
  - 回答用 `harness.signal(taskId, …)` 送进去，过期走 `expired`。
  - 每次唤醒把所有闸门从头再跑一遍。
  - 工具自己也可以 park 着等 webhook 或人。
- 和 ADR 0023 D8 的对照：今天超时后是拦截、中止、这一步以 `waiting` 结束并带会话路径，迟到的回答带着一次性许可重跑这一步。停放的闸门能把这条路径换成"调用原地等着，不占进程"。一次性许可、always-allow 和目标许可（ADR 0025 D4、D7、D10 到 D12）仍然是 operad 自己的状态，要在闸门里读，**未核**。

**MCP（ADR 0031）**

- 今天的事实（代码）：
  - pi harness 只把 `mcpServers` 放进保留 worker 的键（`packages/harness/pi/src/index.ts:711`）。
  - worker 只挂 operad 自己的工具，经 `@operad-io/mcp` 做成 pi 的自定义工具。
  - bot 自己的 MCP 服务器在 pi 上没有挂（ADR 0023 D3 也这么写），claude harness 才挂。
- pi-durable 不依赖 pi-mcp。`pi-mcp` 1.5.2 是独立的 MCP 客户端包（"for pi and other applications"）。
- pi-durable 的工具就是 `defineTool`，文档举的例子是 `mcp__github__search` 加 `deferred: true` 和 `tool_search`。把 `@operad-io/mcp` 的 `openMcpTools` 或 pi-mcp 的工具包成 `defineTool` 看起来直接，没有试，**未核**。

## 5. 和 ADR 0022 D6、0023 D9 的冲突，以及风险

- **D6、D9 说 harness 是用户自己装的，operad 不打包 pi，只有版本下限（`PI_FLOOR = "1.5.0"`）**。pi-durable 不在用户的 pi 安装里，所以要么 operad 自己依赖它（连带 chord、pi-ai、pi-codemode、pi-schema、pi-telemetry，探针里一共装了 92 个包），要么要求用户另装。两条路都要改 ADR，前一条还要 owner 批准新的运行时依赖。
- **两份 pi-ai**：operad 依赖的 pi-durable 带一份 pi-ai，用户的 pi 带另一份。登录要用用户那份（D4），请求却由 pi-durable 那份的类型来消费。同版本实测能用，跨版本**未核**。
- **实验性 API**：1.5.0（2026-11-02）有三处破坏性变更，包括 `Storage.commit()` 的签名和工具 schema 从 typebox 换成 pi-schema（代码，`CHANGELOG.md`）。存储格式的迁移策略没读规范（`docs/spec.md`），**未核**。
- **要重写的不是适配层，是 harness 本身**：今天的 worker 建在 `createAgentSession` 上，拿到的是 pi 的技能加载、系统提示、压缩、扩展和会话文件。pi-durable 是另一套运行时，这些都要用它的 extension、section、`CodingTools` 重新接。ADR 0023 D3（不做发现）、D10（保留 worker）也要重新定义。
- **Bun**：ADR 0023 的 worker 是 Bun 子进程。自带 SQLite 存储在 Bun 下不能用，官方只声明支持 Node。

## 判断

以下是我的看法，不是决定。

1. **它解决的问题是真的，但对 bot 聊天不大。** 今天丢的是一轮回复，代价是用户再发一次或 `/retry`。更实在的缺口有两个，都不需要 pi-durable：
   - serve 重启后这一轮在记录里什么都不留。
   - 被打断的回复不会自动续上。
2. **现在不该把 `pi` harness 换成它。** 等人回答的闸门还没发布，API 标着实验性并且两周内刚破坏过一次，Bun 不在支持范围内，而且换它等于重写 harness 并推翻 D6、D9。
3. **记录的唯一来源应当还是 operad 的事实。** 如果以后用它，我倾向把 pi-durable 的存储当成 agent 的私有状态（今天 pi 会话文件的位置），用 `watch()` 或 `observeCommits()` 把已提交的条目幂等地抄成事实。这样 ADR 0027 D2 不用改，代价是两个提交点之间靠追赶对齐。
4. **选项**：
   - **等**：等 pi-coding-agent 自己建在 durable 上，或至少等 signals 和 gates 发布并去掉 Experimental。那时 D6、D9 的冲突自然消失。代价是时间不由我们定。
   - **旁边加一个实验性 harness**（比如叫 `pi-durable`，名字要 owner 定）：不动 `pi`，只给愿意试的 bot 用。代价是多维护一套，以及 operad 第一次自己依赖 pi 的包。
   - **先补今天的两个缺口**：serve 重启时也记下已完成的条目和一条 "stopped"；被中断的回复自动重试一次或提示 `/retry`。这和 pi-durable 无关，收益马上有。
5. **建议**：先做第三项，第一项作为默认立场。只有当 owner 想让 bot 跑很长的、带等人步骤的任务时，才值得做下面的 spike。

## 如果做 spike，最小范围

目标只回答一个问题：一次真实的 bot 回复，在 serve 被杀之后能不能续上，并且 operad 的记录是对的。

- 在 operad 仓库之外的临时目录里，一个 Bun 子进程：pi-durable 加 `bun:sqlite` 适配层，owner 的 `ModelRuntime`，`CodingTools`，一个把访问档案接到 `beforeTool` 的 extension。
- 一个把 `watch()` 的已提交条目写成和今天同形状的条目事实的同步器，带幂等键。
- 三个检查，每个都真的杀进程：
  1. 工具中途杀掉，重开后回复完成，条目事实不重不漏。
  2. 模型流式输出中途杀掉，重开后答案完整，用量算对。
  3. 回复中途发一条消息（steer），它在记录里的位置和 T-0565 的规则一致。
- 先跑一遍 `registerStorageConformance`，确认 `bun:sqlite` 适配层合格。
- 不做：MCP、询问、技能、压缩、保留 worker、任何对 `packages/` 的改动。

## 没有验证的事项汇总

- `bun:sqlite` 适配层没有跑官方的存储一致性测试。
- pi-durable 的表和 operad 的库共用一个 SQLite 文件。
- pi-durable 的 pi-ai 和用户 pi 的 pi-ai 版本不一致时能否混用。
- `harness.close()` 后进程不退出的原因。
- `zai` 和 `models.json` 自定义 provider。
- 进程死在模型请求中途的行为（只读了文档，探针只杀在工具中途）。
- `main` 上的 signals、停放的工具和闸门（只读了 README，没有可安装的版本）。
- MCP 工具包成 `defineTool`。
- 崩溃的那一轮，今天的 pi 往会话文件里写了多少。
- pi-durable 的规范 `docs/spec.md` 和存储格式迁移策略没读。
