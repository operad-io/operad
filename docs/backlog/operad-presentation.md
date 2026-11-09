# operad-presentation：插件在命令行、TUI、iOS 上怎么显示和操作

- 状态：decided（接口；TUI 和 iOS 的实现是以后的计划）
- 涉及：`operad.md` 决定 12–17；`operad-plugins.md`
- 来源：radian arc 的命令行、arc TUI、arc iOS app

## 背景

客户端（命令行、TUI、iOS，以后的网页）不认识任何插件，否则每加一个插件就要改每个客户端，agent 现写的插件也没法立刻在手机上用。插件只产出内容，客户端只渲染，内核负责传输。

## 决定（已定）

1. **动作就是命令，名字是 `插件:动作`。** 命令行 `operad dev:confirm <id>`（也接受 `operad dev confirm <id>`，不冲突时 `operad confirm <id>`）；TUI 里按 `:` 打开命令面板，模糊匹配 `插件:动作`，作用于当前选中的对象，只列出它能用的动作和绑定的键；iOS 在对象页的 `⋯` 菜单里列出同样的动作。不在对象上时，面板列出不需要对象的命令（如 `dev:task-add`）。
2. **动作声明参数（JSON Schema）和 `confirm`**：参数里 `role: "note"` 的字符串是要填的说明（如 `dev:reject`），`confirm: true` 在执行前确认（如 `dev:merge`、`dev:cancel`）。命令行按 schema 生成 `--<名字>`，终端里缺了必填的 note 就提示输入；`confirm` 问 `[y/N]`，`--yes` 跳过。
3. **快捷键两层**：插件可以带一份默认绑定（`{ "m": "dev:merge" }`）；用户在 `~/.operad/keys.json` 用同样的格式覆盖，用户的优先。两个插件的默认键冲突时后加载的不生效，启动时提示一行，面板里照样能用。
4. **显示接口**，每种对象三个函数：
   - `row(object)` → `{ id, title, state, note?, parent? }`：列表里的一行。`parent` 是上一层对象的 id（见决定 9）。必须是纯函数且快，只读已存的对象数据，不跑 git、不起进程。`note` 是行尾的一小段（费用、耗时）。
   - `sections(object)` → `[{ id, title, live? }]`：详情页有哪几段，只是目录。`live` 表示内容还在增长（worker 的日志）。
   - `load(ctx, object, sectionId, { cursor })` → `{ markdown, next? }`：一段的内容，只在用户打开时调用，可以慢；太长就分页。
5. **内容只有 Markdown 一种**（CommonMark 加 GFM 表格和围栏代码块）：diff 是 ```` ```diff ````，表格是 GFM 表格，图是 ```` ```mermaid ````。每个客户端只要一个渲染器；命令行在终端里转成带颜色的文本，`--raw` 给原文。逐文件的 diff 靠把每个文件做成一段来表达，不加新的内容类型。
6. **内核做的事**：列表上给每行加两个它自己知道的标记，**等人**和**在跑**，两个标记盖过行的 `mark`（决定 10）：等人的行一律画成等人，在跑而插件没给 `mark` 的行画成在跑；详情末尾自动加一段**历史**；`load` 有超时和大小上限，截断时说明完整内容怎么看（`operad show <id> --section <段> --full`）；对象一变就推“某 id 变了”，客户端重取 `row` 和打开着的 `live` 段。
7. **客户端的 API**，三个客户端共用：`list <类型>`、`get <id>`（row、段的目录、可用动作）、`section <id> <段> [cursor]`、`events`（变化推送）、`act <插件:动作> <id> [note]`，以及决定 11 的 `settings` 和 `set`。命令行在本机直接调用，TUI 和 iOS 走同样的接口。
8. **插件不碰颜色、布局、导航。** 插件给的是语义（决定 10 的 `mark`），不是颜色或图标名。 主按钮是第一个动作，其余在 `⋯`；需要确认的动作在确认时用红色；导航是待处理、正在跑，再加按层级浏览（决定 9）；插件只写英文，界面上其余的字由客户端翻译；不做批量动作。
9. **层级由插件用 `parent` 说出来，客户端一层层往下点。**（2026-11-07 owner 定，替换原来决定 8 的“没有层级”。）
   - 第一层是插件：`/v1/types` 的每个类型带上它所属的插件，客户端按插件分组。
   - 点进一个插件，列出它的顶层对象：这个插件各类型里没有 `parent` 的对象。
   - 对象页在 row 和分段之间列出它的下一层：`parent` 等于这个 id 的对象，每行和列表里的一行一样（等人、在跑的标记，可点进去），再往下同样。
   - API：`list` 接受 `parent=<id>`（下一层）和 `root`（顶层）；类型声明的 filter 和默认 filter 照样作用在下一层的列表上，隐藏的个数照样给出。
   - `dev` 的层级是 仓库 → plan → task：`dev` 新增 `repo` 对象类型（`operad dev repo add` 登记的仓库），plan 的 `parent` 是它的仓库，task 的 `parent` 是它的 plan。
   - 客户端仍不认识插件：层级、名字都来自 `/v1`。命令行的 `operad list <类型>` 照旧平铺。
   - TUI（2026-11-08 owner 定，照 arc 的 plans 页）：顶栏是待处理、正在跑，再加每个插件一个 tab（`dev`），不再每个类型一个 tab。插件 tab 左栏列出它的顶层对象；顶层对象都有下一层时，左栏改列下一层，按顶层对象分组，组名是顶层对象那一行（`dev` 左栏就是按仓库分组的 plan）。右栏是选中对象的页面：row、进度条、下一层列表（每行 mark、id、状态、badge、note，回车打开那个对象自己的页面），再往下是分段。下一层已经由客户端画成列表，插件不再另给一个列出下一层的分段（`dev` 去掉 plan 的 Tasks 段）。不在左栏的对象（如 task）只从上一层的页面、待处理、正在跑打开。
