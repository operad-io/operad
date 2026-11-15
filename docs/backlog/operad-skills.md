# operad-skills：skill 放在标准目录，由 operad 明确交给每个 agent

- 状态：decided（owner 2026-11-15；已做的决定移入 ADR，本文件留未做的部分；待决问题见文末）
- 涉及 ADR：0011 D2（`SKILL.md`）、0022（harness 接口和能力声明）、0023 D3、0024 D4、0025（访问档）、0026、0028（chat）、0030 D2、D4、D7（bot 的 skills）、0031（bot 的 MCP 服务器）
- 涉及：`operad-bot.md`（待决 5、7、决定 9）、`operad-chat-commands.md`（决定 6：skills 成为 `/名字`）、`operad-bot-mcp.md`（待决 1：pi 的 MCP）
- 来源：2026-11-15 owner 的讨论；pi 自带文档（`~/.agents/skills/`、`.agents/skills/`）；Claude Agent SDK 0.3.319 的 `skills`、`plugins` 选项

## 背景

`chat:reply` 每次回复都把 bot 设置的 skill 目录传给 agent 进程。claude 和 pi 已声明它们自己加载 skill（ADR 0022、0023 D3、0024 D4）：只加载给定的目录，不自动发现 `~/.claude/skills`、`~/.agents/skills` 一类的位置，加载到的名字写进会话日志。skill 目录由访问档允许读、拒绝写。

## 决定（已定，还没做）

1. **仓库层**：仓库里的 `.agents/skills/` 给这个仓库的 chat 用，仓库里有这个目录就自动加载，不用设置；仓库的设置可以改成别的目录或清空。
2. **MCP 不做目录。** bot 的 MCP 服务器照 ADR 0031 登记在 operad 的配置里，登记要确认、钉版本，由 operad 交给 agent。
3. **可以建一个只带选定 skill 和 MCP 服务器的 bot**（owner 2026-11-15）。每个 bot 的 skill 列表和 MCP 服务器本来就是各自的；缺的是创建这一步：建 bot 时给名字、agent、模型，并从已有的里面选 skill（别的 bot 用着的、`~/.agents/skills` 里的）和 MCP 服务器（别的 bot 上已经确认过的）。没选的一概没有。选一个已确认过的 MCP 服务器是照原样复制它钉住的版本和工具摘要，不再问一次（lead 的建议，owner 未明确答）；全新的服务器仍走 ADR 0031 的确认。

## 待决问题

1. 仓库的 skill 要不要也给任务的 worker（今天只定了仓库 chat）。
2. 新装的 bot 没有 skill：随 operad 带一份默认的，还是让 bot 按用户的描述写（`operad-bot.md` 待决 5）。
3. skill 成为 `/名字`（`operad-chat-commands.md` 决定 6）：原生加载的 agent 把 `/名字 参数` 原样交给它，其余由 operad 把正文拼进消息；与 operad 的命令重名时 skill 让位。lead 的建议，owner 未明确答；等命令第一批合并后做。

## 验收

`default` bot 的设置列 `~/.agents/skills`；agent 改不了 skill 目录里的文件；`~/.claude/skills` 里的 skill 没有出现在任何 chat 里；在 operad 仓库放一个 `.agents/skills/x/SKILL.md`，这个仓库的 chat 自动能用它，别的仓库的 chat 不能。
