# operad-first-run：装完就能用，不用先学 operad

- 状态：decided（owner，2026-11-21）；任务切分是草稿，等 lead 审
- 涉及 ADR：0012（D2、D4）、0022（D6）、0023（D4、D9）、0030、0028、0034、0001（D1、D6）、0008、0014
- 涉及：`operad-bot.md`；`operad-harness-pi.md`；`operad-dev-flows.md`；`operad-desktop.md`
- 来源：owner 2026-11-21 的讨论；`research/2026-11-19-pi-durable.md`（第 6 节和「判断」）；`docs/user/setup-prompt.md`

## 背景

今天新用户在看到任何结果之前要敲 9 条命令（README 的 Quickstart），理解 home、repo、plan、task、confirm、auto、serve、pending，写 `.operad/dev.json` 和两个 markdown 文件，还要先装好并登录 `claude`、`pi` 或 `radian` 之一。目标：`bun add -g @operad-io/cli` 之后敲 `operad`，登录一次模型提供商，就在和默认 bot 对话；dev 等用户要用时再开。

## 已定但还没做

1. **新 home 默认走个人助理，dev 默认不开**（owner，2026-11-21）。
   - 新 home 开 `chat`、`bot`、`memory` 和找到的 agent；`dev`、`shell`、`pool` 关着，由第 3 条开启。
   - 已有 `config.json` 的 home 不改（ADR 0012 D2 已有这句）。
   - 要改 ADR 0012 D2 的默认插件列表，以及 CLI 里的 `defaultPluginsFor`（`packages/cli/src/defaults.ts`）。默认的 `mcp.actions` 现在除 `chat:close` 外全是 `dev:*`（ADR 0034），dev 关着时这些动作怎么写要一起定。
2. **`operad` 不带参数就进对话**。没有 home 就建，没有 `serve` 就起（`operad tui` 已经这么做），打开默认 bot 的 chat，光标在输入框。今天不带参数只打印 usage。桌面端和 iOS 同理。
3. **dev 的设置一键完成，用准备好的 prompt**（owner，2026-11-21）。
   - 入口两个：在 chat 里说一句，或设置里的一个按钮；两者都把 `docs/user/setup-prompt.md` 那份 prompt 交给 bot。
   - bot 读仓库的 CI 和脚本，写出 `dev.json`；结果是一个待处理项，内容是开启 dev 插件、这份 `dev.json`、注册仓库，人批准后才落盘（沿用 ADR 0030 的提议）。
   - 第一个任务也可以从 chat 发起，由 bot 建 plan 和 task；plan、task、auto 这些词到这时才出现。
4. **没有任何 agent 时用内置的 pi**（owner，2026-11-21；推翻 2026-11-19 的"先不用了"，理由是上手阻力：没有 agent 的用户今天在 `operad init` 就失败）。
   - 用户 `PATH` 上有 `pi` 就用用户的，和今天一样；没有就用 operad 装的那份，版本钉死，随 operad 发版升级。
   - 不进 `@operad-io/cli` 的依赖：`@operad-io/harness-pi` 依赖 `@earendil-works/pi-coding-agent`，按 ADR 0012 D4 在开启插件时装进 operad home，基础安装不变重。pi 1.6.0 有二十多个直接依赖（含 `pi-tui` 和两个 wasm 包），装一次量出体积和时间。
   - 要改 ADR 0022 D6（operad 不安装 harness）和 ADR 0023 D9（不内置 pi）。进程仍是 Bun 子进程 worker，不学 OpenClaw 进程内调用。
   - radian 是 Homebrew 的二进制，要按平台分发；`dev:chat` 也不接受它（ADR 0028 D2）。先只内置 pi（owner 已定）。
5. **第一次登录由 operad 引导**（owner 选了这条，2026-11-21）。
   - 用 pi 库的 `ModelRuntime.login(providerId, type, interaction)`：`type` 是 `oauth` 或 `api_key`，`interaction` 只有 `prompt()` 和 `notify()`，由 operad 接到自己的界面。贴 API key 是同一个入口的另一个选项，不另做一套。
   - 凭据仍写到 `~/.pi/agent/auth.json`，ADR 0023 D4 不变；用户以后自己装 pi，登录是通的。
   - 登录发生在第一条消息之前，没有 agent 能回话，所以它是一个待处理项（"默认 bot 还没有可用的模型登录"，动作是选提供商并登录），终端、桌面端、iOS 走同一条路，不加新的用户词。
