# operad-open-framework：把 operad 自己的开发流程从代码里拿出去

- 状态：A1 到 A4、B1 到 B4 已做并进了 ADR；A5 未定
- 涉及 ADR：0034、0035
- 涉及：`operad-dev-flows.md`；`operad-plugins.md`；`operad-worker-pool.md`

## 背景

operad 和 `dev` 要做成开放框架：别的项目、别的技术栈拿来就能用，不必照 operad 自己的开发方式。operad 自己的方式应当只出现在本仓库的 `.operad/dev.json`、`.operad/review.json`、`.operad/worker-brief.md`、`CLAUDE.md` 和 `scripts/` 里。已定并做完的部分（flaky 规则和复现命令、主 clone 的 `prepare`、serve 旧代码的提醒、默认值挪进 CLI、边界测试、非 Bun 的示例仓库）都在 ADR 0034。

## 还没做的：A5（零散的写死项）

1. `service.ts` 的排除列表里有 `.radian-sandbox/`：`dev` 知道了某个 harness 的目录。
2. `REQUIRED_PLUGINS` 写死 `pool`；默认 worker 写死 `harness-radian/agent`（`settings.ts`）。
3. 分支名 `work/<task>` 和合并信息 `Merge work/<id> (<sha>)` 写死（`steps.ts`、`integrate.ts`、`DEFAULT_AFTER_MERGE`），而 `remote`、`mainBranch`、`worktreeRoot` 可配。

当初的建议（未定）：排除列表由各 harness 自己声明或由仓库配置；分支名前缀和合并信息做成设置，默认值不变；`pool` 和默认 worker 留着，属于 `dev` 的合理依赖，只在文档里写明。

## 待决问题（未定）

1. A5：排除列表里的 `.radian-sandbox/` 由谁声明（harness 自己，还是仓库配置）；分支名前缀 `work/` 和合并信息要不要做成设置。它们不是 Bun 的约定，别的技术栈的仓库不会因此走不通，所以不在已做的那一批里。
2. 已有的 home 如果 `config.json` 里没有 `mcp.actions`，lead 能做的动作是空；升级说明里写一句，还是 `init` 之外再给一个补默认值的办法。

## 验收

一个不用 Bun、没有 `scripts/`、没有 `CLAUDE.md`、不是 `packages/*` 布局的仓库，只写 `.operad/dev.json` 就能走完 plan → task → 检查 → review → 合并；它的 flaky 任务 brief、合并后的主 clone、检查用的 checkout 里都不出现 bun 或 operad 仓库的约定。本仓库把这些约定搬进自己的配置之后，行为和今天一样（现有测试全过）。engine 的源码里没有任何插件的名字和动作名。
