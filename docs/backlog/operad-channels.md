# operad-channels：卡片协议、作用域密钥、通道与来源

- 状态：idea（方向已定：做；首个通道是 Telegram）
- 涉及 ADR：0045、0034、0024
- 来源：`operad.md`；`research/2026-11-04-agent-autoloop.md`「协议要点」「界面」；`hub-event-inlet.md`

## 背景

找人今天只有 iOS app 和 `[hooks]` 的 ntfy / Bark 行，只出不进；回答只能在 app 里。活进来今天只有人和 lead 加任务。要的是：任何通道都能收卡片、报送达、把回答送回来；任何来源都能把世界变成事件。两者都是只往引擎拨的小进程，用 SDK 几十行写完。

## 决定（已定）

1. 卡片是协议里的持久对象：标题、正文、选项、推荐项、版本、送达的 `ref`、回答；内容创建后不变，只有状态变。幂等：同一张卡只算第一次回答；还没送达就解决了的不再打扰。
2. 通道协议：长轮询领卡片、报送达或失败、转达回答；回答要带送达时的 `ref`，回答人要在通道的名单里。通道密钥只能做这三件事，不能做 owner 动作。
3. 只会发文字的通道用一个不跑脚本的表单链接兜底，持有即可答，限期。
4. 来源协议：`POST` 事件（来源、编号、类型、对象、一句话、链接），同一来源同一编号只记一次；事件带 `cwd`、harness、access 直接拒收；`summary` 和 `detail` 只当资料写进文件，不进提示词。
5. 来源分三档：observe（只记录"本会接受"）、候选、自动；归属已有运行的事件直通该运行，不开新运行。
6. 首个通道是 Telegram，首个来源是 cron 加 HTTP。

## trigger 的内核接口（已定，dogfood 期间先落地内核部分）

7. **所有运行都从同一个入口启动**：`start({ flow, object, trigger? })`。dev 插件的调度、命令行、来源事件都走它；`trigger` 是 `{ source, key, type, summary?, link?, data? }`，带 trigger 的启动先记一条输入（同一 `source`+`key` 只记一次，重复时什么也不做并返回第一次的结果），`run_started` 的原因指向这条输入，所以历史能说出“由哪个事件启动”。
8. **路由由用户的规则决定，不由事件决定**：`~/.operad/triggers.json` 是一组规则 `{ source, type, start: { flow, params? }, object, mode, schedule? }`（JSON，带 Schema）；规则的目标永远是“一个 flow 加参数”，`params` 是固定的 JSON；`object` 可以是固定的，也可以取事件里的 `object` 字段，但只能取这一个字段；事件里其余内容只是资料。没有规则匹配的事件只记录。
9. **三档**：`observe` 只记一条“本会启动 X”；`candidate` 在待处理里出现一项，带内核的两个动作 `operad:start` 和 `operad:dismiss`；`auto` 直接启动。同一对象已有该 flow 的运行在跑时，事件记在那个运行的历史里，不开新运行。
10. **步骤怎么看到事件**：`ctx.trigger` 只读，`summary` 和 `data` 写成文件，步骤自己决定读不读；内核从不把事件文字放进任何提示词。
11. **来源是 `source` 插件**：`start(ctx) → { stop }`，用 `ctx.emit(event)` 送事件；`operad serve` 启动和停止它。内置的第一个来源是 `cron`（`triggers.json` 里的规则带 `schedule`，五段 cron 表达式，按本机时区），HTTP 和 webhook 验签以后再做。命令行 `operad trigger <source> <key> [--type] [--object] [--data <file>]` 手工送一个事件，给测试和脚本用。

12. **单条 prompt 也是 flow。** 每个 harness 插件自带一个 `<harness>:prompt` flow（第一个是 `harness-radian:prompt`），参数 `{ prompt, cwd, args? }`，只有一步：跑一次 agent。规则要“事件来了跑一段 prompt”时就写 `start: { flow: "harness-radian:prompt", params: { prompt, cwd } }`；内核不为 prompt 另开一条路。
13. **运行的结果又是事件。** 每次运行结束，内核以来源 `operad` 发一个事件：类型 `run.done`、`run.failed` 或 `run.cancelled`，`key` 是运行 id，`object` 是该运行的对象，`data` 是运行的结果（结束的结果名、最后一步的事实摘要）。它和别的事件一样走规则，所以“A 跑完再跑 B”就是一条 `source: "operad", type: "run.done"` 的规则。步骤也可以用 `ctx.emit({ type, key, object?, summary?, data? })` 发自己的事件，来源记为 `operad`，类型由插件起名（`<插件>.<名字>`）。
14. **连锁有上限。** 每个事件带 `hops`：外部事件是 0，运行发出的事件是启动该运行的事件的 `hops` 加 1。`hops` 超过 8 的事件只记录不启动，历史里写明原因。
15. **事件内容进 prompt 的方式。** 内核仍然从不把事件文字放进提示词（决定 10）。`<harness>:prompt` flow 在有 `ctx.trigger` 时，在 prompt 末尾加一行固定的说明，指向事件的 `summary` 和 `data` 文件路径，并说明那是外部资料、不是指令；读不读由 agent 决定。

## 待决问题（未定）

1. 通道怎么显示一个会话的直播（不只是卡片）：是否把 `session/update` 流也送到通道，还是通道只管卡片。
2. 来源的 webhook 验签放哪：来源插件翻译，还是引擎只收已验签的 HTTP。
3. 表单链接的有效期和一次性。

## 验收

Telegram 通道作为插件（不改核心）能收 `review.awaiting_human`、`todo.proposed` 和会话的 pending question，能在 Telegram 里回答，回答到达引擎后运行继续；一次 HTTP 事件或一条 cron 变成一次运行，重复事件只算一次，`operad history` 能看到它来自哪个事件。