6. **pi-durable 这次不带**（owner 同意，2026-11-21）。它解决的是回复跨过重启，和上手无关，换它等于重写 harness；1.6.0 发布了 signals，但 README 仍标 Experimental，自带的 SQLite 存储仍只有 Node 入口。内置 pi 之后 pi-ai 只有一份，以后在旁边加实验性 harness 更容易。顺序：先内置 pi-coding-agent；再补研究里的两个缺口（serve 重启后记下被打断的那一轮；被打断的回复提示 `/retry` 或自动重试一次）；pi-durable 等它去掉 Experimental 或 pi 自己建在它上面再看。

## 桌面应用

owner 2026-11-21：用户也可能只装桌面应用就开始用。下面的现状读自 operad-desktop `cd561eb`（一次只读调查，没有逐条复核）；改动落在 operad-desktop 仓库，任务在那边开，这里只记要点和会改 operad 的部分。

**已经具备的**

- 应用自带 `@operad-io/cli`（钉在 0.1.1）和运行它的 Bun，不需要 `PATH` 上的 `operad` 或 Bun；home 不存在时自己跑 `operad init`，serve 没起就自己起（desktop ADR 0001 D4）。
- 首页是 chats（desktop ADR 0005 D1）。
- 装插件的安装器用 `process.execPath` 跑 Bun（`packages/engine/src/plugin/install.ts`），所以第 4 条的"开启时装 pi"在应用自带的 Bun 下不用另做，首次需要联网。
- 加目录后已经用一份准备好的 prompt 开 chat 写 `dev.json`（`src/mainview/setup.ts`、`addfolder.tsx`），是第 3 条现成的雏形。

**要改的**

1. **引导的 agent 一步不再拦人**。今天没有 agent 时 Continue 是禁用的（`guide.tsx`），提示用户自己去装。改成：没有就由 operad 装内置的 pi，显示进度和失败原因。agent 列表（radian、claude、pi）和安装提示今天写死在应用里，"由 operad 安装的 pi"是一个新状态。
2. **引导里完成第一次登录**。今天 Agents 页只显示"已登录 / 未登录"，没有登录流程。第 5 条的待处理项要能显示：要在浏览器打开的地址、设备码（可复制）、粘贴 API key 的输入框（要遮住）。今天待处理项的表单只画文本、备注、枚举和枚举列表，没有密文字段，也没有设备码的显示；地址只有写在问题正文的 Markdown 里才可点。这一条同样落在 TUI 和 iOS 上。
3. **引导结束直接进默认 bot 的对话**。今天空列表显示"No open chats"，新建时要手选一个 bot 或 repo，应用自己不建 bot。需要 operad 在新 home 里就有默认 bot（核实 `operad init` 开了 `bot` 之后是否已有），应用把它预选好。
4. **dev 关着时的界面**。侧栏的 Dev 分组今天无条件画出；加目录不检查 dev 是否开着，直接调 `operad dev repo add`，dev 关着会报错。改成：dev 没开时 Dev 分组收成一个入口，点了走第 3 条的一键设置（开启 dev 是待处理项里的一部分）。今天那份 prompt 交给的是 `dev:chat` 的仓库 chat，dev 没开时没有这种 chat，要改成交给 bot，权限走一次性的 ask（owner 已定）。
5. **引导完成的标记跟着 home**。今天它记在应用自己的设置里，换了一个全新的 home 也会跳过引导。
6. **自带的 operad 和用户装的 CLI**。今天的顺序是：home 里记录的那个、`PATH` 上的、自带的。只装桌面应用的用户走自带的；以后又装了 CLI 时两边共用 `~/.operad`，版本不一致时用新的并提醒（见下面「owner 已定」）。
7. **装插件的进度**。今天只有一行"Installing …"。pi 的依赖不少，首次安装要有能看出在动的进度，以及断网时的说法。

**会改 operad 的**

