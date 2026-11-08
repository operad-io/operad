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
7. **客户端的 API**，三个客户端共用：`list <类型>`、`get <id>`（row、段的目录、可用动作）、`section <id> <段> [cursor]`、`events`（变化推送）、`act <插件:动作> <id> [note]`。命令行在本机直接调用，TUI 和 iOS 走同样的接口。
8. **插件不碰颜色、布局、导航。** 插件给的是语义（决定 10 的 `mark`），不是颜色或图标名。 主按钮是第一个动作，其余在 `⋯`；需要确认的动作在确认时用红色；导航是待处理、正在跑，再加按层级浏览（决定 9）；插件只写英文，界面上其余的字由客户端翻译；不做批量动作。
9. **层级由插件用 `parent` 说出来，客户端一层层往下点。**（2026-11-07 owner 定，替换原来决定 8 的“没有层级”。）
   - 第一层是插件：`/v1/types` 的每个类型带上它所属的插件，客户端按插件分组。
   - 点进一个插件，列出它的顶层对象：这个插件各类型里没有 `parent` 的对象。
   - 对象页在 row 和分段之间列出它的下一层：`parent` 等于这个 id 的对象，每行和列表里的一行一样（等人、在跑的标记，可点进去），再往下同样。
   - API：`list` 接受 `parent=<id>`（下一层）和 `root`（顶层）；类型声明的 filter 和默认 filter 照样作用在下一层的列表上，隐藏的个数照样给出。
   - `dev` 的层级是 仓库 → plan → task：`dev` 新增 `repo` 对象类型（`operad dev repo add` 登记的仓库），plan 的 `parent` 是它的仓库，task 的 `parent` 是它的 plan。
   - 客户端仍不认识插件：层级、名字都来自 `/v1`。命令行的 `operad list <类型>` 照旧平铺。
10. **行带一个语义标记 `mark`，客户端照 arc 的图标表画。**（2026-11-08 owner 定：“operad 用回 arc 的 item 标记”，改决定 6 的“只按两个标记上色”。）
   - `row(object)` 可以带 `mark`，取值只能是内核定的这一组：`proposed`、`todo`、`blocked`、`paused`、`starting`、`running`、`checking`、`integrating`、`waiting`、`done`、`failed`、`cancelled`。别的值在加载插件时报错。插件只选语义，不给颜色、不给图标名。
   - 客户端的图标和颜色沿用 arc iOS 的状态表：`todo` 空心圆、`blocked` 虚线圆、`paused` 暂停圆、`proposed` 加号圆（等人色）、`starting` 点线圆、`running` 半实心圆（在跑色，呼吸）、`checking` 放大镜、`integrating` 合并箭头、`waiting` 实心圆（等人色）、`done` 实心勾（成功色）、`failed` 实心叉（错误色）、`cancelled` 禁止符号（灰）。TUI 用对应的单字符。
   - 内核的两个标记优先：`waiting` 为真时画 `waiting`；否则有 `mark` 用 `mark`；否则 `running` 为真画 `running`；都没有就是普通的行。row 出错的行照旧画错误。
   - `dev` 的映射：task 的 proposed→`proposed`，ready→`todo`（等前置任务或同区任务时→`blocked`），running 时按当前步骤：work→`running`、verify 和 review→`checking`、integrate→`integrating`，waiting→`waiting`，merged→`done`，cancelled→`cancelled`；plan 的 draft→`proposed`，confirmed→有任务在跑时 `running`、否则 `todo`，暂停→`paused`，finished→`done`，cancelled→`cancelled`。

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

iOS 和今天的 arc app 一个样：底部标签栏是待处理、正在跑、浏览（插件 → 顶层对象 → 下一层……）、设置；对象页是 row 加分段标签；底部操作栏是第一个动作的按钮和 `⋯` 菜单；`note` 的动作弹出输入框；待处理的项发推送。

## 验收

- 插件接口有 `views`（`row`、`sections`、`load`）、动作的 `args`（JSON Schema）和 `confirm`、默认快捷键；内核有 `list`、`get`、`section`、`events`、`act`；命令行有 `operad list`、`operad show`、`operad 插件:动作`。
- 一个测试插件只写声明和 `views`、不写命令，在命令行里能列出、查看分段、执行带 `note` 和 `confirm` 的动作。
- TUI 和 iOS 接入时不为任何插件写专门代码（在各自的计划里验收）。
- 层级：一个测试插件声明两种类型、子对象带 `parent`，`list` 的 `root` 和 `parent=` 返回对的行；iOS 从插件点到最底层，全程不出现插件的词。
