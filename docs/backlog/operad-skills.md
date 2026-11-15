# operad-skills：skill 放在标准目录，由 operad 明确交给每个 agent

- 状态：decided（owner 2026-11-15；已做的决定移入 ADR，本文件留未做的部分；待决问题见文末）
- 涉及 ADR：0011 D2（`SKILL.md`）、0022（harness 接口和能力声明）、0023 D3、0024 D4、0025（访问档）、0026、0028（chat）、0030 D2、D4、D7（bot 的 skills）、0031（bot 的 MCP 服务器）
- 涉及：`operad-bot.md`（待决 5、7、决定 9）、`operad-chat-commands.md`（决定 6：skills 成为 `/名字`）、`operad-bot-mcp.md`（待决 1：pi 的 MCP）
- 来源：2026-11-15 owner 的讨论；pi 自带文档（`~/.agents/skills/`、`.agents/skills/`）；Claude Agent SDK 0.3.319 的 `skills`、`plugins` 选项

## 背景

`chat:reply` 每次回复都把 bot 设置的 skill 目录传给 agent 进程。claude 和 pi 已声明它们自己加载 skill（ADR 0022、0023 D3、0024 D4）：只加载给定的目录，不自动发现 `~/.claude/skills`、`~/.agents/skills` 一类的位置，加载到的名字写进会话日志。skill 目录仍在 agent 的禁止路径里，所以能读什么、怎么只读还是下面没做的部分。

## 决定（已定，还没做）

1. **不能原生加载的 harness 由 operad 在提示里放一份清单。** ACP 一类的 agent 没有原生入口；operad 把名字、描述和路径放进提示，agent 用读文件的工具去读。
2. **skill 目录对 agent 只读。** 能读才能用；改动仍然只走提议和人的确认（ADR 0030 D4）。脚本由 agent 在自己的 shell 里按访问档运行，operad 不执行（ADR 0030 D7）。
3. **bot 的设置可以列一个父目录**（如 `~/.agents/skills`），等于它里面的每个 skill；以后往里加的 skill 不再经过确认，因为那是用户自己的目录。也可以像今天一样逐个列。
4. **仓库层**：仓库里的 `.agents/skills/` 给这个仓库的 chat 用，由仓库的设置决定（默认就是这个目录，可以改或清空）。
5. **MCP 不做目录。** bot 的 MCP 服务器照 ADR 0031 登记在 operad 的配置里，登记要确认、钉版本，由 operad 交给 agent。

## 待决问题

1. 仓库的 skill 要不要也给任务的 worker（今天只定了仓库 chat）。
2. 新装的 bot 没有 skill：随 operad 带一份默认的，还是让 bot 按用户的描述写（`operad-bot.md` 待决 5）。
3. skill 成为 `/名字`（`operad-chat-commands.md` 决定 6）：原生加载的 agent 把 `/名字 参数` 原样交给它，其余由 operad 把正文拼进消息；与 operad 的命令重名时 skill 让位。lead 的建议，owner 未明确答；等命令第一批合并后做。

## 验收

`default` bot 的设置列 `~/.agents/skills`；不能原生加载的 harness 在提示里看到同一份 skill 清单，并能用读文件的工具读它；agent 改不了 skill 目录里的文件；在 operad 仓库放一个 `.agents/skills/x/SKILL.md`，这个仓库的 chat 能用它，别的仓库的 chat 不能。
