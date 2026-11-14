# operad-tla：用 TLA+ 检查调度和合并的设计

- 状态：decided（2026-11-13 owner：开一个 plan，不进检查流程）
- 涉及 ADR：0021、0004
- 来源：2026-11-13 lead 和 owner 的讨论（"tla 可以帮我们证明 adr 的准确性么"）

## 背景

ADR 写得准不准是三件事：写的是不是 owner 定的（人读，TLA+ 管不了）；代码是不是照做（测试）；决定本身在并发、崩溃下有没有漏洞。第三件是 TLA+ 擅长的。过去出事最多的地方是 worker 被占住、合并排队、主 clone 分叉，都在 `dev` 的调度和合并里。

## 决定（已定，2026-11-13 owner）

1. **先做 worker pool 加集成队列的模型**：任务、worker（两层额度、rework 回原 worker、fallback、没有 fallback 就等）、集成队列、主 clone 快进。引擎的运行、崩溃和恢复（ADR 0004）以后再说。
2. **不进检查流程**：不进 `scripts/verify.sh`、`check-changed.sh`、`run-tests.sh`，也不进 `.operad/dev.json` 的 gate 和 integration；单独一个脚本手动跑。看结果再定要不要进。
3. **TLC 不是运行时依赖**：不写进任何 `package.json`；脚本按固定版本取 `tla2tools.jar`，放在仓库外的缓存里，校验 sha256。本机有 Java 11。
4. **用真实记录做 trace validation**：从 `operad history --json` 导出事件序列，交给 TLC 检查它是不是模型允许的路径。只读，不改内核，不直接打开存储。
5. **反例的处理**（2026-11-14 owner：按 lead 建议）：lead 先在真实代码里确认，再给 owner 看、开修复 task。
6. **第一批反例**（2026-11-14 owner：按 lead 建议）：
   - pool 模型：ADR 0021 D7 改成“回到最后做这个任务的 worker”（代码本来就这样）；D8 不改，代码改成 harness 步骤抛异常时不切 fallback（P-0053）。
   - integrate 模型：已取消的任务在打包推送的间隙里被合进 main、重启后漏跑 prepare，这两个修（P-0053）。
   - 领头任务崩溃后两个任务同时拿到合并的轮次（`integration-queue.ts` 的 `turn()` 清掉占位后继续）：只记录，不修。git 拒绝非快进推送，main 不会坏，代价是白跑一轮。
   - 第 4 个反例（T-0438，`MCOneMergeCancel.cfg`）：领头任务推送被拒后、在新 main 上重检期间被取消，它的结果文件还在，第三个任务拿到轮次，被带上的任务随后作废打包也拿到轮次。和上一条同一处代码（`turn()`），不需要崩溃。2026-11-14 owner：只记录，不修；以后有任务改这段代码时和上一条一起修。

## 待决问题（未定）

1. 做完之后要不要进检查流程（比如只在改了 `pool` 或 `integrate` 的 task 里跑）。
2. 引擎的运行和恢复（ADR 0004 D2、D3、D6、D7）、问人的竞争（ADR 0008）、serve 的重启（ADR 0029）要不要接着建模。

## 验收

模型能用 TLC 跑完，写明检查了哪些不变式和活性性质、用的状态空间多大；故意去掉一个保护（比如额度检查）时 TLC 给出反例；至少一段真实运行的记录通过 trace validation；`bash scripts/verify.sh` 的行为和耗时不变。
