# operad-newcomer-cli：命令行对新手的说法

- 状态：owner 2026-11-22 同意方向和 lead 对三个待决的建议（见「决定」）；先切第 1、2、3 条和 `operad doctor`，第 4 到 8 条之后再切
- 涉及 ADR：没有逐条核对。估计会碰 0012（插件开关，第 3 条）、0013（动作即命令，第 1、2、5 条的报错和帮助）、0017（设置，第 6 条）；开工前由 lead 核对
- 涉及：`operad-first-run.md`（新 home 默认 dev 关着，是第 2、3 条的起因）；`operad-setup-guides.md`（第 2、3 条指向 `Setup Dev`）
- 来源：owner 2026-11-22 问"可用性、新手友好还有什么建议"；用一个临时 home（`OPERAD_HOME` 指到临时目录，main `fb7d1ea3`）把命令逐条敲了一遍，下面的输出都是实测

## 背景

`operad-first-run.md` 解决"装完就能对话"，`operad-setup-guides.md` 解决"设置一个功能"。这一份是两者之外的：新手在命令行上敲错、敲早、敲完不知道下一步时，operad 说的话。

## 条目（按建议的先后）

1. **出错时不打印整份用法。**
   - 现状：任何错误（`operad pendng`、`operad list`、`operad plugin`、`operad version`）都在错误后面跟上约 35 行用法，那一句错误被顶出屏幕。
   - 建议：只打印错误，加一行指向 `operad --help`。命令敲错时给最接近的命令；`operad show nope` 已经会打印 `closest:`，同一套办法用到命令名上。
   - 完成（T-0690）：错误后不再打印整份用法；敲错命令给出 `closest:`，缺参数时给出该命令的一行用法，最后一行指向 `operad --help`。

2. **插件没开时说它没开。**
   - 现状：dev 关着时 `operad dev plan add` 得到 `operad: unknown command "dev"`。新 home 默认 dev 是关的，照着旧教程敲的人都会遇到。
   - 建议：命令属于一个已安装但没开启的插件时，说这个插件没开启，并指向 `Setup Dev` 或 `operad plugin enable dev`。
   - 完成（T-0691）：命令或 `<插件>:<动作>` 属于没开启的出厂插件时，说 `plugin "dev" is disabled; turn it on with `operad plugin enable dev``；不用加载插件，名字来自出厂可选插件表。`Setup Dev` 的提示等它合并后再加。

3. **开启一个插件时处理它依赖的插件。**
   - 现状：`operad plugin enable dev` 只打印 `dev: enabled`。pool 没开时，要到 `operad pending` 才看到 `plugin pool is not loaded and dev runs its workers through it ... until then no new work starts`。README 让人手敲三条 enable。
   - 建议：开启时当场说还缺哪些插件；是否顺带开启要定（见待决 2）。
   - 完成（T-0692）：`operad plugin enable dev` 顺带开启 pool 和 shell，每开一个打印一行；已开的不打印；关闭仍按单个插件。HTTP 开关走同一段代码。

4. **成功的命令末尾给下一步。**
   - `operad init`：最后没有下一步；agent 的几行是内部细节，例如 `claude: claude 2.1.330 at /Users/…/2.1.330 (floor 2.1.319); agent sdk 0.3.319; login claude.ai (max); the worker program is available`。建议默认只说"可用、已登录"，细节放到一个详细开关后面，最后一行写下一步。
   - `operad dev plan add`：只回 `P-0001-hello`。建议加一句下一步是加 task。
   - `operad dev:confirm`：新 plan 的 auto 是 off，确认之后什么都不开始，README 只在注释里提醒。建议确认后说明没有任何任务会开始，以及怎么让它开始。

5. **`operad --help` 分组。**
   - 现状：一张平铺的表，`pending` 和 `trigger rules`、`http token rotate` 并列；没有提不带参数的 `operad` 进对话；插件的命令只有一行 `<plugin> <verb>`，看不到 dev 有哪些；`serve` 的说明是 `run the kernel loop for this home`。
   - 建议：分成日常、设置、高级三组；第一行写不带参数的用法；`operad dev`（只敲插件名）列出它的子命令；`kernel loop` 换成用户的说法。

6. **`operad settings` 的默认输出。**
   - 现状：每个设置一行，名字、值、默认值、是否可改、标题、说明全在一行；`memory.wikiDir` 那一行有四五百个字符。
   - 建议：默认只显示名字、值、是否可改；说明在查看单个设置时显示。`--json` 不变。

7. **README 开头的例子有两种 id。**
   - 现状：`operad pending` 的输出里是 `4c1e9a02`，下一行 `operad dev:merge T-0022-token-rotate --yes` 用的是另一个。
   - 建议：例子里让人看得出该抄哪一个。

8. **一份"五分钟看到结果"的教程。**
   - 现状：`docs/user/quickstart.md` 第二节就讲 `failed.match`、`failed.stress`；`docs/user/dev.md` 有 1114 行。
   - 建议：一个示例仓库加每一步的预期输出，走完一次"任务、检查、评审、合并"；配置放在这之后。

## 决定（owner 2026-11-22，按 lead 的建议）

1. **加 `operad doctor`**（新用户词，已批准）。只读不改：列出插件、agent、登录、serve、测试机是否正常；有问题的每一项给下一步要敲的命令。不用 `status`：`operad status` 已是 chat 的动作。
2. **开启 dev 时顺带开启它依赖的 pool 和 shell**，并当场说一句开了哪些；以后可以单独关。
3. **`--help` 分三组**：日常（不带参数的 `operad`、`pending`、`list`、`show`、`history`、`running`）；设置（`init`、`settings`、`plugin`、`secret`、`pair`）；高级（`trigger`、`trigger rules`、`operad:start`、`operad:dismiss`、`flows`、`plugin check`、`http token rotate`、`mcp`、`serve stop`）。

## 核实过的

- 上面每条"现状"里的输出都是 2026-11-22 在临时 home 里敲出来的。
- dev 开着、pool 没开时，`operad pending` 里有 `dev:plugin:pool` 这一项，说明写得清楚，只是出现得晚。
- `operad dev:confirm` 对没有 task 的 plan 的拒绝写得清楚：`P-0001-hello is a draft with no tasks; dev:confirm works once it has a task`。

## 没有核实的

- 每条会改哪些 ADR。
- 第 2 条：没开启的插件声明了哪些命令，命令行此时能不能读到（`operad-setup-guides.md` 的"没有核实的"第一条是同一个问题）。
- 第 3 条：dev 没有 shell 时会怎样；这次只试了没有 pool。
- 不带参数的 `operad` 和 `operad tui` 这次没有试（要交互终端）。

## 验收

- 敲错一个命令：输出不超过五行，有最接近的命令。
- 新 home 里敲 `operad dev plan add`：输出说 dev 没开启和怎么开启，不出现 `unknown command`。
- 开启 dev 之后，不用看 `operad pending` 就知道还缺什么。
- `operad init`、`dev plan add`、`dev:confirm` 成功后各有一句下一步。
