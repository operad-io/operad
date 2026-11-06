# operad-presentation：插件在命令行、TUI、iOS 上怎么显示和操作

- 状态：idea（方向待 owner 定；TUI 和 iOS 的实现是以后的计划，声明格式现在定）
- 涉及：`operad.md` 决定 12–17；`operad-plugins.md`
- 来源：radian arc 的命令行、arc TUI 任务页、arc iOS app（任务页五个标签、待处理、操作栏）

## 背景

内核尽量小，开发只是一个插件（`dev`），以后还会有个人助理之类的插件。客户端（命令行、TUI、iOS，以后的网页）如果各自认识每个插件，每加一个插件就要改三四个客户端，agent 现写的插件也没法立刻在手机上用。所以客户端不认识任何插件：插件**声明**它的对象怎么列、怎么看、能做什么，内核把声明和数据一起给出去，每个客户端按同一份声明画出来。

## 决定（提议）

1. **客户端不是插件，也不认识插件。** 命令行、TUI、iOS 都只通过内核的 API 读声明和数据、执行动作。客户端里不出现 plan、task 这类词，除非是从声明里读到的。
2. **插件声明三样东西**，都是数据（JSON 能表达），不是界面代码：
   - **对象**：名字（单数、复数）、标题字段、父对象（`task` 的父对象是 `plan`）、状态表（每个状态的名字和**语气**）、列表的列、详情页的标签页、头部字段。
   - **动作**：名字、显示名、作用的对象、什么状态下可用、参数（JSON Schema）、确认文字、样式（主要、普通、危险）、建议快捷键。
   - **入口**：在导航里出现的对象列表（`dev` 是“仓库 → plan → task”）。
3. **语气**是一个封闭集合，每个客户端映射到自己的主题色：`neutral`、`running`、`waiting`（等你）、`done`、`failed`、`muted`。插件不能指定颜色。
4. **内容类型**是一个封闭集合，标签页只能从中选：`markdown`、`fields`（键值对）、`table`、`diff`、`log`（长文本，流式）、`transcript`（agent 会话，harness 插件提供）、`history`（内核的历史视图）。插件为非字段的内容提供一个只读的取数函数（比如 `dev` 的 diff 从 git 取）。
5. **列的类型**是一个封闭集合，决定对齐和格式：`id`、`text`、`state`、`money`、`duration`、`time`、`count`。
6. **通用命令由内核按声明提供**，插件不用再写：`operad list [<对象>]`、`operad show <id> [--tab <标签>]`、`operad <动作> <id> [参数]`。插件只写声明表达不了的命令（`dev` 的 `task add`、`repo add`）。
7. **快捷键由客户端决定。** 全局键（移动、进入、返回、切标签、搜索、帮助、退出）是客户端固定的；插件的 `key` 只是动作的建议键，冲突时客户端改用别的键并在操作栏里显示实际的键。
8. **内核的三个视图**（待处理、正在跑的、历史）在每个客户端里都有，排在插件的入口前面。

## 声明长什么样（`dev` 插件的一部分）

```ts
objects: [{
  name: "task", plural: "tasks", label: "Task", parent: "plan",
  title: "title",
  states: {
    ready:   { label: "ready",          tone: "neutral" },
    running: { label: "running",        tone: "running" },
    review:  { label: "in review",      tone: "running" },
    waiting: { label: "waiting for you",tone: "waiting" },
    merged:  { label: "merged",         tone: "done" },
    cancelled:{label: "cancelled",      tone: "muted" },
  },
  list:   [{ field: "id", kind: "id" }, { field: "state", kind: "state" },
           { field: "title", kind: "text" }, { field: "cost", kind: "money" }],
  header: ["state", "attempt", "cost", "plan"],
  tabs: [
    { id: "summary", label: "Summary", content: "fields",     source: "summary" },
    { id: "brief",   label: "Brief",   content: "markdown",   source: "brief" },
    { id: "log",     label: "Log",     content: "transcript", source: "workerSession" },
    { id: "diff",    label: "Diff",    content: "diff",       source: "diff" },
    { id: "history", label: "History", content: "history" },
  ],
}],
actions: [
  { name: "merge",  label: "Merge",  on: "task", when: "waiting", style: "primary",
    confirm: "Merge {id} into main and push?", key: "m" },
  { name: "reject", label: "Rework", on: "task", when: "waiting", style: "normal", key: "r",
    args: { type: "object", required: ["note"],
            properties: { note: { type: "string", title: "What to change", format: "multiline" } } } },
  { name: "cancel", label: "Cancel", on: "task", when: ["ready","running","review","waiting"],
    style: "danger", confirm: "Cancel {id}? Its branch is kept.", key: "x" },
],
```

`when` 写成状态名或状态列表，客户端不用跑插件代码就能判断；需要更复杂的条件时，内核在给数据时把每个对象当前可用的动作一起算好给出去。

## 命令行

