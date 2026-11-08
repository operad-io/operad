# operad-dev-flows：项目自己设置 dev 的开发流程

- 状态：decided（2026-11-07 owner 定；实现是以后的计划）
- 涉及：`operad.md` 决定 15、17；`operad-engine.md` 决定 1、4、5；`operad-presentation.md`
- 来源：radian arc 的 flows（`radian/docs/user/arc/flows.md`、`gate.md`、`docs/backlog/arc-flows.md`）；2026-11-07 的复盘（定级、检查重跑、rework 先合 main）

## 背景

`dev` 的流程写死在插件里（`packages/dev/flows/dev.flow.ts`）：worktree → work → verify → review → 等人合并 → integrate，项目只能在 `.operad/dev.json` 里调参数。arc 的 flow 是一组命名的配置（worker、gate profile 的有序 stage、并发、`before_attempt`），状态机固定，stage 只能排成一条线。owner 要的是：dev 提供状态机的骨架和步骤，具体的开发流程由用户（项目）指定。

## 决定（已定）

1. **流程写在项目的 `.operad/dev.json` 里，是 JSON**，带 JSON Schema。`flows.<名字>` 是一个 flow，`default` 是不指定时用的那个。dev 把它编译成引擎的 graph（`defineFlow` 的值），用户不写图和边。
2. **一个 flow 是一串有序的 stage**，`work` 也是 stage。第一版有四种：
   - `work`：worker 改代码；参数 `use`、`args`、`brief`（附加给 worker 的说明）、`beforeAttempt`（如 `merge-main`）。
   - `check`：跑命令；参数 `commands`、`rerun`。
   - `review`：模型 review；参数 `use`、`args`、`later`（之后几轮的参数）、定级名（对应 `.operad/review.json` 的 flow 条目）。
   - `human`：等人决定。
   以后按需要加 `wait`（等 CI、时间或条件）、`notify`、调用任意插件步骤的 `step`。
3. **走向由 dev 补齐**：一个 stage 失败，退回它前面最近的 `work` stage 重做；前面没有 `work` 就转为等人。重试、超时、取消、模型不可用的等待照今天的行为。worktree 的准备和最后的 integrate 由 dev 固定加在首尾。plan 的 `auto` 照旧决定 `human` 之后是等人还是自动合并。
4. **硬约束只有两条**，dev 加载时检查，不满足就拒绝并说明原因：最后一步一定是 integrate，改动只经由它进 main；一个 flow 至少有一个 `check`、`review` 或 `human`。其余都由项目决定。
5. **plan 和 task 用 `--flow <名字>` 选 flow**，不写用 `default`。task 开始第一次尝试之后不再换 flow。
6. **复杂的流程可以写 TS**：项目可以在 `.operad/flows/<名字>.flow.ts` 里直接用 `defineFlow` 写任意的图，dev 的 stage 步骤都是有文档的积木（每一步写明结果和参数）。大多数项目用不到。
7. **今天的流程成为 dev 自带的默认配置**：一个仓库没写 `flows` 时，行为和今天一样。`dev.json` 里现有的 `worker`、`reviewer`、`gate` 等设置继续有效，作为 `default` flow 的参数；同时写了两边时以 `flows` 为准，并在加载时提示一行。
8. **定级按 flow 分**（`.operad/review.json`，见 T-0059），和这里的 flow 名一一对应。

## 待决问题（未定）

1. 每个 flow 是否各有并发上限（arc 有），还是只用 plan 和仓库两层。
2. 一个 task 的 flow 在列表里怎么显示；只有一个 flow 的仓库是否不显示。
3. 检查要独占的资源（iOS 模拟器、固定端口、设备）怎么声明：今天靠 `gate.places` 把整个仓库的检查限成一份（radian-ios 设成 1）。候选：`dev.json` 里每条检查写它占用哪些资源、各几份，`pool` 按资源排队；检查之外的步骤是否也用同一套。来源：2026-11-08 三个 xcodebuild 共用一个模拟器导致 UI 测试崩溃。

## 验收

一个仓库写两个 flow（一个有 review、一个没有），两个 task 各走各的；没写 `flows` 的仓库行为和今天一样（现有测试全过）；违反硬约束的配置被拒绝并说明原因；`--flow` 写错的 task 不开工并说明。
