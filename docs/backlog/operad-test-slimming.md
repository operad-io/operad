# operad-test-slimming：测试瘦身

- 状态：idea（清单来自一次检查，时间和行数是粗估）；已定的规则进了 ADR 0036，目标和待测的并发数仍在这里
- 涉及 ADR：0036
- 涉及：`operad-slimming.md`（源码瘦身，A1 和 B 组带着测试一起变）；`CLAUDE.md` 的测试规则（每个行为有测试、注入时钟、不 sleep）
- 来源：2026-11-11 对 `packages/*/test` 和 `scripts/test` 的统计（用例数、行数、同名辅助函数）；时间来自 2026-11-10 一份聚合了多次运行的检查日志，每个用例取最短的一次，不是一次干净的单独计时

## 背景

测试约 7 万行、192 个测试文件、约 2200 个用例，另有 86 个支撑文件。全量一次约 6 到 7 分钟（并发 2），机器忙时到 13 到 20 分钟。每个 task 的检查和每次合并前的全量都要付这个时间，所以分两条线：减时间，减行数。

没有做的：没有逐个读用例判断哪些重复覆盖同一个行为；那需要覆盖率数据或逐文件看。

## 清单

### A. 减时间

约 15% 的用例（327 个，各超过 1 秒）占用例总耗时的约 80%；其中 42 个超过 5 秒，占约 30%。

| 用例组 | 用例数 | 合计 | 原因 |
|---|---|---|---|
| `operad with the dev plugin`（`dev/test/cli.test.ts`） | 23 | 约 111 秒 | 每个用例多次起真实的 CLI 进程，平均 5 秒 |
| `dev/review` 五个组（`dev/test/gate.test.ts`） | 约 90 | 约 180 秒 | 每个 1.5 到 3 秒，原因没查 |
| serve 重载和重启（`a serve picks up changed code`、`a serve restart while a check runs`、`a reload with two listen addresses`） | 11 | 约 110 秒 | 真实的 serve 进程，单个 10 到 15 秒 |
| `dev/integrate`、`prepare`、cleanup、integration queue | 约 55 | 约 120 秒 | 没查，推测是真实的 git 仓库和进程 |
| `the night of 2026-11-08 at 08:01` | 1 | 约 19 秒 | 九个 task 的完整场景 |

1. **`cli.test.ts` 的 23 个用例**：命令的解析和输出在进程内调用；只留两三个真起进程的用例，证明入口接得上。估计省 90 秒左右。
2. **serve 重载的 11 个用例**：先查 10 到 15 秒花在哪。如果是等轮询间隔或静默期，改成注入时钟（规则本来就要求）；如果是进程启动，看能不能几个用例共用一个 serve。
3. **`dev/review` 的约 90 个用例**：先查每个 1.5 秒以上花在哪。如果是每个用例重建 git 仓库和 worktree，改成每个文件建一次模板仓库，用例复制它。
4. **`dev/integrate` 等约 55 个用例**：同上，先查再定。
5. **事故回归用例**：`the night of 2026-11-08` 这类完整场景删掉（决定 2）；先确认小用例已经覆盖同一个行为，缺的补上。

### B. 减行数

