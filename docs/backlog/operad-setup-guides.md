# operad-setup-guides：每个插件带一份设置向导，由 bot 一步一步带着做

- 状态：方向 owner 已同意（2026-11-22）；三点 owner 已定（见「决定」，2026-11-22）；第一步（从 Setup Dev 提炼机制）由 T-0696 做，写进 ADR 0010 D7、0012 D2、0030 D15；Telegram 是下一个任务
- 涉及 ADR：0010（插件声明）、0011（D2 技能）、0012（D2 开关）、0008（问题的形状）、0030（bot 的提议）、0033（telegram）、0010（D2 密钥）
- 涉及：`operad-first-run.md`（`Setup Dev` 是第一个实例，T-0678 做密文输入）；`operad-telegram.md`；`operad-bot.md`
- 来源：owner 2026-11-22 的讨论

## 背景

owner 的要求：要有一些用 prompt 驱动的向导，一步一步带用户设置。举的例子：在一个项目里开 dev；开 Telegram；其他需要设置的功能。

今天设置一个功能靠读文档、敲命令、手改 `config.json`。Telegram 的文档是五步，其中"找到自己的数字 user id"和"把它写进 `config.json`"对新用户很难。`Setup Dev`（T-0679）已经是一个向导，但它是为 dev 单独做的。

## 提议的形状（owner 同意方向，细节没有逐条确认）

1. **是一种机制，不是每个功能手写一个向导**。每个插件带自己的一份，`Setup Dev` 是第一个实例，Telegram 是第二个。
2. **一份向导有两部分，都由插件提供**：
   - 检查（代码）：插件报告自己还缺什么。插件声明里今天已有 `check`（`packages/engine/src/plugin/types.ts`），返回一行文字，`operad init` 打印它（如 `dev: no repositories registered`）。向导需要它返回结构化的结果：一组缺项，每项有名字和说明。
   - 引导（prompt）：一份写给 bot 的说明，格式是 `SKILL.md`（ADR 0011 D2）。bot 读检查结果，只带用户走还缺的步骤。
   - "设置好了没有"由检查判断，不靠 agent 的说法。
3. **步骤只有四种**：
   - 用户去外部做一件事：bot 说明要做什么，等用户回来。普通对话。
   - 填密钥：遮住的输入框，值直接进插件的密钥（ADR 0010 D2），不经过 agent、对话记录和日志。输入框由 T-0678 做。
   - 改设置：bot 提议，出待处理项，人批准后落盘（ADR 0030）。开启插件也是这一种。
   - 验证：插件代码去试一次（比如用 token 调一次 Telegram），把结果给 bot。这一种要新做。
4. **Telegram 的向导**（今天的五步变成）：
   - bot 说明去 BotFather 新建一个机器人，提醒不要复用别的程序在用的。
   - 用户在遮住的输入框里贴 token。
   - 插件验证 token，报出机器人的名字。
   - bot 让用户给机器人发一条消息；向导问"这是你吗"，显示名字和 id，确认后加入 `telegram.users`。用户不用自己查 id，不用改 `config.json`。
   - 回一条测试消息，完成。
5. **入口三处**（建议，待决 1）：对话里说一句或敲命令；设置里每个插件一个按钮；插件没设置好时在它的页面上显示还缺什么。
6. **其他候选**，按新用户会遇到的先后：连手机（配对，以及不在同一局域网时的远程访问）；加一个 agent（已有 pi，再加 claude 或 codex）；知识库指到自己的笔记库；定时任务；在 Claude Code 里接上 operad 的 MCP。

## 决定（owner 2026-11-22，按 lead 的建议）

1. **入口**：三处都要：对话里说一句或敲命令；设置里每个插件一个按钮；插件没设置好时在它的页面上显示还缺什么。
2. **用词**：统一用"Setup 加名字"（英文 `Setup <名字>`，中文"配置 <名字>"，如 Setup Telegram / 配置 Telegram），不再逐个批准。对话里的命令跟同一格式（`setup <名字>`）；具体命令形式切任务时写进任务说明，由 lead 审。
3. **顺序**：等 T-0679 合并后，先从 `Setup Dev` 提炼出机制，再做 Telegram。

## 核实过的

- Telegram 对不在名单里的发送者：`packages/telegram/src/source.ts` 只记下这条更新的 key 和正文第一行的摘要（`summaryOf`），不开 chat、不回复，也不留发送者的 id 和名字。向导要问"这是你吗"，得让插件新记下发送者的 id 和显示名（lead 2026-11-22 核实）。

## 核实的结果（T-0696，2026-11-22）

- **bot 看得到没开启的插件的向导和检查吗？** 向导看得到，检查不运行。`config.json` 里关掉的条目仍写着模块路径，内核能 `import` 它读出 `guide`；`dev` 这类随发行版带的、`config.json` 里没有条目的插件，用 `pluginOffer` 的模块表。检查要插件加载后的上下文（设置、密钥、store），没开启时不加载，所以不运行：没开启的插件只报一个缺项 `enable`。不需要改 ADR 0002 D1-D4；ADR 0010 D7 和 0012 D2 写了这一点。不在 `config.json` 里、也不是随发行版带的插件，要先 `operad plugin add`。
- **`Setup Dev` 是什么形状、能提炼多少？** 是 bot 包里的一份 prompt（`setupDevPrompt`）加一个 `setup-dev` 命令（没有 stdin 答步骤，有 `dev.json` 就提议）、一个开聊天的 `setup-dev` 动作，和 bot 聊天开头的一行提示。能提炼的：prompt 文本移到 dev 包的 `skills/setup/SKILL.md`，由 `guide` 声明；命令、动作、聊天命令和提示行变成通用的 `bot setup <bot> <插件> [目标]`、`bot:setup`、`/setup <插件> [目标]`。不能提炼的：提议、审阅和批准（`bot-proposal` 的 `dev` 种类）仍是 dev 专用，因为"改设置，人批准后落盘"这一类步骤今天只有 Setup Dev 一个实例，Telegram 任务要加第二个时再抽（这是下一步）。
- **验证这一种步骤的结果怎么交给 bot？** 作为检查的一部分，不另做动作。检查本来就由插件代码做，bot 在一步做完后再取一次缺项（`bot setup` 重新运行检查），缺项没了就是验证通过；缺项里的说明可以带失败原因（如"token 被 Telegram 拒绝"）。需要"试一次"的副作用（给用户回一条测试消息）是 Telegram 任务里该插件自己的动作，不在内核里。

## 入口（T-0696 已做的部分）

- 对话里：每个 bot 聊天开头一行提示；命令 `/setup <插件> [目标]`（聊天命令，把向导发进同一个聊天）。
- 设置里每个插件一个按钮：`GET /v1/plugins` 的行带 `guide: true`，按钮的动作是 bot 上的 `setup`（`plugin`、`target`），标题 `Setup <名字>`。客户端没做。
- 插件页显示缺什么：`GET /v1/plugins/<名字>/setup` 返回 `{ plugin, enabled, missing }`。客户端没做。

## 验收

- 新用户在对话里说"帮我设置 Telegram"，全程不碰命令行和配置文件，最后在 Telegram 里收到 bot 的回复。
- token 不出现在对话记录、历史和日志里。
- 设置做到一半退出，下次进来向导只带还缺的步骤。
- 第三方插件带一份向导和检查，不改客户端就能用同一套入口。
