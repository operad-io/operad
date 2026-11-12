# operad-contract：从场景倒推的内核结构与插件合约

- 状态：decided（全部条目；标注了哪些要在 `dev` 插件落地前进合约）
- 涉及 ADR：0024、0012、0020
- 涉及：`operad.md` 决定 12–17；`operad-plugins.md`；`operad-presentation.md`；`operad-channels.md` 决定 7–18；`operad-conversation.md`；`operad-sandbox.md`；`operad-bot.md`
- 来源：对话、知识库（可换后台）、记忆、来源插件、每日搜集这几个场景对内核的要求；radian arc 的 reviewer 被 429 吃掉十次 attempt 的教训

## 背景

内核只做五样事（`operad.md` 决定 12），其余都是插件。要让对话、知识库、记忆、来源、每日搜集这些场景都能写成插件而不改内核，合约必须在几处做得更通用，再补三个缺的原语。原则是不加功能：把已有的原语做通用，缺的只补三个（步骤内问人、资料、密钥）。下面每一条都对应一个场景提出的要求；没有场景要的不加。

## 决定（已定）

### 一、对象和事实：一种存储模型装下对话、笔记、任务

1. **`list(type, { where, cursor, limit })`**。插件在对象声明里列出可筛的字段（`index: ["plan", "phase"]`），内核只按这些字段筛；结果分页。对话按通道筛、任务按 plan 筛、几千篇笔记翻页，都是这一个调用。
2. **`facts(object, { cursor })` 加订阅**。消息、worker 日志、费用都是对象上的事实；显示接口的 `live` 段在事实上翻页。
3. **对象可以住在外面**。对象类型声明 `external: true` 时，插件自己提供 `list`、`get`（从 Obsidian 库、从 harness 的会话目录、从任何外部系统），对象变了调一次 `ctx.changed(ref)`；内核只存关于它的事实，不存它的内容。外部对象的 `list`、`get` 有超时（同 `row` 的 50 毫秒规则，可按类型放宽），超时按错误行显示。内核不索引任何插件的内容。

### 二、动作和输入：人只有一种操作方式

4. **动作的参数是带 JSON Schema 的 `args`**。`note` 和 `confirm` 变成 schema 上的标记（一个 `role: "note"` 的字符串字段；一个 `confirm: true` 的动作属性），不再是特例；命令行和 iOS 的行为不变，客户端按 schema 通用地画表单。`dev` 的 `auto` 是一个带枚举参数的动作，不是三个动作。
5. **每个来自人的输入带 `actor`**（`{ via: "ios" | "telegram" | "cli" | …, id }`），记进 `person_answered` 和动作的事实。通道名单、多设备、以后多人都靠它。

### 三、步骤：工作只有一种跑法

6. **步骤内问人** `ctx.ask({ prompt, choices, graceSecs?, onTimeout? })`，返回答案。这是唯一的内核新原语，分三段：
   - **宽限期**：进程挂着，答案来了立刻继续。宽限期三层可设，窄的覆盖宽的：全局默认（`config.json`，默认 600 秒）、flow 或对话一级（步骤参数或对象字段）、单次询问（`ctx.ask` 的参数）。`0` 表示不等；不提供无上限。
   - **超时暂停**：步骤以结果 `waiting` 结束，数据带等待 id、harness 的会话引用、问题本身；flow 用一条边 `waiting → wait_person` 接住，等人步骤沿用**同一个等待 id**，待处理里仍是同一项。此时没有进程，等多久都行。
   - **续接**：答案到了，流程回到同一个步骤，带 `resumeSession` 和一张一次性许可（只对这次问的那条命令或路径），prompt 加一句"你之前问 X，答案是 Y，继续"。harness 重发那次调用，许可让它直接过；它改做别的事照样要问。落地形状：步骤的 `resume` 是 `{ session, grant: { kind, value, choice, choices?, tool? } }`（有选项的问题必须写 `choice`，它给许可；`choices` 可以再列几个同样给许可的答案；无选项只有 `approve` 给；path 许可必须写 `tool`，只对这个工具有效；`ctx.ask` 在问人之前就拒绝不合格的写法，`grants: false` 的步骤不能带许可）；答案留在运行状态里直到发问的步骤再次运行，中间隔几个步骤也送到，流程回来时参数多 `resumeSession`、`askAnswer: { prompt, choice, note }`，访问档多 `grants: [{ waitId, kind, value }]`；许可由 `grant_used`（带等待 id）事实用掉，先写事实再放行那次调用。一次性许可的语义：`grant_used` 事实在放行那次调用之前写入，所以一张许可最多用一次；进程死在写事实之后、调用之前，那次调用不会被再次放行，会重新问人。步骤定义里的 `resumable` 是"描述文件决定"的那一位：明写 `false` 的步骤，`ctx.ask` 被强制为 `reject_once`。harness-radian 没有看得见工具调用的钩子，不能执行一次性许可，带许可的运行被它拒绝；harness-pi 在 `tool_call` 处理器里执行。
   内核记一条带步骤 effect id 的等人事实；答案带等待 id，只被用一次，落在哪一段都对；步骤早已结束的答案拒收并记事实。崩溃语义不变：进程没了按步骤的 `replay` 处理。流程级的 `wait_person` 保留给不占进程的长等待，flow 作者只能用它，不能用 `ctx.ask`。超时后的默认行为 `onTimeout` 是 `waiting`（要求 harness 能续接）或 `reject_once`（不能续接的 harness 的唯一选项，由描述文件决定，用户不可覆盖）。
