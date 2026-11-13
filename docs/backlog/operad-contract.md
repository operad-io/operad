# operad-contract：从场景倒推的内核结构与插件合约

- 状态：大部分已进 ADR；下面只留还没做的两条、顺序和验收
- 涉及 ADR：0006、0007、0008、0009、0010
- 涉及：`operad.md`；`operad-plugins.md`；`operad-presentation.md`；`operad-channels.md` 决定 7–18；`operad-conversation.md`；`operad-sandbox.md`；`operad-bot.md`
- 来源：对话、知识库（可换后台）、记忆、来源插件、每日搜集这几个场景对内核的要求；radian arc 的 reviewer 被 429 吃掉十次 attempt 的教训

## 决定（已定，还没做，所以留在这里）

3. **对象可以住在外面**。对象类型声明 `external: true` 时，插件自己提供 `list`、`get`（从 Obsidian 库、从 harness 的会话目录、从任何外部系统），对象变了调一次 `ctx.changed(ref)`；内核只存关于它的事实，不存它的内容。外部对象的 `list`、`get` 有超时（同 `row` 的 50 毫秒规则，可按类型放宽），超时按错误行显示。内核不索引任何插件的内容。
13'. 插件声明里的 **`skills`**：随运行注入给 harness 的 `SKILL.md` 目录，flow 参数决定给哪些。

## 顺序

3 和 `skills` 都是纯增量、以后加不破坏的；`operad-conversation` 之前不必做。

## 验收

`dev`、`chat`、一个带外部后台的测试插件（对象 `external: true`）和一个来源插件都只通过这份合约和内核打交道；一个步骤 `ctx.ask` 在宽限期内答、超时后答、答案迟到三种情况各有测试，待处理里始终只有一项；一个访问档要求 `askCommands` 而 harness 不声明 `enforces` 时运行被拒并说出字段；`history`、事实、params、环境变量里搜不到任何 `secrets` 的值；`operad plugin check` 对一个只用测试包写的插件通过。
