# operad-skills：skill 放在标准目录，由 operad 明确交给每个 agent

- 状态：decided（owner 2026-11-15；待决问题见文末）
- 涉及 ADR：0011 D2（`SKILL.md`）、0022（harness 接口和能力声明）、0025（访问档）、0026、0028（chat）、0030 D2、D4、D7（bot 的 skills）、0031（bot 的 MCP 服务器）
- 涉及：`operad-bot.md`（待决 5、7、决定 9）、`operad-chat-commands.md`（决定 6：skills 成为 `/名字`）、`operad-bot-mcp.md`（待决 1：pi 的 MCP）
- 来源：2026-11-15 owner 的讨论；pi 自带文档（`~/.agents/skills/`、`.agents/skills/`）；Claude Agent SDK 0.3.319 的 `skills`、`plugins` 选项

## 背景

bot 的设置可以列 skill 目录，`chat:reply` 每次回复都把它们传给 agent 进程，但 claude 和 pi 的 worker 都不读这个参数（pi 设了 `noSkills: true`，claude 以空的设置来源启动），skill 目录还在 agent 的禁止路径里。所以 skill 今天不起作用。

`.agents/skills/`（项目）和 `~/.agents/skills/`（用户）是 Agent Skills 的通用位置，pi 原生读它；Claude Code 读的是 `.claude/skills`。靠 agent 自己发现做不到每个 agent 都读到同一份。

## 决定

1. **目录用标准的，交给 agent 是明确的，由设置决定。** skill 是带 `SKILL.md` 的目录，位置用 `.agents/skills` 这个通用布局；哪个 agent 拿到哪些 skill 只由 operad 的设置决定，agent 不自动发现任何目录（用户的 `~/.claude/skills`、`~/.agents/skills` 不会自己进来）。
2. **每个 agent 用它自己的方式加载同一份 skill。** harness 声明它能不能原生加载 skill：能的（claude、pi）由 worker 用原生入口加载列出的目录，只有名字和描述常驻上下文；不能的（ACP 一类）由 operad 在提示里放一份清单（名字、描述、路径），agent 用读文件的工具去读。
3. **skill 目录对 agent 只读。** 能读才能用；改动仍然只走提议和人的确认（ADR 0030 D4）。脚本由 agent 在自己的 shell 里按访问档运行，operad 不执行（ADR 0030 D7）。
4. **选一个目录就自动加载它里面的全部。** bot 的设置可以列一个 skill 的父目录（如 `~/.agents/skills`），也可以直接列 `.agents` 目录（如 `~/.agents`，等于它的 `skills/`）；里面的每个 skill 都加载，以后往里加的也自动加载，不再经过确认，因为那是用户自己的目录。也可以像今天一样逐个列。
5. **仓库层**：仓库里的 `.agents/skills/` 给这个仓库的 chat 用，仓库里有这个目录就自动加载，不用设置；仓库的设置可以改成别的目录或清空。
6. **MCP 不做目录。** bot 的 MCP 服务器照 ADR 0031 登记在 operad 的配置里，登记要确认、钉版本，由 operad 交给 agent。
7. **可以建一个只带选定 skill 和 MCP 服务器的 bot**（owner 2026-11-15）。每个 bot 的 skill 列表和 MCP 服务器本来就是各自的；缺的是创建这一步：建 bot 时给名字、agent、模型，并从已有的里面选 skill（别的 bot 用着的、`~/.agents/skills` 里的）和 MCP 服务器（别的 bot 上已经确认过的）。没选的一概没有。选一个已确认过的 MCP 服务器是照原样复制它钉住的版本和工具摘要，不再问一次（lead 的建议，owner 未明确答）；全新的服务器仍走 ADR 0031 的确认。

## 待决问题

1. 仓库的 skill 要不要也给任务的 worker（今天只定了仓库 chat）。
2. 新装的 bot 没有 skill：随 operad 带一份默认的，还是让 bot 按用户的描述写（`operad-bot.md` 待决 5）。
3. skill 成为 `/名字`（`operad-chat-commands.md` 决定 6）：原生加载的 agent 把 `/名字 参数` 原样交给它，其余由 operad 把正文拼进消息；与 operad 的命令重名时 skill 让位。lead 的建议，owner 未明确答；等命令第一批合并后做。
4. Claude 一侧怎样把任意目录交给它（SDK 的 `skills` 选项只在已发现的 skill 里挑；可能要临时拼一个插件目录用 `plugins` 加载），做的时候先试。

## 验收

`default` bot 的设置列 `~/.agents/skills`；在一个 pi 的 chat 和一个 claude 的 chat 里各让 bot 用同一个 skill，两边都用上；agent 改不了 skill 目录里的文件；`~/.claude/skills` 里的 skill 没有出现在任何 chat 里；在 operad 仓库放一个 `.agents/skills/x/SKILL.md`，这个仓库的 chat 能用它，别的仓库的 chat 不能。
