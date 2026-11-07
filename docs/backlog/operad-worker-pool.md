# operad-worker-pool：一个仓库用几种 worker，home 定总数，仓库定份额

- 状态：已定，待做
- 涉及：`operad.md` 决定 12–15（kernel 边界）、`operad-harness.md`、`operad-harness-pi.md`、`operad-harness-claude.md`
- 新的用户可见词：**pool**、**worker**（owner 已批准）

## 背景

`dev.json` 现在只有一个 `worker`（`use` 加 `args`）和一个 `concurrency`。operad 设 `concurrency: 3`，三个槽位跑同一个 harness。owner 想让一个仓库同时用几种 worker，比如 operad 用一个 pi、一个 radian、一个 claude；将来 tkrs 的出图或设计 flow 指定只用 codex。

额度按账号算，不按仓库算：Claude Max、Codex、opencode-go 都是全机共用。两个仓库各开三个 claude 并发时，没有任何一层限住总数。`harness-pi`、`harness-radian`、`harness-claude` 已经有按模型的 `settings.concurrency`（manual「Limiting runs of one model」），那是 429 保护，不是"这台机器上有几个 claude worker"。

## 决定（已定）

1. **pool 是一个插件，不进 kernel。** 新插件 `@operad-io/pool`，提供一个 step `pool/agent`：参数是 prompt、cwd、一组可用 worker 和各自的份额、份额的计数键、可选的指定 worker。它挑一个有空的 worker，调那个 worker 的 harness step（`harness-claude/agent` 等），把结果原样交回，并在结果里加上用的是哪个 worker、是不是 fallback。kernel 只看到一次普通的插件 step 调用。

2. **home 层定义 worker 和每个 worker 的总数。** 写在 `~/.operad/config.json` 里 `pool` 插件的 `settings.workers`，键是 worker 名：

   ```json
   "pool": {
     "module": "@operad-io/pool",
     "settings": {
       "workers": {
         "claude": { "use": "harness-claude/agent", "args": ["--model", "sonnet"], "max": 1, "fallback": "pi" },
         "pi":     { "use": "harness-pi/agent", "args": ["--model", "opencode-go/deepseek-v4.1-flash"], "max": 2 },
         "radian": { "use": "harness-radian/agent", "args": [], "max": 1 },
         "codex":  { "use": "harness-codex/agent", "args": [], "max": 1 }
       }
     }
   }
   ```

   `max` 是这个 worker 在整台机器上同时跑的上限，跨所有仓库、所有 flow，作用和现在的 max concurrency 一样。`wallTimeSecs`、`stallSecs` 也可以写在 worker 上，作为它的默认值。

3. **仓库层定自己的 pool 和份额。** `dev.json` 加 `pools`：键是 pool 名，值是 worker 名到份额：

   ```json
   "pools": {
     "default": { "claude": 1, "pi": 1, "radian": 1 },
     "design":  { "codex": 1 }
   }
   ```

   份额不能超过 home 的 `max`；一个 worker 实际能不能起，要同时满足仓库份额和 home 总数。只能用 home 里定义过的 worker 名，写了没定义的名字，`dev.json` 加载时就拒绝，报出字段路径。仓库的总并发是 `default` pool 份额之和；`concurrency` 仍可写，作为额外的上限。没写 `pools` 时，旧的 `worker` 写法继续有效，等于一个只有这一个 worker、份额为 `concurrency` 的 pool，不受 home 总数约束。两种写法同时出现时拒绝加载。

4. **默认谁空谁领。** 一个 pool 有空位时，下一个 ready 任务（按现有的 plan 优先级和依赖排序）交给有空的 worker；几个都有空时，按仓库 pool 里列出的顺序取第一个。都没空时 step 等待，不报错；等待在 history 里写明在等哪个 pool。

5. **flow 指定 pool。** `dev` flow 用仓库的 `default` pool。别的 flow（比如 tkrs 的设计或出图 flow）在自己的 step 参数里写 pool 名，例如 `design`。pool 名到份额的解析由调用方插件做，`pool/agent` 只收解析好的份额和计数键（`<仓库>/<pool 名>`），所以 `pool` 插件不需要认识仓库或 `dev.json`。

6. **返工交给原 worker。** `dev` 在每次 attempt 上记下用的 worker 名。rework 和 reject 后的那次 work 指定原 worker；原 worker 忙就等它，能续会话就续。原 worker 已经不在仓库 pool 或 home 配置里时，回到谁空谁领，history 写明换了人。

7. **可配 fallback。** home 层的 worker 可以写 `fallback: <另一个 worker 名>`。fallback 只在这几种情况触发：harness 报模型不可用或额度用完（现有的 `modelError` 的 `unavailable` 和 `usage_limit`），或者 harness 进程起不来。超时（`wallTimeSecs`、`stallSecs`）不触发 fallback：worktree 里可能已经有半成品，交给 lead 判断。fallback 占用的是 fallback worker 自己的 `max`；它也忙就等。fallback 链最多走一步，不能成环，加载时检查。

8. **记录 worker。** 任务对象显示最近一次 attempt 的 worker；history 的 work 行写 `work: claude` 或 `work: pi (fallback from claude)`；metrics 按 worker 分开统计花费、耗时、首轮通过率，供以后比较 pi、radian、claude。

9. reviewer 第一版不进 pool，保留现有的 `reviewer` 和它的 `fallback`。harness 插件自己的按模型 `concurrency` 保留，和 pool 的 `max` 同时生效。

## 待决问题（未定）

1. reviewer 以后是否也从 pool 取，以及 reviewer 是否必须和 worker 不是同一种。
2. 一个任务能不能在 brief 里指定 worker（`task add --worker`）。owner 这次选了按 flow 指定 pool，任务级指定未定。

## 验收

operad 仓库配 `default: { claude: 1, pi: 1, radian: 1 }` 后，三个 ready 任务分别跑在三个 worker 上，`operad list task` 和 history 能看到各自的 worker；operad-ios 同时也用 `claude: 1` 时，home `max: 1` 让两个仓库的 claude 任务排队而不是同时跑；一个 reject 后的任务回到原 worker；把 claude 的模型故意写错（或模拟 `usage_limit`）时，任务转到 `pi` 跑完，history 写明 fallback；旧的单 `worker` 写法的仓库行为不变。manual 写全 `pool` 插件 settings 和 `dev.json` 的 `pools` 字段（类型、默认值、上限、生效时机），drift 测试读同一份字段表。
