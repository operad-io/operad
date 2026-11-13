# operad-conversation：chat，从仓库或 bot 发起的长对话

- 状态：decided（决定已移入 ADR；本文件只留未做的部分、顺序、待决问题和验收）
- 涉及 ADR：0026、0027、0028、0029、0018、0022、0025
- 涉及：`operad.md` 决定 12–17；`operad-presentation.md`；`operad-channels.md` 决定 7–15；`operad-harness.md`；`operad-sandbox.md`；`operad-bot.md`；`operad-dev-flows.md` 决定 4
- 来源：owner 的使用场景；OpenClaw（聊天优先的个人助理）；2026-11-09 的讨论

## 背景

OpenClaw 是聊天优先，operad 到现在是流程优先。第一个要满足的场景是在 iOS 里和一个长期存在的 bot 对话：跨天、跨设备（手机和 Telegram 是同一个 chat），bot 能用工具、读写知识库，中途会问人。今天 iOS 看到的是 radian 的会话（hub 加 control port），只认 radian，也不经过 operad。

2026-11-09 定下 chat 有两种：从一个仓库发起的，为这个仓库干活；从 bot 发起的，是日常 bot。两种是同一个对象，差别只在从哪发起、工作目录和配置从哪读。

## 已定但还没做（留在这里，做完移入 ADR）

- **iOS 的推送**沿用 arc iOS 今天的通道；hub 的会话路由在 chat 跑通之后退役（`operad.md` 待决 3 由此有答案）。
- **第一版不导入 operad 之外开的会话**（终端里的 Claude Code、pi 的会话）。以后做时是 `chat` 插件加一个 `external: true` 的对象类型（`operad-contract.md` 决定 3），内核不动。（ADR 0026 的“不在此决定”写了不导入这一边界。）
- **thinking 在界面上的标签是 `Thinking`**，owner 批准的用户词（effort 这个设置不叫 thinking，和这里的标签是两件事）。今天 thinking 按块引用显示，还没有这个标签。
- **可折叠的工具卡片**需要显示接口有一种结构化的块，以后另议。
- **`dev` 的 worker 活动以后改用同一份归并代码**（`harness-process` 里的共享条目类型）。
- 逐字显示以后觉得不够顺再加一条推送的流，存的东西不用变。

## 顺序

HTTP 接口和 app 换后端已完成（ADR 0029）。剩下按这个顺序：先做 ask 闭环（access-match 的 `askCommands` 判定；claude 的 `canUseTool` 和 pi 的 `tool_call` 调 `ctx.ask`，宽限期、`waiting`、续接加一次性许可三段都走通），它不依赖 chat，也是 `operad-sandbox.md` 第一版的一半；再做 `chat` 基础插件加 `dev:chat`；再做 `bot` 插件的 bot 对象和 `bot:chat`；最后 app 只加 chat 页的输入框。前置：`harness-*` 的 `resumeSession`（已有）、显示接口、事件与规则（已有）、T-0175。

## 待决问题（未定）

1. （已定，见 ADR 0027。）逐 token 流。还剩一项：工具输出的全文文件留多久，和待决 3 一起定。
2. （已定，见 ADR 0027 D1。）附件（图片、文件）怎么进消息、存哪、怎么给 harness。
3. chat 的归档和删除；记录保留多久。
4. 仓库 chat 开出的 worktree 怎么变成 task：task 的第一次尝试直接用这个 worktree，还是 task 新开 worktree 再 cherry-pick；worktree 没变成 task 就被遗忘时谁清理。
5. 一个 chat 的 harness 会话随天数变大，每轮续接都带全量上下文；压缩是 harness 的事，但 chat 比 task 更早撞到费用，要不要在对象上显示累计费用并给一个"从这里重新开始"的动作。

## 验收

在 iPhone 上从一个 repository 行新建一个 chat，再从 默认 bot 行新建一个 chat，两个 chat 各用不同的 harness；连续三天每天几轮，bot 能接上前面的内容；中间它问一次权限，在手机上答；仓库 chat 里它提出要改代码，答应后它在新 worktree 里改，并开出一个 task；同一个 chat 绑定一个 Telegram chat，从 Telegram 发一句，iPhone 上看到问答；把 `operad serve` 杀掉再起来，chat 和待处理都还在；没有任何内部词出现在手机上。
