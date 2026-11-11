# operad-conversation：chat，从仓库或助理 profile 发起的长对话

- 状态：decided（方向与形状；2026-11-09 owner 定了两种 chat、harness 冻结、新建入口、MCP 工具、名词 chat；流式与附件未定）
- 涉及 ADR：0024、0018、0022、0049
- 涉及：`operad.md` 决定 12–17；`operad-presentation.md`；`operad-channels.md` 决定 7–15；`operad-harness.md`；`operad-sandbox.md`；`operad-assistant.md`；`operad-dev-flows.md` 决定 4
- 来源：owner 的使用场景；OpenClaw（聊天优先的个人助理）；2026-11-09 的讨论

## 背景

OpenClaw 是聊天优先，operad 到现在是流程优先。第一个要满足的场景是在 iOS 里和一个长期存在的助理对话：跨天、跨设备（手机和 Telegram 是同一个 chat），助理能用工具、读写知识库，中途会问人。今天 iOS 看到的是 radian 的会话（hub 加 control port），只认 radian，也不经过 operad。

2026-11-09 定下 chat 有两种：从一个仓库发起的，为这个仓库干活；从助理 profile 发起的，是日常助理。两种是同一个对象，差别只在从哪发起、工作目录和配置从哪读。

## 决定（已定）

1. **chat 是一个对象，用户看到的词就是 chat**（不用 conversation、session、对话；session 是每个 harness 对自己会话的叫法，用户会混）。它归 `chat` 基础插件（随 operad 安装）。对象字段：父对象、harness、工作目录、访问档（`operad-sandbox.md`）、skills、标题、harness 的会话引用（内部字段，用户看不到）、绑定的通道。消息是 chat 上的事实（谁、何时、正文、附件路径、来源引用），不是对象字段。`chat` 插件不知道仓库和 profile：这些字段都是创建它的插件在创建时给的。
2. **一条进来的消息是一个事件**：来源 `ios`、`telegram`、`cli`，`key` 是消息 id，`object` 是 chat 的 id。`chat` 插件自带规则：这类事件以 `auto` 启动 `chat:reply`（插件默认规则，`operad-channels.md` 决定 16）。
3. **`chat:reply` 只有一个步骤加一个回环**：从 chat 的事实里找出未回复的消息拼成 prompt（不靠事件的 data，所以运行在跑时到的消息也能被看到），用 harness 步骤续接 chat 的 harness 会话（`resumeSession`），把回复记成事实，更新会话引用；结束前再看一眼有没有回复期间新到的消息，有就再走一遍（`maxVisits` 封顶）。回复先记事实再算步骤完成：serve 重启后重跑的步骤看到已有回复就跳过，不回两遍。chat 的上下文长度是 harness 的事（radian 自动压缩，ADR 0018）；内核不存任何提示词。
4. **发消息就是一个带 `note` 的动作**：`chat:send <chat> --note <正文>`。iOS 的输入框、命令行、Telegram 通道都走它，客户端 API 不加新调用。附件以后再加。
5. **iOS 看 chat 走已有的显示接口**：列表是 `list chat`，chat 挂在父对象（repository 或 profile）下显示；chat 页是 `transcript` 段（`live`，按 `events` 刷新，目前后台最慢半秒）加输入框。第一版按消息刷新，不做逐 token 流。
6. **中途问人**：助理在 chat 里问问题或要权限（ACP `request_permission`、radian 的 `ask_user`、claude 的 `canUseTool`、pi 的 `tool_call`）时走 `ctx.ask`，问题成为待处理项（对象是这个 chat），iOS 和 Telegram 都能答；宽限期（可设，默认 10 分钟）内答了立刻继续；超时按 `operad-contract.md` 决定 6：步骤以 `waiting` 结束、进程退出、同一项留在待处理里，答案来了用会话续接回到同一步。只有不能续接的 harness 才在超时时拒绝一次。
7. **一个 chat 可以绑定多个通道**：Telegram 的一个 chat 绑到一个 operad chat 后，那里的消息进同一个 chat，回复送回来源通道，iOS 全都看得到。默认每个（通道，chat）一个 operad chat，用 `assistant` 的默认 profile 建；iOS 新建的 chat 不绑通道。
8. **chat 的记忆是知识库，不是引擎**：助理跨 chat 记得的东西写在 `operad-assistant.md` 定的 Markdown 知识库里，由 skill 规定怎么读写；引擎只存 chat 记录。radian 自己的 memory（ADR 0021）不参与。
9. **每个 chat 有访问档**：工作目录、禁入目录、危险命令，见 `operad-sandbox.md`；危险命令触发的询问走决定 6。
10. **iOS 的后端换成 operad**：`operad serve` 把显示接口（`list`、`get`、`section`、`events`、`act`）按 `operad-presentation.md` 决定 7 暴露成 HTTP：只听本机和局域网或 Tailscale 地址，必须带 token，`events` 用 SSE；推送沿用 arc iOS 今天的通道。hub 的会话路由在 chat 跑通之后退役（`operad.md` 待决 3 由此有答案）。已完成（P-0003-http-api）。
11. **iOS app 改名 operad，只连 operad。** 今天的 arc app（仓库 `radian-ios`）改名为 operad app，后端只有 `operad serve`，不再连 radian hub，也不保留两套后端过渡。app 不认识任何插件：`dev` 的计划和任务、`chat` 的 chat 都按 `operad-presentation.md` 的通用对象界面显示和操作。已完成（P-0002、P-0003）。
12. **两种 chat，按发起点分**（2026-11-09 owner 定）：
    - **仓库 chat**：`dev` 在 repository 上的动作 `dev:chat` 创建，父对象是 repository，工作目录是仓库，harness 和访问档从 `.operad/dev.json` 读。用途是围绕这个仓库讨论、开 plan 和 task、看运行。
    - **助理 chat**：`assistant` 插件在 profile 上的动作 `assistant:chat` 创建，父对象是 profile，工作目录、skills、访问档从 profile 读（`operad-assistant.md`）。
    - 新建就是对父对象做动作，参数是 harness（枚举，已加载的 harness 插件；默认值来自 `dev.json` 或 profile）和标题，客户端用已有的参数表单画。内核不加类型级动作，不加新对象。继续一个旧 chat 就是打开它再 `chat:send`。
