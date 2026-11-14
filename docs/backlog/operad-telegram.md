# operad-telegram：Telegram 插件，第一个通道，也是第一个外部来源

- 状态：decided（决定已移入 ADR 0033；本文件只留待决问题和验收）
- 涉及 ADR：0033、0032、0026
- 涉及：`operad-channels.md`（1–5、18 留在 backlog；6、11、16、17 见 ADR 0033 D1、0032 D5、D9、D10）；`operad-conversation.md`（ADR 0026 D2、D6、0028 D6）；`operad-bot.md`（4 留在 backlog；6、11 见 ADR 0032 D10、0030 D3）；`operad-contract.md`（ADR 0007 D2、0010 D2）；`operad-sandbox.md`（ADR 0025 D4）
- 来源：2026-11-09 chat 的讨论；Telegram Bot API（`getUpdates` 长轮询、inline keyboard 的 `callback_query`、reply）

## 背景

ADR 0033 D1 定了首个通道是 Telegram，ADR 0032 D10 定了通道只做四个、Telegram 排第一。chat（P-0024）做完后，operad 有了会问人的 bot，但答的地方只有 iOS app 和命令行；`operad-conversation.md` 的验收要求同一个 chat 绑一个 Telegram chat，从 Telegram 发一句、iPhone 上看到问答。往后 `brain:review` 和 `digest` 都是"送一张卡、卡上两个动作"，卡片协议（`docs/backlog/operad-channels.md` 的前三条）第一次落地也在这里。

Telegram 在 operad 眼里是两件事：往外送卡和回复（通道），把人的消息变成事件（来源）。两个角色一个插件。

## 待决问题（未定）

1. 群聊；把已有的 chat 绑到 Telegram、换 bot 的动作（要新的动作名）。
2. `digest` 卡上的反应（当初的建议是用按钮：有用、没用两个按钮，记成事实）等 `operad-bot.md` 的 `digest` 做的时候再定。

## 验收

Telegram 插件不改内核：给 Telegram bot 发一句，`default` bot 下出现一个 chat，回复回到 Telegram，iPhone 上看到同一问答；chat 里 bot 问一次权限，Telegram 上出现带按钮的卡，点一下运行继续，iPhone 上这项从待处理消失；`review.awaiting_human` 和 proposed task 的卡能在 Telegram 里答；重复的 `update_id` 只算一次；杀掉 `operad serve` 再起来，没漏消息也没重复回复；`history` 能看到一个运行由哪条 Telegram 消息启动。