- 待处理项里的登录要有通用的表达：地址、设备码、密文输入。这涉及 ADR 0008（问题的形状）和 ADR 0014（显示），三个客户端各画一次。
- 安装进度要能从 serve 读到（今天装插件是一次阻塞的调用）。
- 新 home 里默认 bot 的存在由 operad 保证，不由客户端创建。

## owner 已定（2026-11-21，原来的待决）

1. **定位不改，助理是入口，dev 是主产品。** ADR 0001 D1、D6 不动；README 和入口文案要让人知道助理后面有 dev。
2. **bot 做 dev 设置时的权限走一次性的 ask。** bot 读那个仓库、写它的 `.operad/dev.json` 时按访问档问人（ADR 0025），不给设置流程专门的授权。
3. **radian 先不内置**，只内置 pi。
4. **一键设置的用户词：`Setup Dev`，中文"配置开发流程"**（owner 批准的新词）。用在按钮和入口文案上；命令行要不要有对应的命令没有定。

## 桌面应用：owner 已定（2026-11-21）

- **自带的 operad 和 `PATH` 上的 CLI 版本不一致时用新的那个，并提醒用户。** 今天的顺序是 home 里记录的、`PATH` 上的、自带的，不比较版本。要定的细节：
  - 提醒说什么：哪一份旧、各是什么版本、怎么升级（旧的是 CLI 就给升级命令，旧的是应用就指向应用更新）。
  - 已经有 serve 在跑、而它是旧的那份时：提醒并提供重启，不自己重启，因为可能有运行中的任务。
  - 较新的 operad 写过的 home 不让旧的再打开；旧的那份此时怎么报错要核实。
- **pi 在首次运行时联网安装，不打进安装包；用户已经有 pi 就不装**（和第 4 条一致：`PATH` 上有 `pi` 就用用户的）。断网时说明原因并可重试；用户此时已有 `claude` 或 `radian` 也不装。

## 核实过的（2026-11-21，临时 home，实测）

- **dev、shell、pool 关着，chat、bot、memory 开着的 home 能用**：插件照常加载，`operad init` 之后默认 bot 已经存在，`bot:chat` 能开 chat 并收到回复，pending 为空。
- **pi 1.6.0 下 pi harness 能回复**：`pi.model` 写明 `openai-codex/gpt-5.6-terra` 时，一条消息正常收到回复。
- **没写模型时 pi 的 chat 失败，这正是新 home 的状态**：`pi.model` 没设时，回复以 "No API key found for the selected model" 失败；pi 1.5.2 和 1.6.0 都一样，而 `pi -p` 用自己的默认模型（`~/.pi/agent/settings.json` 的 `defaultProvider`、`defaultModel`）是正常的。ADR 0023 D4 说默认用用户 pi 的默认模型，worker 实际没有做到；根因没有查完（`index.ts` 的 `piDefaultModel` 只用在模型列表里，worker 在 `input.model` 为空时让 pi 自己选）。这是一个 bug，任务 1 之前要修。
- memory 开着并跑过 serve 之后，`default` 这个名字有歧义（`bot-tidy:default` 和 `bot:default`），命令行要写 `bot:default`。
- **`ModelRuntime.login` 在 Bun 子进程里的 OAuth 回调可用**（T-0678 探针，pi 1.6.0，离线模拟 token 交换）：`openai-codex` 的浏览器回调在 `127.0.0.1:1455` 收到 200 并完成登录、写入 `auth.json`；浏览器不回来时粘贴跳转地址可以完成；state 不对被拒；取消立即结束；1455 被占用时自动退回粘贴地址。探针保留在 `packages/harness/pi/test/heavy/oauth.test.ts`。

## 没有核实的

- operad 装的 pi 和用户自己的 pi 是两个版本时，读写同一份 `auth.json`（含 token 刷新）是否安全未核（研究第 6 节已记）。
- dev 关着时仓库上的 chat（`dev:chat`）没有；默认 `mcp.actions` 除 `chat:close` 外全是 `dev:*`。
- README、quickstart、troubleshooting 里写"需要一个带 remote 的仓库和一个 agent"的地方要跟着改。

## 任务切分（草稿，lead 审过再建 plan）

