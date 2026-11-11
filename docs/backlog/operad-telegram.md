# operad-telegram：Telegram 插件，第一个通道，也是第一个外部来源

- 状态：idea（2026-11-10 写下；形状是建议，owner 回头决定）
- 涉及：`operad-channels.md` 决定 1–6、11、16–18；`operad-conversation.md` 决定 2、6、7；`operad-bot.md` 决定 4、6、11；`operad-contract.md` 决定 5、11；`operad-sandbox.md` 决定 5
- 来源：2026-11-09 chat 的讨论；Telegram Bot API（`getUpdates` 长轮询、inline keyboard 的 `callback_query`、reply）

## 背景

`operad-channels.md` 决定 6 定了首个通道是 Telegram，决定 17 定了通道只做四个、Telegram 排第一。chat（P-0024）做完后，operad 有了会问人的 bot，但答的地方只有 iOS app 和命令行；`operad-conversation.md` 的验收要求同一个 chat 绑一个 Telegram chat，从 Telegram 发一句、iPhone 上看到问答。往后 `brain:review` 和 `digest` 都是"送一张卡、卡上两个动作"，卡片协议（channels 决定 1–3）第一次落地也在这里。

Telegram 在 operad 眼里是两件事：往外送卡和回复（通道），把人的消息变成事件（来源）。两个角色一个插件。

## 建议（未定，等 owner）

1. **一个插件 `telegram`，两个角色，进程内跑。** 来源一侧按 channels 决定 11 的 `start(ctx) → { stop }`：`operad serve` 启动它，它用 `getUpdates` 长轮询，每条消息 `ctx.emit` 一个事件（`source: "telegram"`，`key` 是 `update_id`，`object` 是绑定的 chat id），同一 `update_id` 只记一次；`offset` 存在插件自己的状态里，重启后从上次的位置接着拉。不开公网 webhook（assistant 决定 8），验签问题由此不存在。通道一侧按 channels 决定 2：领卡、报送达（带 Telegram 的 `message_id` 做 `ref`）、转达回答。
2. **bot token 存插件 `secrets`**（`operad secret set telegram token`），永不进事实和日志。发信人名单在插件 `settings` 里（Telegram 用户 id 列表）；名单外的消息只记录不回，也不开 chat。每条进来的输入带 `actor: { via: "telegram", id: <用户 id> }`（contract 决定 5）。
3. **绑定**：名单里的用户第一次给 Telegram bot 发消息时，自动用 `bot` 的 `default` profile 建一个 chat 并绑定这个 Telegram chat（conversation 决定 7 的默认）；之后那里的消息都进同一个 chat。要换 profile 或绑到已有的 chat，在 app 或命令行里对 chat 做一个绑定动作。第一版只做私聊，不做群。
4. **回复回到来源**：`chat:reply` 的回复按 conversation 决定 7 送回 Telegram；iOS 同时看得到。回复是 Markdown，按 Telegram 的限制降级（长度分段、不支持的语法去掉）。
5. **卡片**：待处理项送成一条消息加 inline keyboard，按钮一个选项一个，回调带卡片 id、选项和 `ref`；同一张卡只算第一次回答（channels 决定 1）。要 `note` 的动作（reject、ask 的自由回答）用"回复这条消息"的文字，插件按 `reply_to` 对回卡片。回答到达后按钮消失、消息改成"已答：X"。
6. **哪些待处理项送 Telegram**：绑定了 Telegram 的 chat 的问题一律送；其余按 T-0064 的通道默认（等人、结束、循环告警）加插件设置。`dev` 的 merge、confirm 一类 owner 动作在卡上也能答，前提是发信人在名单里；通道密钥本身做不了 owner 动作（channels 决定 2），回答是人做的，插件只转达。
7. **不送直播**：第一版只送卡和回复，不送工具调用流（channels 待决 1 留着）。
8. **表单链接兜底**（channels 决定 3）对 Telegram 不需要，不做。
9. **`digest` 卡上的反应**用按钮，不用表情反应（回答 `operad-bot.md` 待决 2）：有用、没用两个按钮，记成事实。

## 待决问题（未定）

1. 绑定是自动建（建议 3）还是必须先在 app 里绑；自动建的 chat 用哪个 profile。
2. 卡片回答用按钮还是文字；两者并存时文字答按钮卡怎么处理。
3. 名单之外的人发消息：只记录，还是回一句"不认识你"。
4. 多个名单内的用户（家人）是各自一个 profile、一个 chat，还是共用。
5. `offset` 存在哪：插件状态文件，还是事实日志。
6. 回复的 Markdown 降级规则放通道插件，还是引擎提供一个"纯文本通道"的通用降级。

## 验收

Telegram 插件不改内核：给 Telegram bot 发一句，`default` profile 下出现一个 chat，回复回到 Telegram，iPhone 上看到同一问答；chat 里 bot 问一次权限，Telegram 上出现带按钮的卡，点一下运行继续，iPhone 上这项从待处理消失；`review.awaiting_human` 和 proposed task 的卡能在 Telegram 里答；重复的 `update_id` 只算一次；杀掉 `operad serve` 再起来，没漏消息也没重复回复；`history` 能看到一个运行由哪条 Telegram 消息启动。