7. **外部文字只以资料进来**。事件、消息、取回的条目、网页正文，一律是带来历（来源、时间、引用）的文件，由 `ctx.material` 给步骤；不以字符串出现在 params 里，内核从不把它放进任何提示词。这是 `operad-channels.md` 决定 10 推广到所有入口。
8. **标准事实形状**：`usage`（harness、模型、tokens、费用）和标准结束结果名（`done` | `nothing` | `failed` | `needs_decision` | `waiting` | `interrupted`）。所有 harness 一种形状，行尾的费用、度量、预算都从它读。
9. **步骤类型可以声明 `limit: { key, concurrent }`**，runner 按 key 排队。模型的并发和限流在这里管，插件不自己发明。

### 四、插件声明：一个插件是什么

10. **`settings`**：每个插件一份 JSON Schema，内核校验 `config.json` 里它那一段，给 `ctx.settings`。后台选择、库的路径、OAuth 应用 id 都放这，不再每个插件一个配置文件（`dev` 的每仓库 `.operad/dev.json` 是它自己的对象，不在此列）。
11. **`secrets`**：`ctx.secrets.get(name)`、`set(name, value)`，按插件作用域，存在日志之外（0600 文件，以后可换钥匙串），永不进事实、params、环境变量、`history`。登录态和作用域密钥是同一件事。`Secret` 类型已有，这是它的存放处。
12. **运行带一份访问档** `ctx.access`（`operad-sandbox.md`），对内核不透明；插件声明它能执行的字段（`enforces: ["denyPaths", "askCommands", …]`）；内核拒绝启动一个访问档要求了没人执行的字段的运行，并说出是哪个字段。内核不做沙箱，只保证没人悄悄忽略访问档。一次性许可（决定 6）是访问档数据的一部分。
13. 声明里再加三个字段：**`rules`**（默认触发规则，`operad-channels.md` 决定 16）、**`skills`**（随运行注入给 harness 的 `SKILL.md` 目录，flow 参数决定给哪些）、**`requires`**（依赖的插件和插件 API 版本，加载时检查、报清楚）。
14. **测试包 `@operad-io/engine/testing`**：假时钟、内存存储、`runFlow`、`answer`、`emit`，让一个 agent 不起 `serve` 就能写并测一个插件。这是"描述需求、agent 现写插件"那条路的前提。

### 不进内核的

逐 token 流、记忆、搜索索引、插件的后台、调度策略、通道投递、Markdown 渲染之外的客户端逻辑、任何平台的 API。对话场景用现有五个视图调用（`list conversation`、`transcript` 段、`act chat:send`）跑通，是合约够用的检验。

## 顺序

改变接口形状、要在 `dev` 插件的任务（T-0019 到 T-0023）落地前进合约的：1、2、4、5、10、11、12、`requires`。纯增量、以后加不破坏的：3、6、7、8、9、`skills`、14。其中 6 在 `operad-conversation` 之前做。

## 验收

`dev`、`chat`、一个带外部后台的测试插件（对象 `external: true`）和一个来源插件都只通过这份合约和内核打交道；一个步骤 `ctx.ask` 在宽限期内答、超时后答、答案迟到三种情况各有测试，待处理里始终只有一项；一个访问档要求 `askCommands` 而 harness 不声明 `enforces` 时运行被拒并说出字段；`history`、事实、params、环境变量里搜不到任何 `secrets` 的值；`operad plugin check` 对一个只用测试包写的插件通过。