13. **harness 每个 chat 自己选，开始后不换**；要换就新建（和 task 开工后不换 flow 同一个规矩）。各 harness 的能力按描述文件照实显示：radian 没有一次性许可，它的 chat 里助理问权限只能拒绝一次（`operad-contract.md` 决定 6），新建时就说明，不等启动后才发现。三种 harness 同时接，ask 闭环在 claude 和 pi 上做，radian 是降级那一档。**仓库 chat 只提供能在工具调用开始前拦下它的 harness（今天是 claude 和 pi），默认用其中第一个；radian 只能在调用开始后从 journal 看到，拦不住，做不到决定 14 的只读，所以不出现在 `dev:chat` 的选项里，只用于助理 chat。**（2026-11-10 owner 定，T-0188 review 发现）
14. **仓库 chat 默认在 main clone，只读**。agent 判断要改代码时用 `ctx.ask` 问要不要开 worktree；答应后 `dev` 开一个 `work/chat-<id>` 的 worktree，chat 的工作目录切过去（只切这一次），那里可写，main clone 仍只读。worktree 里的改动只能由这个 chat 开出的、指向这个 worktree 的 task 经 integrate 进 main（`operad-dev-flows.md` 决定 4 的硬约束不变）。
15. **chat 通过 operad 的 MCP 工具调用插件**，不在 shell 里敲 `operad` 命令：`operad mcp` 的读工具、插件动词和允许列表里的动作挂进 harness（claude 和 radian 用 stdio MCP（`mcpServers`、`--mcp-config`），pi `customTools`，见 `operad-harness.md` 决定 3、4；claude 不用 `createSdkMcpServer` 的原因见那里，2026-11-10）。助理 chat 看任务、开 task、问一个 task 为什么卡住，都走它，不自己改仓库文件；仓库 chat 同样。T-0175（lead 用 MCP 能做 shell 里能做的事）是前置。
16. **第一版不导入 operad 之外开的会话**（终端里的 Claude Code、pi 的会话）。以后做时是 `chat` 插件加一个 `external: true` 的对象类型（`operad-contract.md` 决定 3），内核不动。

## 顺序

HTTP 接口（决定 10）和 app 换后端（决定 11）已完成。剩下按这个顺序：先做 ask 闭环（access-match 的 `askCommands` 判定；claude 的 `canUseTool` 和 pi 的 `tool_call` 调 `ctx.ask`，宽限期、`waiting`、续接加一次性许可三段都走通），它不依赖 chat，也是 `operad-sandbox.md` 第一版的一半；再做 `chat` 基础插件加 `dev:chat`；再做 `assistant` 插件的 profile 和 `assistant:chat`；最后 app 只加 chat 页的输入框。前置：`harness-*` 的 `resumeSession`（已有）、显示接口、事件与规则（已有）、T-0175。

## 待决问题（未定）

1. 逐 token 流：harness 的事件流（ACP `session/update`、SDK `includePartialMessages`）由 `operad serve` 转成带游标的 live 段，还是另开一条流。
2. 附件（图片、文件）怎么进消息、存哪、怎么给 harness。
3. chat 的归档和删除；记录保留多久。
4. 仓库 chat 开出的 worktree 怎么变成 task：task 的第一次尝试直接用这个 worktree，还是 task 新开 worktree 再 cherry-pick；worktree 没变成 task 就被遗忘时谁清理。
5. 一个 chat 的 harness 会话随天数变大，每轮续接都带全量上下文；压缩是 harness 的事，但 chat 比 task 更早撞到费用，要不要在对象上显示累计费用并给一个"从这里重新开始"的动作。

## 验收

在 iPhone 上从一个 repository 行新建一个 chat，再从助理的默认 profile 行新建一个 chat，两个 chat 各用不同的 harness；连续三天每天几轮，助理能接上前面的内容；中间它问一次权限，在手机上答；仓库 chat 里它提出要改代码，答应后它在新 worktree 里改，并开出一个 task；同一个 chat 绑定一个 Telegram chat，从 Telegram 发一句，iPhone 上看到问答；把 `operad serve` 杀掉再起来，chat 和待处理都还在；没有任何内部词出现在手机上。
