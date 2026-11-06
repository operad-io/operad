# operad-assistant：个人助理场景

- 状态：idea（排在 `operad-engine`、`operad-plugins`、`operad-harness`、`operad-channels` 之后）
- 涉及 ADR：0021、0025
- 来源：`operad.md`；`research/2026-11-04-agent-autoloop.md`「拿来即用的场景模板」；`research/2026-11-05-noop.md`「决定、门禁、自治」

## 背景

同一个引擎长出来的第二个场景：早报、收件箱分诊、告警跟进、网站巡检、周报、PR 自动交付。OpenClaw 已经是这个场景的大众选项，arc 不在通道数量和技能市场上追它；arc 的差异是 graph、多 harness、验证、沙箱、自托管。

## 待决问题（未定）

1. 场景模板的形态：每个模板一张 graph 加一个 skill 加启用说明（照 agent-autoloop 的七个模板）；哪几个先做。
2. 助理的记忆：复用 radian 的 memory（ADR 0021）还是引擎自己的；owner 的决定先例怎么存、怎么给后续运行看。
3. 要不要影子 judge：只量"judge 的影子答案和 owner 答案的一致率"，按 graph 统计，作为自动档升降的依据；不做自动决定。
4. 空闲时主动提议下一步（noop 的 idle menu）要不要，怎么不打扰。
5. 非编码场景的 action 插件边界：发消息、改日历、花钱，哪些永远先问。

## 验收

idea 阶段只写最小形态：三个场景模板（早报、网站巡检、GitHub issue 跟进）各作为一张 graph 加一个 skill 存在，在新引擎上跑通，找人走 Telegram 通道。