1. **测试辅助函数各写各的**：`setup` 定义了 41 次，`waitForFile` 13 次，`tempRoot` 11 次，`makeHome` 11 次，`manualClock` 10 次，`alive` 9 次，`waitUntil` 7 次，`cleanupTempRoots` 7 次，`git` 6 次，`freePort` 6 次。engine 有测试工具包（`packages/engine/src/testing`：`fakeClock`、`testWorld`、`memoryStore`、`runFlow`），但只有 engine 自己的 6 个测试文件用，插件的测试一个没用。把通用的收进工具包，各包的 `setup` 只留自己特有的部分。估计省 1500 到 2500 行。
2. **几乎不用表驱动**：192 个测试文件里 `test.each` 只出现 1 次。设置解析、参数校验、格式化这类“输入到输出”的用例适合改；`dev` 的 settings、`access-match`、tui 的视图测试先看。能省多少没量。
3. **三个 harness 的测试支撑重复**：`harness-claude`、`harness-pi`、`harness-radian` 的 `test/support.ts` 两两之间约 90 到 100 行相同；`fake-worker.ts`、`fake-lines-worker.ts` 在 claude 和 pi 里各一份。跟 `operad-slimming.md` 的 A1 一起做：共用代码进 `harness-process` 之后，共用的行为只在 `harness-process` 测一次。
4. **`dev/test/gate.test.ts` 3784 行**：按 review、verify、rework 拆成几个文件。拆开不减行数，配合 B1 能去掉重复的准备代码，也让 `--parallel` 分得更匀。
5. **跟着源码删的**：`harness-pi/test/spike.test.ts`；旧格式兼容和存储两套实现的测试，跟 `operad-slimming.md` B 组的决定走。

## 建议的顺序（未定）

先 A1 和 B1：收益最确定，不改被测的行为。然后 A2、A3 各做一次“先查原因”的小 task，查完按决定 4 改。接着做决定 5：把剩下的重用例挑出来集中，改 `scripts/run-tests.sh` 分步。B3 跟源码瘦身的 A1 同一批。

每一步都不能少测行为：改写或删除一个用例之前，写明它测的行为现在由哪个用例覆盖。把真进程换成进程内调用的地方，至少留一个真进程的用例。

## 已定但还没做完

1. **量覆盖率**（`bun test --coverage`），用它找重复覆盖的用例和没人测的代码。
2. **删事故回归用例前**写明它测的行为由哪些小用例覆盖；缺的先补小用例。规则本身（不留这类用例）在 ADR 0036 D3。
3. **全量测试总体 6 分钟以内。** 用平时运行积累的数据来量：检查日志里各次全量的耗时，不是挑机器空闲时单独量的一次。取中位数，不取平均：个别特别忙的几次会把平均拉高；不设单个用例的上限。
4. **并发实测后再定**：轻重分开之后，轻的一组在并发 4 和 6 下各跑几次看稳不稳，重的一组保持 2 或降到 1；由做这件事的 task 给出数据，owner 再定。
5. A1 到 A4 都按 ADR 0036 D1 改（模拟够用就不起真进程）；重用例已按 ADR 0036 D2 放进 `test/heavy/`，同名辅助函数的检查（D4）和最慢十个用例的列表（D5）已有。

## 待决问题（未定）

每条后面的“建议”是写这一项的会话的推荐，owner 还没有确认。原来的 1、5、6、7 已定，见决定 6 到 9；其余保留原编号。

2. 覆盖率只量一次，还是进检查（进检查要定阈值，也会加时间）。建议：只量一次，瘦身做完再量一次对比；不进检查。
3. 测试工具包放哪：继续在 `@operad-io/engine/testing`（第三方插件作者也能用，算合约的一部分），还是另开一个只给本仓库用的包。建议：留在 `@operad-io/engine/testing`，第三方插件作者也需要假时钟和临时家目录。
4. 改写测试的 task 怎么记 mutation：行为没变，按规则不需要记录；但换了测法之后，要不要抽查原来的 mutation 仍被新用例抓到。建议：抽查，每个改写的 task 从被改文件对应的 `MUTATIONS.md` 行里挑两三条重跑，在结论里写明挑了哪几条；真进程换成模拟的地方优先抽。

## 验收

A1 和 B1 做完：`cli.test.ts` 的合计时间降到 30 秒以内；`tempRoot`、`waitForFile`、`makeHome`、`manualClock` 各只有一处定义；用例覆盖的行为不少（每个改写或删除的用例在 task 的结论里写明去向）；`bash scripts/verify.sh` 通过。全部做完：全量测试 6 分钟以内（决定 6）。