顺序即依赖。每个任务先改它涉及的 ADR（单独的 docs 提交），再改代码。

0. **修：pi 没写模型时用用户 pi 的默认模型**（bug，见上；已完成 T-0674）。新测试：`pi.model` 未设、pi 的设置里有默认模型时，worker 收到的是那个模型。
1. **新 home 默认走助理**（已完成 T-0675）。`defaultPluginsFor` 改成 `chat`、`bot`、`memory` 加找到的 agent；`dev`、`shell`、`pool` 不开；默认 `mcp.actions` 去掉没开的插件的动作；已有 home 不变。改 ADR 0012 D2、0034。README 和 quickstart 的第一段跟着改（定位不变）。
2. **`operad` 不带参数进默认 bot 的对话**（已完成 T-0676）。没有 home 就建，没有 serve 就起，打开 tui 并落在默认 bot 的新 chat 上。
3. **没有 agent 时由 operad 装 pi**（已完成 T-0677）。`@operad-io/harness-pi` 依赖 `@earendil-works/pi-coding-agent`（钉版本），按 ADR 0012 D4 在开启时装进 home；`PATH` 上有 `pi` 就用用户的；有 `claude` 或 `radian` 也不装；`operad init` 在没有 agent 时不再失败。改 ADR 0022 D6、0023 D9。安装进度能从 serve 读到，断网时说明原因并可重试。
4. **第一次登录是一个待处理项**（已完成 T-0678）。问题的形状里加地址、设备码、密文输入（改 ADR 0008、0014），TUI 先画出来；用 `ModelRuntime.login`；登录后选出默认模型。先做一个探针核实 Bun 子进程里的 OAuth 回调。
5. **`Setup Dev`（配置开发流程）**（已完成 T-0679）。入口把准备好的 prompt 交给 bot；bot 读仓库时走一次性的 ask；结果是一个待处理项（开启 dev、`dev.json`、注册仓库），批准后落盘。`docs/user/setup-prompt.md` 改成这个流程的来源。
6. **operad-desktop**（在那个仓库开任务，依赖 1 到 5）：引导的 agent 一步不再拦人并显示安装进度；引导里完成登录（地址、设备码、密文输入）；引导结束进默认 bot 的对话；dev 关着时 Dev 分组收成 `Setup Dev` 入口；引导完成的标记跟着 home；自带的 operad 和 `PATH` 上的比较版本，用新的并提醒。
7. **iOS**：登录的待处理项的显示（地址、设备码、密文输入）。

## 验收

- 一台没有 `claude`、`pi`、`radian` 的机器上：`bun add -g @operad-io/cli`，`operad`，登录一次，发一条消息并收到回复；中间不需要读文档，不出现 plan、task、repo、auto 这些词。
- 在对话里要求给一个仓库开 dev：出现一个待处理项，批准后 `operad dev repo list` 里有这个仓库，`operad pending` 里没有它的设置无效项。
- 已有的 home 升级后插件开关不变。
- 用户 `PATH` 上有 `pi` 时用的是用户那份，行为和今天一样。

## 发布前的核对（不挡任务合并）

- **ChatGPT 订阅登录的条款**（owner，2026-11-22）：pi 的 openai-codex 登录用的是 Codex CLI 的公开客户端身份，operad 作为第三方产品在自己的界面里用这个身份引导登录有条款风险（`docs/research/2026-11-21-pibot.md` 的"不该照搬"）。T-0678 照常用 pi 的登录；对外发布含这个登录入口的版本之前，核对一次 OpenAI 的条款，确认是否要注册 operad 自己的客户端。
- 调研已做（T-0702，2026-11-22）：`docs/research/2026-11-22-siwc-own-registration.md`。要点：OpenAI 的 Sign in with ChatGPT 允许开源客户端动态注册自己的 client（`dynamic_agent_client`），但签发的令牌只能调 `https://api.openai.com/v1/responses`，不是 pi 的 `openai-codex` 用的 `chatgpt.com/backend-api`，所以要给 pi 加一个新 provider，不是换 client id；没有设备码流程；`Request a client ID` 页写明目前只对“少数商业伙伴”开放，发布前要先确认 operad 能不能注册。
