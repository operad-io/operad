# operad：arc 的下一代，graph 引擎、多 harness、多通道、可现写的插件；radian 降为纯 agent

- 状态：方向已定并已进 ADR；下面只留还没做完的决定、顺序、待决问题和验收
- 涉及 ADR：0001、0002、0003
- 来源：`research/2026-11-04-agent-autoloop.md`；`research/2026-11-05-noop.md`；`research/2026-10-20-arc-competitors.md`
- 子项：`operad-engine.md`、`operad-plugins.md`、`operad-harness.md`、`operad-channels.md`、`operad-contract.md`、`operad-presentation.md`、`operad-conversation.md`、`operad-sandbox.md`、`operad-bot.md`、`operad-bot-mcp.md`、`operad-harness-pi.md`、`operad-harness-claude.md`、`operad-telegram.md`；`hub-event-inlet.md` 归入 `operad-channels.md`

## 决定（已定，还没做完，所以留在这里）

4'. 迁移不是移植代码，是用新引擎表达现有流水线跑到 parity；现有测试当验收规格。
7. **生成的步骤默认跑在沙箱里。** 沙箱从 radian 的 agent 里剥出来，变成包任何命令的壳；它是 operad 层的能力，不是某个 harness 的能力。
8'. **事件是资料、规则是指令**（资料一半已进 ADR 0009）：来源送进来的字决定不了路由、目录、权限；每种插件一把作用域密钥。
9. **一种 harness 是一个描述文件**，任务和会话同一份；接法有两种，官方 SDK 在进程内当客户端，或 ACP 客户端（ADR 0022 D1 到 D3）。
11. 新仓库到 parity 之前，Rust arc 继续跑 dogfood；两边并行是计划内的成本。

## 顺序

`operad-engine` → `operad-plugins` → `operad-harness` → `operad-channels` → `operad-bot`。前两项是新核心，后三项可以在引擎有第一张 graph 之后并行。dogfood（P-0002）之后按场景走：`operad-conversation`（含 iOS 后端）→ `operad-sandbox` 第一版 → Telegram 通道 → `operad-bot` 的 `brain` 与 `digest`；`operad-harness` 的第二种 harness 是 pi（`operad-harness-pi.md`），dogfood 之后就接，不等对话；Claude 走 Agent SDK 排在它后面（`operad-harness-claude.md`）。

## 待决问题（未定）

1. 分发方式（npm 之外是否上 Homebrew）；`operad.run` 是否注册。
2. 沙箱壳的形态：radian 二进制里的子命令（`radian sandbox -- <命令>`），还是独立的小程序。第一版的护栏（访问档：禁入目录、危险命令、询问）已在 `operad-sandbox.md` 定下，不等壳。
3. iOS app 的后端：已定为 operad 自己的 HTTP 层（ADR 0029 D1）；hub 的会话路由留到对话跑通为止。
4. 订阅条款：用 Claude Code 订阅账号跑全自动流水线，厂商建议高频自动化用 API key；哪些 flow 允许订阅账号、哪些要求 API key。交互会话不受此限。
5. 远程机器：push（daemon 拨回）还是 pull。
6. 第二种插件语言：通过跨进程的插件宿主加入，合约不变；什么时候加未定。

## 验收

五个子项各自验收；本文件在 Rust arc 退役、上面的决定都做完后删除。
