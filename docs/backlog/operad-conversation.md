# operad-conversation：长对话，iOS 里的助理会话

- 状态：decided（方向与形状；流式与附件未定）
- 涉及 ADR：0024、0018、0022、0049
- 涉及：`operad.md` 决定 12–17；`operad-presentation.md`；`operad-channels.md` 决定 7–15；`operad-harness.md`；`operad-sandbox.md`
- 来源：owner 的使用场景；OpenClaw（聊天优先的个人助理）

## 背景

OpenClaw 是聊天优先，operad 到现在是流程优先。第一个要满足的场景是在 iOS 里和一个长期存在的助理对话：跨天、跨设备（手机和 Telegram 是同一个对话），助理能用工具、读写知识库，中途会问人。今天 iOS 看到的是 radian 的会话（hub 加 control port），只认 radian，也不经过 operad。

## 决定（已定）

1. **对话是一个对象，归 `chat` 基础插件**（随 operad 安装）。用户可见的新名词只有一个：对话（conversation）。对象字段：harness、工作目录、访问档（`operad-sandbox.md`）、标题、harness 的会话引用、绑定的通道。消息是对话上的事实（谁、何时、正文、附件路径、来源引用），不是对象字段。
2. **一条进来的消息是一个事件**：来源 `ios`、`telegram`、`cli`，`key` 是消息 id，`object` 是对话 id。`chat` 插件自带规则：这类事件以 `auto` 启动 `chat:reply`。这要求插件能带默认规则，用户的 `triggers.json` 覆盖（`operad-channels.md` 决定 16）。
3. **`chat:reply` 只有一个步骤加一个回环**：把未回复的消息拼成 prompt，用 harness 步骤续接对话的 harness 会话（`resumeSession`），把最后一条回复记成事实，更新会话引用；结束前看一眼有没有回复期间新到的消息，有就再走一遍（`maxVisits` 封顶）。对话的上下文长度是 harness 的事（radian 自动压缩，ADR 0018）；内核不存任何提示词。
4. **发消息就是一个带 `note` 的动作**：`chat:send <对话> --note <正文>`。iOS 的输入框、命令行、Telegram 通道都走它，客户端 API 不加新调用。附件以后再加。
5. **iOS 看对话走已有的显示接口**：对话列表是 `list conversation`；对话页是 `transcript` 段（`live`，按 `events` 刷新，目前后台最慢半秒）加输入框。第一版按消息刷新，不做逐 token 流。
6. **中途问人**：助理在对话里问问题或要权限（ACP `request_permission`、radian 的 `ask_user`）时，进程留着，问题成为待处理项（对象是这个对话），iOS 和 Telegram 都能答；超过 `askTimeoutSecs`（默认 10 分钟）没人答，按访问档的默认回答（拒绝一次），这一轮以"未回答"结束，问题留在对话里。这是对"等人不占进程"的有意例外：对话是交互的，几分钟的进程是正常的；跨天的等待仍走 flow 的等人步骤。
7. **一个对话可以绑定多个通道**：Telegram 的一个 chat 绑到一个对话后，那里的消息进同一个对话，回复送回来源通道，iOS 全都看得到。默认每个（通道，chat）一个对话；iOS 新建的对话不绑通道。
8. **对话的记忆是知识库，不是引擎**：助理跨对话记得的东西写在 `operad-assistant.md` 定的 Markdown 知识库里，由 skill 规定怎么读写；引擎只存对话记录。radian 自己的 memory（ADR 0021）不参与。
9. **每个对话有访问档**：工作目录、禁入目录、危险命令，见 `operad-sandbox.md`；危险命令触发的询问走决定 6。
10. **iOS 的后端换成 operad**：`operad serve` 把显示接口（`list`、`get`、`section`、`events`、`act`）按 `operad-presentation.md` 决定 7 暴露成 HTTP：只听本机和局域网或 Tailscale 地址，必须带 token，`events` 用 SSE；推送沿用 arc iOS 今天的通道。hub 的会话路由在对话跑通之后退役（`operad.md` 待决 3 由此有答案）。

## 顺序

PL0002 之后的第一个计划。前置：`harness-radian` 的 `resumeSession`、显示接口、事件与规则。先 radian 一种 harness；Claude Code 和 pi 的会话随 `operad-harness.md` 的 ACP 接法进来，对话对象不变。

## 待决问题（未定）

1. 逐 token 流：harness 的 ACP `session/update` 流由 `operad serve` 转成带游标的 live 段，还是另开一条流。
2. 附件（图片、文件）怎么进消息、存哪、怎么给 harness。
3. 一个对话切换 harness 或模型：新建对话，还是在对话里切（会话引用随之失效）。
4. 对话的归档和删除；记录保留多久。

## 验收

在 iPhone 上新建一个对话，连续三天每天几轮，助理能接上前面的内容；中间它问一次权限，在手机上答；同一个对话绑定一个 Telegram chat，从 Telegram 发一句，iPhone 上看到问答；把 `operad serve` 杀掉再起来，对话和待处理都还在；没有任何内部词出现在手机上。
