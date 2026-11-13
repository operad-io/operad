# operad-worker-pool：一个仓库用几种 worker，home 定每种 harness 的总数，仓库定怎么用

- 状态：已定，待做
- 涉及：`operad.md` 决定 12–15（kernel 边界）、`operad-harness.md`、`operad-harness-pi.md`、`operad-harness-claude.md`
- 新的用户可见词：**pool**、**worker**（owner 已批准）

## 背景

`dev.json` 现在只有一个 `worker`（`use` 加 `args`）和一个 `concurrency`。operad 设 `concurrency: 3`，三个槽位跑同一个 harness。owner 想让一个仓库同时用几种 worker，比如 operad 用一个 pi、一个 radian、一个 claude；将来 tkrs 的出图或设计 flow 指定只用 codex。

额度按账号算，不按仓库算：Claude Max、Codex、opencode-go 都是全机共用。两个仓库各开三个 claude 并发时，没有任何一层限住总数。`harness-pi`、`harness-radian`、`harness-claude` 已经有按模型的 `settings.concurrency`（manual「Limiting runs of one model」），那是防 429 的按模型限流，不是"这台机器同时跑几个 pi"。

## 决定（已定）

1. **pool 是一个插件，不进 kernel。** 新插件 `@operad-io/pool`，提供一个 step `pool/agent`：参数是 prompt、cwd、一组 worker 定义（每个带 harness、参数、份额）、份额的计数键、可选的指定 worker。它挑一个有空的 worker，调那个 worker 的 harness step（`harness-claude/agent` 等），把结果原样交回，并在结果里加上用的是哪个 worker、是不是 fallback。kernel 只看到一次普通的插件 step 调用。

2. **home 层只定每种 harness 的总并发。** 写在 `~/.operad/config.json` 里 `pool` 插件的 `settings.harnesses`，键是 harness 插件名，值是整台机器上同时跑的上限，跨所有仓库、所有 flow：

   ```json
   "pool": {
     "module": "@operad-io/pool",
     "settings": {
       "harnesses": { "harness-pi": 2, "harness-claude": 1, "harness-radian": 1, "harness-codex": 1 }
     }
   }
   ```

   没列出的 harness 不限总数。home 层不写模型、参数或任何仓库相关的东西。只有经过 `pool/agent` 的运行计入这个总数；直接调 harness step 的 flow（如 `harness-pi:prompt`）不计入，按模型的 `concurrency` 仍然对它们生效。

3. **仓库层定这个仓库怎么用每种 harness。** `dev.json` 加 `workers`，键是 worker 名，值是这个仓库里的用法：

   ```json
   "workers": {
     "claude": { "use": "harness-claude/agent", "args": ["--model", "sonnet"], "count": 1, "fallback": "pi" },
     "pi":     { "use": "harness-pi/agent", "args": ["--model", "opencode-go/deepseek-v4.1-flash"], "count": 1, "wallTimeSecs": 7200 },
     "radian": { "use": "harness-radian/agent", "args": [], "count": 1 },
     "codex":  { "use": "harness-codex/agent", "args": [], "count": 1 }
   },
   "pools": {
     "default": ["claude", "pi", "radian"],
     "design":  ["codex"]
   }
   ```

   `use`、`args`（模型等）、`wallTimeSecs`、`stallSecs` 是这个仓库对这个 harness 的具体设置，和现在 `worker` 里的字段一样。`count` 是这个仓库里这个 worker 同时跑几个，即仓库份额。同一种 harness 可以在一个仓库里定义两个 worker，比如 `pi-flash` 和 `pi-pro` 用不同模型，它们一起计入 home 层这种 harness 的总数。`pools` 把 worker 分组；没写 `pools` 时只有一个 `default`，包含全部 worker。pool 里写了 `workers` 里没有的名字，`dev.json` 加载时拒绝，报出字段路径。

4. **一个 worker 能不能起，要同时满足两层。** 仓库里这个 worker 的 `count` 有空，且 home 层它的 harness 总数有空。每个 pool 的任务名额各算各的：一个 pool 的上限默认是它里面各 worker 的 `count` 之和，`pools` 里一个 pool 可以另写 `concurrency` 把它限得更小；仓库的 `concurrency` 仍可写，是所有 pool 合起来的总上限（2026-11-12 owner 定，改原来的“仓库的总并发是 `default` pool 里 `count` 之和”，起因是 tkrs 的出图任务会占掉写代码任务的名额）。没写 `workers` 时，旧的 `worker` 写法继续有效，等于一个只有这一个 worker、`count` 为 `concurrency` 的 pool，同样计入 home 层它的 harness 总数。`worker` 和 `workers` 同时出现时拒绝加载。