```
$ operad pending
TK0003-foo  waiting for you  Storage interface…        merge · reject · cancel
TK0007-bar  waiting for you  rework limit reached      retry · cancel

$ operad list tasks --plan PL0002-dogfood
ID                 STATE            TITLE                                  COST
TK0011-log-jsonl   merged           Storage interface, conformance…       $0.31
TK0014-kernel      running          Pure kernel: decide and evolve…       $0.12
TK0016-runner      ready            Runner, operad serve, pending…            —

$ operad show TK0014-kernel                # 头部字段 + 第一个标签页
$ operad show TK0014-kernel --tab diff     # 某个标签页
$ operad reject TK0003-foo --note "cover concurrent writers"
$ operad reject TK0003-foo                 # 终端里缺必填参数时提示输入
What to change (end with an empty line):
> _
$ operad merge TK0003-foo                  # 有确认文字时先问；--yes 跳过
Merge TK0003-foo into main and push? [y/N]
```

- 状态按语气上色（终端支持颜色时），`--json` 输出原始数据和声明，脚本和 lead 用它。
- 参数从 Schema 变成选项：`note` → `--note`；必填且没给：终端里提示，非终端直接报错（退出码 2）。

## TUI（以后实现，界面现在定）

```
┌ operad ───────────────────────────────────────────────────────────────┐
│ 待处理 2   正在跑 3   仓库   flows                                      │
├────────────────────────┬──────────────────────────────────────────────┤
│ 待处理                  │ TK0003-foo  waiting for you                  │
│ ▸ TK0003-foo  等你      │ attempt 2 · $0.41 · PL0002-dogfood           │
│   TK0007-bar  等你      │ ─────────────────────────────────────────────│
│                         │ Summary  Brief  Log  Diff  History           │
│ 正在跑                  │                                              │
│   TK0014-kernel  ●      │ verify   pass  bun test 212 passed           │
│   TK0016-runner  ●      │ review   pass  0 findings at major           │
│                         │                                              │
├────────────────────────┴──────────────────────────────────────────────┤
│ [m] Merge   [r] Rework   [x] Cancel        ←→ 标签  ↑↓ 移动  ? 帮助     │
└───────────────────────────────────────────────────────────────────────┘
```

- 顶栏：内核的三个视图在前，然后是插件的入口。
- 左栏：当前视图的列表，列来自声明；右栏：选中对象的头部字段和标签页。
- 底栏：当前对象可用的动作和实际快捷键，主要动作在最左，危险动作在最右。
- 有参数的动作弹出表单（字段来自 Schema），有确认文字的先确认：

```
 ┌ Rework TK0003-foo ─────────────────┐
 │ What to change (required)          │
 │ > cover concurrent writers_        │
 │                  [Enter] 提交 [Esc] │
 └────────────────────────────────────┘
```

## iOS

和今天的 arc app 同一个样子，只是每个屏幕都由声明画出来：

```
┌──────────────────────────────┐      ┌──────────────────────────────┐
│ 待处理                        │      │ ‹  TK0003-foo                │
│                              │      │    waiting for you            │
│ TK0003-foo                   │      │    attempt 2 · $0.41          │
│ Storage interface…   等你 ●  │      │ SUMMARY BRIEF LOG DIFF HISTORY│
│                              │      │ ───────                       │
│ TK0007-bar                   │      │ verify  pass                  │
│ rework limit reached 等你 ●  │      │ review  pass                  │
│                              │      │                              │
│                              │      │                              │
│                              │      │ ┌────────┐ ┌──────┐  ⋯       │
│                              │      │ │ Merge  │ │Rework│          │
├──────────────────────────────┤      │ └────────┘ └──────┘          │
│ 待处理  正在跑  仓库  设置    │      └──────────────────────────────┘
└──────────────────────────────┘
```

- 底部标签栏：待处理、正在跑、插件入口（`dev` 是“仓库”）、设置。
- 列表行：标题字段做主行，第一列 id 做副行，状态做右侧的语气圆点和文字。
- 详情页：头部字段，下面是声明的标签页（今天的 SUMMARY / BRIEF / LOG / DIFF / METRICS 就是 `dev` 的声明）。
- 操作栏固定在底部：主要动作是实心按钮，普通动作是描边按钮，其余和危险动作收进 `⋯`；危险动作是红色并且一定先确认。
- 有参数的动作弹出一个表单 sheet；`multiline` 的字段是多行输入框。
- 待处理的项发推送通知；通知里能直接做不需要参数的主要动作。

## 待决问题

1. 声明里的显示名要不要支持多语言（`label: { en, zh }`），还是客户端按 key 查自己的翻译表。
2. `when` 只认状态名够不够，还是一开始就由内核算好每个对象的可用动作。
3. 一个对象能不能有多个父对象（`task` 属于 `plan`，`plan` 属于 `repo`），导航是固定层级还是由声明决定。
4. 批量动作（多选后一起 cancel）要不要。

## 验收

- 插件接口带上对象、动作、入口的声明，有 JSON Schema 和校验；`dev` 插件按声明写。
- 内核的 `operad list`、`operad show`、`operad <动作>` 只靠声明工作，`dev` 不写这三类命令。
- 一个测试插件只写声明、不写命令，在命令行里能列出、查看、执行带参数和确认的动作。
- TUI 和 iOS 接入时不需要为 `dev` 写任何专门代码（在各自的计划里验收）。