10. **行带一个语义标记 `mark`，客户端照 arc 的图标表画。**（2026-11-08 owner 定：“operad 用回 arc 的 item 标记”，改决定 6 的“只按两个标记上色”；图标表以 operad-ios `docs/design/operad/` 的 component sheet 为准，它和 arc 的表一致。）
   - `row(object)` 可以带 `mark`，取值只能是内核定的这一组（括号里是 iOS 的 SF Symbol 和颜色角色）：
     `todo`（circle，灰）、`blocked`（circle.dashed，灰）、`retry_wait`（clock，灰）、`paused`（pause.circle，灰）、`proposed`（plus.circle，等人色）、`starting`（circle.dotted，在跑色）、`running`（circle.lefthalf.filled，在跑色，呼吸）、`reconciling`（arrow.triangle.2.circlepath，在跑色）、`checking`（magnifyingglass，在跑色）、`rework_pending`（arrow.uturn.backward.circle，等人色）、`waiting`（circle.fill，等人色）、`integrating`（arrow.triangle.merge，在跑色）、`ready_to_merge`（checkmark.circle，成功色）、`done`（checkmark.circle.fill，成功色）、`failed`（xmark.circle.fill，错误色）、`cancelled`（nosign，灰）、`broken`（exclamationmark.triangle.fill，错误色）。
     别的值在加载插件时报错。插件只选语义，不给颜色、不给图标名。TUI 每个 mark 用一个单字符。
   - 内核的两个标记优先：`waiting` 为真时，`mark` 是 `waiting`、`proposed`、`rework_pending`、`ready_to_merge` 之一就用它，否则画 `waiting`；`waiting` 为假时有 `mark` 用 `mark`；否则 `running` 为真画 `running`；都没有就是普通的行。row 出错的行照旧画错误。
   - `dev` 的映射：task 的 proposed→`proposed`；ready→`todo`（等前置任务或同区任务时→`blocked`，模型不可用、定了重试时间时→`retry_wait`）；running 时按当前步骤：worktree→`starting`、work 和 rework→`running`、verify 和 review→`checking`、integrate→`integrating`；waiting 时按等的原因：verify 和 review 都过了等合并→`ready_to_merge`，问要不要返工→`rework_pending`，其余→`waiting`；merged→`done`；cancelled→`cancelled`；auto rework 用完放弃→`failed`。plan 的 draft→`proposed`，confirmed→有任务在跑时 `running`、否则 `todo`，暂停→`paused`，finished→`done`，cancelled→`cancelled`。
   - `row` 还可以带 `badge`：一小段原样显示的文字，客户端放在状态后面（`done.merged · #2` 的 `#2`）。`dev` 的 task 填 `#<第几次 attempt>`，还没开始的填 `#0`。
   - `row` 还可以带 `after`：同一个上一层下、这个对象要等的兄弟对象的 id 列表（2026-11-08 owner 定：plan 下的 task 列表照 arc 画）。客户端画下一层列表时按它排成树：一行挂在它 `after` 里排在最前的那个兄弟下面，用 `└─` 缩进；`after` 里其余的兄弟写在行尾，`also after <id>`。`after` 指向不在列表里的对象时忽略那一项；有环时按原顺序平铺。`dev` 的 task 填它的 `after`。
   - 对象页的进度条：对象页在 row 下面、下一层列表上面画一条分段的条，下一层的每个对象占一格，按那个对象的 `mark` 上色（`done` 成功色、`running`/`checking`/`integrating` 在跑色、`waiting`/`proposed` 等人色、`failed` 错误色、`cancelled` 暗红（错误色调暗，和 `failed` 分得开；2026-11-08 owner 定）、其余灰），条占满整行；条下面一行是下一层列表的标题行：左边是下一层的类型名，右边是“完成数 / 总数”，只写数字，后面不跟状态词（2026-11-08 owner 定，照 arc 的 plan 页）。已取消的不算进完成数，也不算进总数；条上仍画它们的暗红格，排在所有其他格后面；下一层列表里已取消的也排在最后；`dev` 的 plan 行里的“合并数/任务数”同样不算已取消的任务（2026-11-09 owner 定）。没有下一层的对象不画。这是客户端按决定 9 的下一层列表算出来的，插件不用多给东西。

