# operad-slimming：代码库瘦身

- 状态：idea（2026-11-11 写下；清单来自一次代码检查，行数是粗估，owner 回头决定做哪些）
- 涉及：`operad.md` 决定 13；`operad-harness.md`、`operad-harness-claude.md`、`operad-harness-pi.md`；`operad-open-framework.md`
- 来源：2026-11-11 对 `packages/` 的检查（按行数、同名函数、相同行、导出名的引用次数统计；大文件没有逐段读）

## 背景

非测试源码约 6.6 万行，测试约 7 万行。真正没人用的代码很少；能减的主要是重复和双份实现。下面按收益排序。

## 清单

### A. 不改行为、不需要决定的

1. **三个 harness 的重复**（约 500 到 700 行，加上对应的测试）
   - `harness-claude` 和 `harness-pi` 的 `src/index.ts` 各约 640 行，约 300 行相同，13 个同名函数：`agentData`、`directoryError`、`failure`、`modelErrorOf`、`optionalText`、`paramsObject`、`parseResult`、`parseStepFlags`、`resultFor`、`secs`、`stringList`、`text`、`isRecord`。
   - `harness-radian/src/index.ts` 重复了其中 10 个。
   - 两个 `src/worker.ts` 约 190 行相同。
   - 去处：已有的 `harness-process`。每个 harness 只留协议（`protocol.ts`）、安装（`*-install.ts`）和它自己的设置。
2. **小工具函数重复**（约 200 行）：`isRecord` 定义了 40 次，`messageOf` 7 次（engine 已经导出），`oneLine` 6 次，`stringList`、`paramsObject`、`requireName`、`repeatEvery` 各 4 次。engine 导出一份，其余删掉。
3. **spike 和 acceptance 目录**：`harness-claude`、`harness-pi` 下的 `spike/`、`acceptance/` 约 500 行，加 `SPIKE.md`。结论已经在 backlog 里；删掉，或把还有用的挪到 `docs/research/`。
4. **没人用的导出**：按名字粗查，约 26 个在源码和测试里都没有引用（engine 11、dev 11、tui 4），另有 14 个只有测试引用。例子：`dev` 的 `rejectTask`、`raisePriority`、`lowerPriorityOf`、`taskGatePath`、`verifiedCommitOf`；engine 的 `pollTrackedSteps` 和几个 `*Payload` 类型；tui 的 `filterFor`、`childLines`。删之前逐个确认：类型可能是合约的一部分，给第三方插件用。

### B. 要 owner 先定的

1. **`dev` 里的旧格式兼容**（代码不多，每处都带分支和测试）
   - 旧的 `worker` 设置（`settings.ts` 的 `legacyWorkers`）、`reviewer.firstArgs`（`rework.ts`）。
   - 旧 id `PL0001`、`TK0001`（`model.ts`）；旧的 `repository` 对象迁移（`service.ts` 的 `migrateLegacyRepositories`）；旧的 review `pass`/`fail` 记录。
   - engine 的 `MOVED_MODULES`（`config/config.ts`）。
   - 前提：用过旧格式的只有我们自己的家目录和仓库（operad、radian、radian-ios）。把数据和配置迁一次，这些代码就能全删。
2. **存储两套实现**（约 3200 行，只留一种能减一半左右）
   - 日志后台：`log/jsonl.ts` 1221 行，`log/sqlite.ts` 921 行。
   - 插件对象的存储：`plugin/file-store.ts` 573 行，`plugin/sqlite-store.ts` 536 行，两者约 170 行相同。
   - 这是单笔最大的削减，但 `operad.md` 决定 13 定了自带 `jsonl` 和 `sqlite` 两个后台。要做就先改决定 13（单独一个只改文档的提交）。不改决定的话，可以只把两个对象存储相同的部分合起来。
3. **`operad-open-framework.md` 的 A1 到 A4**（约 300 到 400 行）：flaky brief 的规则和探测、`linkWorkspacePackages`、“serve 在跑旧代码”的提醒。搬进配置之后这部分代码不再需要；跟着那一项走，这里只记数。

### C. 收益小或不减行数的

1. **自己写的工具**：`cli/qr.ts` 405 行、`engine/markdown.ts` 438 行、`tui/theme.ts` 531 行加十来套主题 JSON 和许可证文件。这是“不加运行时依赖”的代价；能减的只有自带主题的数量。
2. **大文件**：`dev/gate.ts` 2858 行、`tui/state.ts` 2849 行、`cli/main.ts` 2701 行、`engine/views/presentation.ts` 2092 行、`dev/service.ts` 2051 行。拆开不减行数，但这几个文件没有逐段读过，里面可能还有能合并的逻辑；值得各做一次专门的检查。
3. **测试和记录**：`dev/test/gate.test.ts` 一个文件 3784 行；各包的 `MUTATIONS.md` 合计约 1900 行，根目录的 843 行，每个 task 都在涨。

## 建议的顺序（未定）

先做 A1、A2、A3：不改行为，现有测试通过就是检查，不需要 mutation 记录。A1 按 harness 一个一个搬，每搬一个跑它自己的测试。然后 A4。B1 等 owner 确认前提；B2 等 owner 决定是否改决定 13；B3 跟 `operad-open-framework.md`。

## 待决问题（未定）

1. B1 的前提是否成立：除了我们自己，有没有别人的家目录或仓库还在用旧格式。迁移是写一个一次性的脚本，还是手改。
2. B2：只留哪一种后台，还是都留。留 `sqlite` 则 `jsonl` 的可读、可 diff 没有了；留 `jsonl` 则 1221 行的那份留下。
3. A4 里的类型导出哪些算合约（第三方插件可以用），哪些可以删。
4. C3：`MUTATIONS.md` 要不要归档（比如按月或按已合并的 task 挪到 `docs/` 下的存档），根目录的索引是否还需要。
5. C1：自带主题留几套。
6. 要不要加一条检查防止再长回来：同名的工具函数（`isRecord`、`messageOf`）在 engine 之外不再定义。

## 验收

A 做完：三个 harness 的 `index.ts` 和 `worker.ts` 里不再有同名的共用函数；`isRecord`、`messageOf` 各只有一处定义；`spike/`、`acceptance/` 不在包里；`bash scripts/verify.sh` 通过，行为不变。B 各项按 owner 的决定另写验收。
