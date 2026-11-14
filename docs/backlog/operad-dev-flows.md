# operad-dev-flows：项目自己设置 dev 的开发流程

- 状态：决定已落地并进了 ADR；下面只留未定的问题、没核实的点和验收
- 涉及 ADR：0020、0021
- 来源：radian arc 的 flows（`radian/docs/user/arc/flows.md`、`gate.md`、`docs/backlog/arc-flows.md`）；2026-11-07 的复盘（定级、检查重跑、rework 先合 main）

## 已定，尚未做或未核实

- stage 以后按需要加 `wait`（等 CI、时间或条件）、`notify`、调用任意插件步骤的 `step`。
- 一个仓库没写 `flows` 时，`dev.json` 里现有的 `worker`、`reviewer`、`gate` 等设置作为 `default` flow 的参数；同时写了两边时以 `flows` 为准，并在加载时提示一行。（提示那一行未核实。）
- `--flow` 选 pool 时，MCP 的建任务也能给（未核实；`task add` 已有）。

## 待决问题（未定）

1. 每个 flow 是否各有并发上限（arc 有），还是只用 plan 和仓库两层。（已定按 pool 分：见 ADR 0021 D4；flow 用哪个 pool 就占哪个 pool 的名额。）
2. 一个 task 的 flow 在列表里怎么显示；只有一个 flow 的仓库是否不显示。
3. 检查要独占的资源（iOS 模拟器、固定端口、设备）怎么声明：今天靠 `gate.places` 把整个仓库的检查限成一份（radian-ios 设成 1）。候选：`dev.json` 里每条检查写它占用哪些资源、各几份，`pool` 按资源排队；检查之外的步骤是否也用同一套。来源：2026-11-08 三个 xcodebuild 共用一个模拟器导致 UI 测试崩溃。

## 验收

一个仓库写两个 flow（一个有 review、一个没有），两个 task 各走各的；没写 `flows` 的仓库行为和今天一样（现有测试全过）；违反硬约束的配置被拒绝并说明原因（`dev.json` 和 `.operad/flows/*.flow.ts` 一样，和 `dev.json` 同名的 `.flow.ts` 也拒绝）；`--flow` 写错的 task 不开工并说明。
