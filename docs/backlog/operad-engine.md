# operad-engine：flow 引擎

- 状态：决定已进 ADR；下面只留待决问题和验收
- 涉及 ADR：0004、0005、0002
- 来源：`operad.md`；`research/2026-11-04-agent-autoloop.md`「内核与测试」；`research/2026-11-05-noop.md`「架构」

## 待决问题（未定）

1. 是否允许一个 flow 引用另一个。
2. 默认后台选哪个；和 iOS 的 `api_version` 怎么衔接。
3. 一次运行的预算（时间、费用、尝试次数）放 flow 级还是步骤级。
4. 是否加并行与汇合；今天内核只有四种基本步骤。

## 验收

`dev` flow 在新引擎上把一个真实任务从创建跑到等人合并，中途杀掉引擎进程再起来能接着跑；历史能查出每一步；存储后台通过一致性测试；现有 arc 的锁、恢复、幂等相关行为测试按规格通过（今天的 arc 流水线 worker → commands → mutation → review → ci → human → integration 由 `dev` 插件表达为第一个 flow，现有行为测试当它的验收规格）。