5. **默认谁空谁领。** 一个 pool 有空位时，下一个 ready 任务（按现有的 plan 优先级和依赖排序）交给有空的 worker；几个都有空时，按 pool 里列出的顺序取第一个。都没空时 step 等待，不报错；等待在 history 里写明在等哪个 pool，以及卡在仓库份额还是 home 总数。

6. **flow 指定 pool。** `dev` flow 用仓库的 `default` pool。别的 flow（比如 tkrs 的设计或出图 flow）在自己的 step 参数里写 pool 名，例如 `design`。pool 名到 worker 定义的解析由调用方插件做，读注册仓库的主 clone 里的 `.operad/dev.json`，不读 worktree 里那份（worktree 里的可能是分支上的旧版本）。`pool/agent` 只收解析好的 worker 定义和计数键（`<仓库>/<worker 名>`），所以 `pool` 插件不需要认识仓库或 `dev.json`。

7. **返工交给原 worker。** `dev` 在每次 attempt 上记下用的 worker 名。rework 和 reject 后的那次 work 指定原 worker；原 worker 忙就等它，能续会话就续。原 worker 已经不在仓库的 `workers` 里时，回到谁空谁领，history 写明换了人。

8. **可配 fallback，在仓库层。** 仓库的 worker 可以写 `fallback: <同一仓库的另一个 worker 名>`。fallback 只在这几种情况触发：harness 报模型不可用或额度用完（现有的 `modelError` 的 `unavailable` 和 `usage_limit`），或者 harness 进程起不来。超时（`wallTimeSecs`、`stallSecs`）不触发 fallback：worktree 里可能已经有半成品，交给 lead 判断。fallback 占用 fallback worker 自己的 `count` 和它的 harness 总数；它也忙就等。fallback 链最多走一步，不能成环，加载时检查。

9. **记录 worker。** 任务对象显示最近一次 attempt 的 worker；history 的 work 行写 `work: claude` 或 `work: pi (fallback from claude)`；metrics 按 worker 分开统计花费、耗时、首轮通过率，供以后比较 pi、radian、claude。

10. reviewer 第一版不进 pool，保留现有的 `reviewer` 和它的 `fallback`。harness 插件自己的按模型 `concurrency` 保留，和 pool 的两层限制同时生效。
10. **一个 pool 可以不设 fallback，额度用完就等**（2026-11-12 owner 定，来自 tkrs 出图的需求）。fallback 本来就是每个 worker 自己选的（决定 8）；只有不写 fallback 的 worker 的 pool（比如 tkrs 的 `image`，只有 codex）在额度用完或模型不可用时照今天的 `retry_wait` 等，等不下去转为等人，绝不换成别的 worker：别的 harness 没有出图工具，会改用代码画图。


## 待决问题（未定）

1. reviewer 以后是否也从 pool 取，以及 reviewer 是否必须和 worker 不是同一种。
2. 一个任务能不能在 brief 里指定 worker（`task add --worker`）。这次定的是按 flow 指定 pool，任务级指定未定。
3. 非 `dev` 的 flow（如 tkrs 的设计 flow）的 pool 定义放在 `dev.json` 还是仓库里另一份文件；第一版放 `dev.json`。

## 验收

operad 仓库配 `workers` 为 claude、pi、radian 各 `count: 1` 后，三个 ready 任务分别跑在三个 worker 上，`operad list task` 和 history 能看到各自的 worker；home 层 `harness-claude: 1` 时，operad 和 operad-ios 的 claude 任务排队而不是同时跑；一个仓库里两个用不同模型的 pi worker 合起来不超过 home 的 `harness-pi` 总数；一个 reject 后的任务回到原 worker；模拟 claude `usage_limit` 时，任务转到 `pi` 跑完，history 写明 fallback；旧的单 `worker` 写法的仓库行为不变。manual 写全 `pool` 插件的 `settings.harnesses` 和 `dev.json` 的 `workers`、`pools` 字段（类型、默认值、上限、生效时机），drift 测试读同一份字段表。
