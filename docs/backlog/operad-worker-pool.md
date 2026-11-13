# operad-worker-pool：一个仓库用几种 worker，home 定每种 harness 的总数，仓库定怎么用

- 状态：决定已落地并进了 ADR；下面只留未定的问题和验收
- 涉及 ADR：0021
- 涉及：`operad-harness.md`、`operad-harness-pi.md`、`operad-harness-claude.md`
- 新的用户可见词：**pool**、**worker**（owner 已批准）

## 待决问题（未定）

1. reviewer 以后是否也从 pool 取，以及 reviewer 是否必须和 worker 不是同一种。
2. 一个任务能不能在 brief 里指定 worker（`task add --worker`）。这次定的是按 flow 指定 pool，任务级指定未定。
3. 非 `dev` 的 flow（如 tkrs 的设计 flow）的 pool 定义放在 `dev.json` 还是仓库里另一份文件；第一版放 `dev.json`。

## 验收

operad 仓库配 `workers` 为 claude、pi、radian 各 `count: 1` 后，三个 ready 任务分别跑在三个 worker 上，`operad list task` 和 history 能看到各自的 worker；home 层 `harness-claude: 1` 时，operad 和 operad-ios 的 claude 任务排队而不是同时跑；一个仓库里两个用不同模型的 pi worker 合起来不超过 home 的 `harness-pi` 总数；一个 reject 后的任务回到原 worker；模拟 claude `usage_limit` 时，任务转到 `pi` 跑完，history 写明 fallback；旧的单 `worker` 写法的仓库行为不变。manual 写全 `pool` 插件的 `settings.harnesses` 和 `dev.json` 的 `workers`、`pools` 字段（类型、默认值、上限、生效时机），drift 测试读同一份字段表。
