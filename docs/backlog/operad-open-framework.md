# operad-open-framework：把 operad 自己的开发流程从代码里拿出去

- 状态：idea（2026-11-11 写下；清单来自一次代码检查，形状是建议，owner 回头决定）
- 涉及：`operad.md` 决定 12、14、15、16、17；`operad-dev-flows.md`；`operad-plugins.md`；`operad-worker-pool.md`
- 来源：2026-11-11 对 `packages/` 非测试源码的检查（关键词搜索加重点文件阅读，不是逐行通读，可能有漏的小处）

## 背景

operad 和 `dev` 要做成开放框架：别的项目、别的技术栈拿来就能用，不必照 operad 自己的开发方式。operad 自己的方式应当只出现在本仓库的 `.operad/dev.json`、`.operad/review.json`、`.operad/worker-brief.md`、`CLAUDE.md` 和 `scripts/` 里。

检查的结论：内核、CLI、TUI、MCP 基本干净；评审规则、MUTATIONS、worker brief、检查命令都已经只在配置里。写进代码的本地流程集中在 `dev` 插件，共五处；另有四处内核对 `dev` 的轻度耦合。

## 清单

### A. `dev` 插件里写死的本地流程

1. **flaky 任务的 brief**（`packages/dev/src/flaky.ts`）
   - `FLAKY_RULE` 是本仓库 `CLAUDE.md` “Flaky tests” 一节的原文：`scripts/stress.sh --runs <N> --load 2`、十分钟、20 到 200 次、机器级的锁。
   - `flakyRule` 读仓库的 `CLAUDE.md`，找 `## Flaky tests` 标题；文件名和标题都是本仓库的约定。
   - 复现命令先探测 `scripts/stress.sh`，没有就用 `bun test --rerun-each`。
   - `packageOf` 用 `packages/<name>/` 推出任务的 area，是本仓库的目录布局。
   - `failureExcerpt` 按 bun 的 `(fail) name [` 和 `N tests failed:` 解析日志；而 `gate.commands[].failed.match` 是可配置的，两边不一致。
2. **合并后更新主 clone**（`packages/dev/src/mainclone.ts`）：`bun.lock` 变了就跑 `bun install --frozen-lockfile`，写死。
3. **`linkWorkspacePackages`**（`packages/dev/src/prepare.ts`，`gate.ts` 调用）：仓库没配 `prepare` 时，按 `package.json` 的 workspaces 和 `packages/*` 往 `node_modules` 里建软链。只对 Bun workspace 有意义。
4. **“serve 在跑旧代码”的提醒**（`packages/dev/src/standing.ts`，`integrate.ts` 调用 `recordServeCode`）：只在被开发的仓库就是 operad 自己的代码根时生效，认 `@operad-io/` 前缀和 `packages/<name>/`。是自举功能，放在通用的 `dev` 里。
5. **零散的**
   - `service.ts` 的排除列表里有 `.radian-sandbox/`：`dev` 知道了某个 harness 的目录。
   - `REQUIRED_PLUGINS` 写死 `pool`；默认 worker 写死 `harness-radian/agent`（`settings.ts`）。
   - 分支名 `work/<task>` 和合并信息 `Merge work/<id> (<sha>)` 写死（`steps.ts`、`integrate.ts`、`DEFAULT_AFTER_MERGE`），而 `remote`、`mainBranch`、`worktreeRoot` 可配。

### B. 内核对 `dev` 的耦合

1. `packages/engine/src/config/config.ts`：`DEFAULT_MCP.actions` 默认列了五个 `dev:*` 动作。
2. 同一文件：`DEFAULT_PLUGINS`、`OPTIONAL_PLUGINS` 把 `shell`、`harness-radian`、`dev` 等插件名写在 engine 里。
3. `packages/cli/src/main.ts` 的 `onCancelRun`：输入来源写成 `"dev"`，会记进日志；看起来是遗留。
4. TUI 用 `/^(done|merged)$/` 判断一行是否完成（`view/index.ts` 三处、`state.ts` 一处）；`merged` 是 `dev` 的状态词，mark 机制已经能表达。

## 建议的形状（未定）

1. **A1**：flaky 的规则文本、复现命令、area 的推导都由仓库在 `dev.json` 里给；`dev` 自带的默认只留一句和工具无关的话（“失败后重跑通过的测试是 bug；不要加超时或重试让它通过”），没给复现命令时 brief 不写命令。日志摘录改用该命令自己的 `failed.match` 找失败行，不认 bun 的格式。本仓库把今天的文字和命令搬进 `.operad/dev.json`。
2. **A2**：主 clone 快进之后跑仓库配置的命令（复用 `prepare`，或新加一个只在主 clone 跑的 hook），不认 `bun.lock`。本仓库在配置里写 `bun install --frozen-lockfile`。
3. **A3**：删掉 `linkWorkspacePackages`；需要的仓库写 `prepare`。先确认本仓库和 radian-ios 都已经有 `prepare`。
4. **A4**：从 `dev` 里拿出去。候选：一个只给自举用的小插件；或由内核的 code-watch 提供（它已经知道 serve 加载了哪些代码）。
5. **A5**：排除列表由各 harness 自己声明或由仓库配置；分支名前缀和合并信息做成设置，默认值不变；`pool` 和默认 worker 留着，属于 `dev` 的合理依赖，只在文档里写明。
6. **B1、B2**：默认插件和默认 MCP 动作挪到 CLI 的 `init`（发行版的默认），engine 的默认是空。MCP 可用的动作更合适由插件自己声明“哪些动作可以交给 lead”，内核只合并。
7. **B3**：改成 `"cli"`；先查有没有读这个来源的代码和已有日志。
8. **B4**：TUI 只看 mark；`dev` 给完成的行都打上 mark 之后删掉这个兜底。

## 待决问题（未定）

1. A1、A2、A5 都会给 `dev.json` 加新的设置键，是新的用户可见的词（决定 14），键名要 owner 同意。
2. A4 放哪里：独立插件，还是内核 code-watch。后者要看是否违反决定 12（内核不加插件能做的事）。
3. B1 的“插件声明可交给 lead 的动作”是合约的改动，要不要做，还是只把默认值挪到 `init`。
4. 要不要加一条测试守住边界：`packages/dev/src` 里不出现 `bun `、`scripts/`、`CLAUDE.md`、`packages/` 这类字样；engine、cli、tui、mcp 的源码里不出现 `dev:` 和其他插件名。
5. 是否用一个非 Bun 的示例仓库（比如 Python 或 Go 的小项目）做验收，并放进文档。

## 验收

一个不用 Bun、没有 `scripts/`、没有 `CLAUDE.md`、不是 `packages/*` 布局的仓库，只写 `.operad/dev.json` 就能走完 plan → task → 检查 → review → 合并；它的 flaky 任务 brief、合并后的主 clone、检查用的 checkout 里都不出现 bun 或 operad 仓库的约定。本仓库把这些约定搬进自己的配置之后，行为和今天一样（现有测试全过）。engine 的源码里没有任何插件的名字和动作名。