11. **设置由内核读写，客户端通过同一套 API 改。**（2026-11-08 owner 定：“放进 kernel”，P-0014。）
   - 设置有两种：全局设置是 `~/.operad/config.json` 里每个插件的那一段（`plugins.<插件>.settings`，插件声明 JSON Schema，内核加载时已经校验）；项目设置是插件声明的、放在登记仓库 `.operad/` 下的 JSON 文件（比如 `dev` 的 `review.json`），也带 schema。
   - 插件在 schema 里给每个可改的设置标 `editable: true`，需要确认的再标 `confirm: true`；没标的客户端只能看不能改。
   - API 加两个调用：`settings [scope]` 列出设置（名字、当前值、默认值、schema 的说明、能不能改）；`set <名字> <值> [scope]` 改一个设置。内核按 schema 校验，不合法就拒绝并给出 schema 的理由，什么都不写；合法就原子写回文件（写临时文件再改名），保留文件里别的内容，然后像文件被手改一样让插件重新读。
   - 命令行、TUI 的 `:` 面板、iOS 的设置页都走这两个调用。秘密不在这里，仍然只用 `operad secret`。
   - 用户看到的新词（2026-11-08 owner 同意）：“设置”（settings，命令 `operad settings`、`operad settings set`）；TUI `:` 面板的分组名 actions、tui、settings。

## 样子

命令行：

```
$ operad pending
T-0003-foo  waiting for you  Storage interface…        dev:merge · dev:reject · dev:cancel
$ operad list task
T-0011-log-jsonl   merged    Storage interface, conformance…   $0.31
T-0014-kernel      running   Pure kernel: decide and evolve…   $0.12
$ operad show T-0014-kernel --section diff
$ operad dev:reject T-0003-foo --note "cover concurrent writers"
```

TUI：

```
┌ operad ──────────────────────────────────────────────┐
│ 待处理                                                 │
│ ▸ T-0003-foo   waiting for you   Storage interface…   │
│   T-0007-bar   waiting for you   rework limit         │
│ ┌ : ─────────────────────────────────────────────┐    │
│ │ :dev:re_                                        │    │
│ │   dev:reject   T-0003-foo   needs a note    r   │    │
│ │   dev:retry    T-0003-foo                       │    │
│ └─────────────────────────────────────────────────┘    │
│ : 命令   ↑↓ 移动   ⏎ 打开   ? 帮助                     │
└───────────────────────────────────────────────────────┘
```

打开一个对象：上面是 row，下面是各段做成的标签页（`dev` 的 task 是 Brief、Log、Diff、Metrics，再加内核的历史）。

iOS 和今天的 arc app 一个样：底部标签栏是待处理、正在跑、每个插件一个标签、设置（2026-11-08 owner 定，和 TUI 一样）：插件标签列出它的顶层对象，标签名是顶层类型的名字（`dev` 是 Repo），不在顶层的类型（plan、task）没有自己的标签，只从上一层的页面、待处理、正在跑打开；对象页是 row 加分段标签；底部操作栏是第一个动作的按钮和 `⋯` 菜单；`note` 的动作弹出输入框；待处理的项发推送。

## 验收

- 插件接口有 `views`（`row`、`sections`、`load`）、动作的 `args`（JSON Schema）和 `confirm`、默认快捷键；内核有 `list`、`get`、`section`、`events`、`act`；命令行有 `operad list`、`operad show`、`operad 插件:动作`。
- 一个测试插件只写声明和 `views`、不写命令，在命令行里能列出、查看分段、执行带 `note` 和 `confirm` 的动作。
- TUI 和 iOS 接入时不为任何插件写专门代码（在各自的计划里验收）。
- 层级：一个测试插件声明两种类型、子对象带 `parent`，`list` 的 `root` 和 `parent=` 返回对的行；iOS 从插件点到最底层，全程不出现插件的词。
