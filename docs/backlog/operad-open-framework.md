# operad-open-framework：把 operad 自己的开发流程从代码里拿出去

- 状态：decided（2026-11-13 owner 定了 A1、A2、A4、B1、B2 的形状，见“决定”；A5 未定；A3、B3、B4 已做，P-0028）
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
3. **`linkWorkspacePackages`**（已删除，T-0272）：原先仓库没配 `prepare` 时，`dev` 按 `package.json` 的 workspaces 和 `packages/*` 往检出的 `node_modules` 里建软链，只对 Bun workspace 有意义。现在没配 `prepare` 的仓库得到一份普通检出，`dev` 自己不安装也不建链接。
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

## 决定（已定，2026-11-13 owner）

仓库已公开、npm 发布在即，别的技术栈的仓库装上后会撞到下面这些写死的约定，所以这一项排在 Telegram 之前。

1. **A1：flaky 的规则和复现命令放进 `gate.commands[].failed`**（`integration.keyCommands[].failed` 同样），不加新的顶层词。新增两个键：
   - `failed.stress`：复现命令，带 `{pattern}` 和 `{file}`，和已有的 `failed.rerun` 同一套占位；没给时 brief 不写命令。
   - `failed.rule`：一个文件路径（相对仓库），内容是这个仓库对 flaky 测试的规则文字；没给时用 `dev` 自带的一句和工具无关的话（“失败后重跑通过的测试是 bug；不要加超时或重试让它通过”）。
   - `dev` 不再读 `CLAUDE.md`，不再探测 `scripts/stress.sh`，不再用 `bun test --rerun-each`。日志摘录用找到这次失败的那条命令自己的 `failed.match`，不认 bun 的输出格式。
   - area 的推导不做：`dev` 不再从 `packages/<name>/` 推 area，自动开出的 flaky 任务不带 area。
   - 本仓库把今天的规则文字和 `scripts/stress.sh` 命令搬进自己的 `.operad/`。
2. **A2：主 clone 快进之后跑 `prepare`**，不认 `bun.lock`，不加新键。`prepare` 的含义从“`dev` 建的每个检出”扩到“以及快进后的主 clone”，文档写明；每次合并都跑一遍。
3. **A4（已做，T-0388）：“serve 在跑旧代码”由内核的 code-watch 给出**（`packages/engine/src/loop/code-watch.ts` 已经记着 serve 加载了哪些文件）。`dev` 里的 `recordServeCode` 和 `serve-older` 一项删掉；内核的这一项对任何加载了的代码都成立，不认 `dev`、`@operad-io/` 前缀或 `packages/` 布局。它是已有 watch 多报的一项待处理，不是新的内核概念。
4. **B1、B2：默认值挪到 CLI 的 `init`**。engine 里没有任何插件名和动作名：默认插件列表、可选插件列表、插件名到包名的对应、`mcp.actions` 的默认，都归 CLI（发行版的默认）；engine 对缺省的 `mcp.actions` 是空。`operad init` 写出的 `config.json` 带上今天的默认。不改插件合约：哪些动作交给 lead 只由 owner 的配置决定，之后 enable 的插件的动作要手动加进 `mcp.actions`。
5. **边界由测试守住**（原待决 4，lead 定，owner 未逐条确认）：`packages/dev/src` 的非测试源码里不出现 `bun `、`bun.lock`、`scripts/`、`CLAUDE.md`、`packages/`；engine 的非测试源码里不出现任何随 operad 发行的插件名和 `<插件>:` 动作名。
6. **验收用一个非 Bun 的示例仓库**（原待决 5，lead 定，owner 未逐条确认）：测试里的一个小 fixture（没有 `package.json`、`scripts/`、`CLAUDE.md`，检查命令是 shell），用户文档里给同样的例子。

## 当初建议的形状（A5 仍未定；其余以上面的决定为准）

1. **A1**：flaky 的规则文本、复现命令、area 的推导都由仓库在 `dev.json` 里给；`dev` 自带的默认只留一句和工具无关的话（“失败后重跑通过的测试是 bug；不要加超时或重试让它通过”），没给复现命令时 brief 不写命令。日志摘录改用该命令自己的 `failed.match` 找失败行，不认 bun 的格式。本仓库把今天的文字和命令搬进 `.operad/dev.json`。
2. **A2**：主 clone 快进之后跑仓库配置的命令（复用 `prepare`，或新加一个只在主 clone 跑的 hook），不认 `bun.lock`。本仓库在配置里写 `bun install --frozen-lockfile`。
3. **A3**（已做，T-0272）：删掉 `linkWorkspacePackages`；需要的仓库写 `prepare`。本仓库已有 `bun install --frozen-lockfile`；anylut 和 radian-ios 不是 Bun workspace，不需要 `prepare`，普通检出就够。
4. **A4**：从 `dev` 里拿出去。候选：一个只给自举用的小插件；或由内核的 code-watch 提供（它已经知道 serve 加载了哪些代码）。
5. **A5**：排除列表由各 harness 自己声明或由仓库配置；分支名前缀和合并信息做成设置，默认值不变；`pool` 和默认 worker 留着，属于 `dev` 的合理依赖，只在文档里写明。
6. **B1、B2**：默认插件和默认 MCP 动作挪到 CLI 的 `init`（发行版的默认），engine 的默认是空。MCP 可用的动作更合适由插件自己声明“哪些动作可以交给 lead”，内核只合并。
7. **B3**：改成 `"cli"`；先查有没有读这个来源的代码和已有日志。
8. **B4**：TUI 只看 mark；`dev` 给完成的行都打上 mark 之后删掉这个兜底。

## 待决问题（未定）

1. A5：排除列表里的 `.radian-sandbox/` 由谁声明（harness 自己，还是仓库配置）；分支名前缀 `work/` 和合并信息要不要做成设置。它们不是 Bun 的约定，别的技术栈的仓库不会因此走不通，所以不在 2026-11-13 这一批里。
2. 已有的 home 如果 `config.json` 里没有 `mcp.actions`，决定 4 之后 lead 能做的动作变成空；升级说明里写一句，还是 `init` 之外再给一个补默认值的办法。

## 验收

一个不用 Bun、没有 `scripts/`、没有 `CLAUDE.md`、不是 `packages/*` 布局的仓库，只写 `.operad/dev.json` 就能走完 plan → task → 检查 → review → 合并；它的 flaky 任务 brief、合并后的主 clone、检查用的 checkout 里都不出现 bun 或 operad 仓库的约定。本仓库把这些约定搬进自己的配置之后，行为和今天一样（现有测试全过）。engine 的源码里没有任何插件的名字和动作名。
