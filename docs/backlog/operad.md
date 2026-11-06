# operad：arc 的下一代，graph 引擎、多 harness、多通道、可现写的插件；radian 降为纯 agent

- 状态：decided（方向；各项设计见五个子项）
- 涉及 ADR：0032、0043、0048、0049、0024、0045、0034
- 来源：`research/2026-11-04-agent-autoloop.md`；`research/2026-11-05-noop.md`；`research/2026-10-20-arc-competitors.md`
- 子项：`operad-engine.md`、`operad-plugins.md`、`operad-harness.md`、`operad-channels.md`、`operad-assistant.md`；`hub-event-inlet.md` 归入 `operad-channels.md`

## 背景

arc 今天住在 radian 二进制里（ADR 0032、0043、0048），worker 只有 `radian acp`（ADR 0049），hub 的会话路由只认 radian 的 journal 和 control port，任务生命周期（worker → gate 各阶段 → 人 → merge）是一张写死的流程。实际用法已经是多个 agent：Claude Code、pi、radian 各有会话，arc 管任务；手机上要开两个 app。arc iOS 的体验是好的，缺的是它只看得到 radian，流程也只有一种。

三个同行（agent-autoloop、noop、bb）证明"编排任何命令行 agent"这层能做小，也暴露了共同的空白：没有验证 gate，没有自己的沙箱。noop 和 DeepSeek Super-agent 编排的是人格（lead、dispatcher、Router）；arc 编排的是流程，角色只是节点的参数。

## 决定（已定）

1. **operad 是 arc 的下一代，一个开放的编排层**，六个要求：更多 harness；更多通道；workflow 是容易设置的 graph；编排流程而不是角色；能做到个人助理的场景；用户描述一个需求，agent 立刻写出一个本地插件或一个定制步骤，立刻能用。
2. **radian 降为纯 agent**：留下会话、journal、TUI、`radian exec`、`radian acp`、权限和沙箱、provider、memory、skills。arc 的 `radian arc` 子命令、arc TUI 面板、hub 的任务路由，随 arc 迁出。
3. **新产品叫 operad，新仓库，TypeScript。** 名字取自数学里的 operad：n 个输入、一个输出的运算，以及它们怎么嵌套复合的代数结构，正是 graph 引擎做的事；词里带 rad，和 radian 同一个家族。CLI 命令 `operad`；npm 包 `@operad-io/cli`（装出的命令是 `operad`）与 `@operad-io/*`，npm org `operad-io`（不带 scope 的 `operad` 被 npm 以与 `openai` 太像拒绝，`@operad` 已被 operadhq 占用）；域名 `operad.io`（已注册）、`operad.run`；GitHub org `operad-io`（仓库 `operad-io/operad`，私有）。运行时是 Bun。TypeScript 的理由只有一个：扩展面必须是热加载、无构建、agent 几秒钟能写出来的文本；核心和扩展同一种语言、同一个进程，生成的步骤不跨边界。Rust 核心加 TS 运行时能做但违背这一条。
4. **flow 引擎是新核心，今天的 arc 流水线由 `dev` 插件表达为第一个 flow。** 迁移不是移植代码，是用新引擎表达现有流水线跑到 parity；现有测试当验收规格。引擎内部把 flow 的结构叫 graph，用户只看到 flow。
5. **flow 的结构是数据，步骤里的定制逻辑是 TS 文件。** 步骤由插件提供，其余写 TS。手机看 flow 和运行状态，不在手机上编辑。
6. **第一个垂直场景是编码流程**，验证 gate 和 forge 在这里；个人助理是同一个引擎长出来的第二个场景，排在后面。
7. **生成的步骤默认跑在沙箱里。** 沙箱从 radian 的 agent 里剥出来，变成包任何命令的壳；它是 arc 层的能力，不是某个 harness 的能力。
8. **事件是资料、规则是指令**：来源送进来的字进不了提示词，决定不了路由、目录、权限；每种插件一把作用域密钥。
9. **会话的统一协议是 ACP**，hub 是每个 harness 的 ACP 客户端；一种 harness 是一个描述文件，任务和会话同一份。
10. 从同行**不拿**的：模型替 owner 决定（影子 judge 只量准确率）；agent 直接改自己的提示词和策略；必需的云会合点；没有 gate 的"信自报加 CI"。
11. 新仓库到 parity 之前，Rust arc 继续跑 dogfood；两边并行是计划内的成本。
12. **内核尽量小。** 能放进插件的都放进插件；内核只做插件做不到、或每个插件都要重复写的事。内核只有五样：
    - 事件日志：只追加的事实记录，带因果；
    - flow 执行：推进、崩溃续跑、重复输入只算一次、同一步反复崩溃就停；
    - 四种基本步骤：调用插件的一个步骤、等人、等时间或条件、结束；
    - 插件加载：插件声明对象、动作、步骤、flow、命令行动词，内核只认种类不认名字；
    - 三个对外视图：待处理、历史、正在跑的。
    跑命令和检查、调度（并发、依赖、优先级、auto 级别）、git、worker、review、合并，都不在内核里。
13. **存储是可换的后台**：内核定一个日志接口和一份一致性测试，自带 `jsonl` 和 `sqlite` 两个后台，按仓库配置选。插件和用户碰不到存储格式；插件的对象（比如 `dev` 的 task 和 brief）存成事实，通过插件的命令读写。
14. **用户名词尽量少。** 内核对用户只暴露三个词：flow、待处理、历史。其余名词都属于某个插件，不用那个插件的用户不必知道。新增用户可见的名词要 owner 同意。
15. **开发是一个插件（`dev`）**，默认装上，可以不用：对象 plan、task、brief、rework；动作 confirm、merge、reject、cancel、auto（出现在待处理里，命令行也能直接用）；`dev` flow：worktree → worker → verify → review → 等人合并 → 合并到 main → 清理。有别的开发规范的用户可以另写或让 agent 生成一个开发插件。`dev` 只通过插件接口和内核打交道，它需要绕过接口时说明接口设计错了。
16. **内核不绑定仓库。** operad 只有一个家目录（默认 `~/.operad`）：配置、存储、调度循环都在那里，命令在任何目录都能用，内核不读 git。绑定仓库的是 `dev` 插件：它登记若干仓库（`operad repo add`），每个仓库自己的设置放在仓库里；个人助理一类插件不需要仓库。
17. **配置文件尽量用 JSON**（家目录的 `config.json`、仓库里的 `.operad/dev.json`），各带一份 JSON Schema，编辑器能补全和检查；flow 和插件才是 TypeScript。

## 顺序

`operad-engine` → `operad-plugins` → `operad-harness` → `operad-channels` → `operad-assistant`。前两项是新核心，后三项可以在引擎有第一张 graph 之后并行。

## 待决问题（未定）

1. 分发方式（npm 之外是否上 Homebrew）；`operad.run` 是否注册。
2. 沙箱壳的形态：radian 二进制里的子命令（`radian sandbox -- <命令>`），还是独立的小程序。
3. iOS app 的后端：hub 整体随 arc 迁出，还是会话路由留一段时间。
4. 订阅条款：用 Claude Code 订阅账号跑全自动流水线，厂商建议高频自动化用 API key；哪些 flow 允许订阅账号、哪些要求 API key。交互会话不受此限。
5. 远程机器：push（daemon 拨回）还是 pull。

## 验收

五个子项各自验收；本文件在 Rust arc 退役、ADR 0032、0043、0048、0049 改写后删除。
