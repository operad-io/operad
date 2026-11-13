<p align="center"><a href="README.md">English</a> · <b>中文</b></p>

<h1 align="center">operad</h1>

<p align="center"><b>编码 agent 的开放编排层。</b><br>
让任何 agent 走一条经过验证的流程：计划、开发、检查、评审、合并。</p>

<p align="center">
<a href="https://www.npmjs.com/package/@operad-io/cli"><img alt="npm" src="https://img.shields.io/npm/v/@operad-io/cli?label=%40operad-io%2Fcli"></a>
<a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue"></a>
<a href="https://operad.io/zh/">operad.io</a>
</p>

---

operad 让编码 agent（radian、Claude Code、Codex、pi 等）走一条会检查它们工作的流程，把发生过的事记成 history，需要人的时候再来找你。你只会看到三样东西：

- **flow**：一件事要走的路。
- **pending**：所有在等你的事，放在一个列表里，每一项带着它能做的操作。
- **history**：每一步做了什么，为什么。

其余都是插件。

```text
$ operad pending
4c1e9a02  dev  confirm
  Rotate the http token
  waiting: ready to merge
  actions: dev:merge, dev:reject, dev:rework,
           dev:reverify, dev:cancel

$ operad dev:merge T-0022-token-rotate --yes
```

## 安装

operad 跑在 [Bun](https://bun.com) 上，先装好 Bun。然后：

```sh
bun add -g @operad-io/cli
operad --help
```

只要 `bun` 在 `PATH` 里，`npm install -g @operad-io/cli` 也行。

你还需要 `git`、一个带 remote 的仓库，以及 `PATH` 里有 `claude`、`pi` 或 `radian` 之一。

## 快速上手

```sh
operad init                     # 创建 home，检查插件
operad repo add .               # 注册当前仓库
operad plan add --slug hello --title "Add a greeting" < request.md
operad task add --plan P-0001-hello --slug greet --title "Print the greeting" < task.md
operad dev:confirm P-0001-hello
operad serve                    # 跑起循环

operad pending                  # 有什么在等你
operad dev:merge T-0001-greet --yes
```

不确定 `.operad/dev.json` 怎么写？把[这段 prompt](docs/user/setup-prompt.md)（英文）贴给你的 coding agent，它会替你写好并检查。agent 会用你写的语言回复。

## 工作方式

1. **你提需求。** 用 `operad plan add` 写下需求，用 `operad task add` 拆成任务，再确认计划。
2. **agent 开发。** 每个任务有自己的 git worktree 和一份说明。worker 在里面提交。
3. **跑检查。** 你在 `.operad/dev.json` 里列的命令，会在这次提交上跑一遍。
4. **agent 评审。** reviewer 读改动，写一份报告。有意见就退回返工，次数有上限。
5. **你来合并。** 任务停在 pending 里等你。merge 合进 main；reject 带上你的批注退回去。

谁都能开发，谁都能评审，按仓库来选：

```jsonc
// .operad/dev.json
{
  "workers":  { "claude": { "use": "claude/agent", "args": ["--model", "sonnet"] } },
  "reviewer": { "use": "pi/agent",     "args": ["--thinking", "medium"] }
}
```

## 在哪里用

- **终端。** `operad tui` 列出待办和运行中的东西，在列表旁边打开某一项。见[终端客户端](docs/user/tui.md)。
- **Claude Code。** `operad mcp` 是一个走 stdio 的 MCP server。主 agent 可以读 pending、running 和 history，做 `config.json` 允许的操作，但不会替你做决定：merge 始终归你。见 [MCP](docs/user/mcp.md)。
- **iPhone。** 运行 `operad pair` 扫码。app 里能看到 pending、running 和每个对象的 history，merge 之前会再问你一次。见 [app](docs/user/app.md)。

## 插件

内核只有三个词，其余都是插件：`dev`（计划、任务、评审、合并）、`chat`（和 agent 的长对话）、`bot`（一个目录、一个 agent、一组 skill）、`pool`（每个 agent 共用的额度）。插件是 TypeScript 文件，不用构建就能加载，小到让 agent 当场就能写出来，运行前 `operad plugin check` 会先做类型检查。从 [Writing a plugin](docs/plugins/index.md) 开始。

## 文档

文档目前是英文。

- [User manual](docs/user/index.md)：quickstart、`config.json`、`dev` 插件、access profile、所有命令、排错。
- [Writing a plugin](docs/plugins/index.md)：给插件作者。
- [docs/backlog/](docs/backlog/)：方向和还没定的问题。

## 状态

operad 还在开发中，会有毛边，也会有变动。

## 包

这些包发布在 `@operad-io` 下。大多数人只需要装 `@operad-io/cli`，其余的随它一起装上，或者从它里面启用。

| 包 | 是什么 |
|---|---|
| [`cli`](packages/cli) | `operad` 命令 |
| [`engine`](packages/engine) | 内核：flow、pending、history，以及插件 API |
| [`dev`](packages/dev) | 仓库上的计划和任务，直到合并 |
| [`shell`](packages/shell) | shell 命令和检查步骤 |
| [`chat`](packages/chat), [`bot`](packages/bot) | 和 agent 的对话；目录、agent 和 skill |
| [`pool`](packages/pool) | 在多次运行之间共用的 worker |
| [`tui`](packages/tui), [`mcp`](packages/mcp) | 终端客户端；MCP server |
| [`harness/claude`](packages/harness/claude), [`harness/codex`](packages/harness/codex), [`harness/pi`](packages/harness/pi), [`harness/radian`](packages/harness/radian) | operad 能跑的 agent |
| [`harness/process`](packages/harness/process) | 各 harness 共用的辅助代码 |
| [`access-match`](packages/access-match), [`review-grading`](packages/review-grading) | 工具调用的 access profile；评审分级 |

每个包都有一份简短的 README 指回这里；给开发者的详细笔记在它旁边的 `REFERENCE.md` 里。

## 许可

MIT，见 [LICENSE](LICENSE)。
