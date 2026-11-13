# operad-presentation：插件在命令行、TUI、iOS 上怎么显示和操作

- 状态：接口决定已进 ADR；下面留 iOS 一侧的样子和验收（TUI 和 iOS 的实现是以后的计划）
- 涉及 ADR：0013、0014、0015、0016、0017、0018、0019
- 涉及：`operad.md`；`operad-plugins.md`
- 来源：radian arc 的命令行、arc TUI、arc iOS app

## 决定（已定，在别的仓库里做，所以留在这里）

iOS 和今天的 arc app 一个样：底部标签栏是待处理、正在跑、每个插件一个标签、设置（和 TUI 一样）：插件标签列出它的顶层对象，标签名是顶层类型的名字（`dev` 是 Repo），不在顶层的类型（plan、task）没有自己的标签，只从上一层的页面、待处理、正在跑打开；对象页是 row 加分段标签；底部操作栏是第一个动作的按钮和 `⋯` 菜单；`note` 的动作弹出输入框；待处理的项发推送。

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

## 验收

- 插件接口有 `views`（`row`、`sections`、`load`）、动作的 `args`（JSON Schema）和 `confirm`、默认快捷键；内核有 `list`、`get`、`section`、`events`、`act`；命令行有 `operad list`、`operad show`、`operad 插件:动作`。
- 一个测试插件只写声明和 `views`、不写命令，在命令行里能列出、查看分段、执行带 `note` 和 `confirm` 的动作。
- TUI 和 iOS 接入时不为任何插件写专门代码（在各自的计划里验收）。
- 层级：一个测试插件声明两种类型、子对象带 `parent`，`list` 的 `root` 和 `parent=` 返回对的行；iOS 从插件点到最底层，全程不出现插件的词。
