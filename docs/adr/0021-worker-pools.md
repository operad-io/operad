# ADR 0021: Worker Pools

Status: accepted

## Background

A repository may use several kinds of worker at once, for example a `pi`, a `radian` and a `claude`, and a design or image flow may use only `codex`. Quotas belong to accounts, not repositories: a Claude or Codex subscription is shared by the whole machine, so two repositories that each run three Claude workers have no layer limiting the total. The per-model `concurrency` setting of a harness plugin limits one model against rate errors; it does not say how many `pi` runs the machine may host.

## Decisions

### D1: The pool is a plugin, not kernel

The plugin `@operad-io/pool` provides one step, `pool/agent`. Its parameters are the prompt, the working directory, a list of worker definitions (each with a harness, arguments and a share), the key under which shares are counted, and optionally a named worker. It picks a worker that has room, calls that worker's harness step (`claude/agent` and so on), returns the result unchanged, and adds which worker ran and whether it was a fallback. The kernel sees an ordinary plugin step call.

### D2: The home layer sets the total of each harness

The `pool` plugin section of `~/.operad/config.json` has `settings.harnesses`: the key is a harness plugin name, the value is the most runs of that harness at once on the whole machine, across all repositories and flows.

```json
"pool": {
  "module": "@operad-io/pool",
  "settings": { "harnesses": { "pi": 2, "claude": 1, "radian": 1, "codex": 1 } }
}
```

A harness not listed has no total limit. The home layer holds no model, argument or repository detail. Only runs through `pool/agent` count towards the total; a flow that calls a harness step directly does not, and the per-model `concurrency` of the harness still applies to it.

### D3: The repository layer says how each harness is used

`dev.json` has `workers`, keyed by worker name: `use`, `args` (the model and so on), `wallTimeSecs`, `stallSecs`, `count` (how many of this worker run at once in the repository: the repository share) and optionally `fallback`. One harness may have two workers in a repository, for example two `pi` workers with different models; together they count against that harness's total. `pools` groups workers by name; without `pools` there is one `default` pool holding every worker. A pool naming a worker that `workers` does not define is refused when `dev.json` loads, with the field path.

### D4: A worker starts only when both layers have room

A worker may start when its repository `count` has room and its harness's home total has room. Each pool counts its task places separately: a pool's limit is by default the sum of the `count` of its workers, and a pool may set its own `concurrency` to limit itself further. The repository's `concurrency` may still be set and is a total limit over all pools together. Without `workers`, the single `worker` form stays valid and means one pool with that one worker whose `count` is `concurrency`; it also counts towards its harness's home total. `worker` and `workers` together are refused at load.

### D5: Whoever is free takes the work

When a pool has room, the next ready task (in the order of plan priority and dependencies) goes to a free worker; when several are free, the first in the pool's listed order. When none is free the step waits and does not fail. The history says which pool it waits for and whether the repository share or the home total is the blocker.

### D6: A flow names its pool

The `dev` flow uses the repository's `default` pool. Another flow names a pool in its own step parameters, such as `design`. The caller resolves a pool name to worker definitions from the `.operad/dev.json` in the registered repository's main clone, not from the copy in a worktree (which may be an older branch version). `pool/agent` receives only resolved definitions and a counting key (`<repository>/<worker name>`), so the `pool` plugin knows neither repositories nor `dev.json`.

### D7: Rework goes to the worker that ran last

`dev` records the worker of each attempt. The work after a rework or a reject names the worker that ran the latest attempt, which is the fallback worker when a fallback ran it, because that worker holds the session to continue; if it is busy the step waits for it, and continues its session when it can. If that worker is no longer in the repository's `workers`, the free worker takes it and the history says the worker changed.

### D8: Fallback is configured in the repository layer

A worker may name `fallback: <another worker of the same repository>`. It triggers only when the harness reports that the model is unavailable or the quota is used up (`unavailable` and `usage_limit` of the model error) or when the harness process cannot start. A timeout (`wallTimeSecs`, `stallSecs`) does not trigger it: the worktree may hold half-finished work, which is for the lead to judge. The fallback takes the fallback worker's own `count` and its harness total, and waits when they are busy. A fallback chain is at most one step and has no cycle; both are checked at load.

### D9: A worker with no fallback waits

A pool whose workers name no fallback, such as an image pool with only `codex`, waits as the built-in `retry_wait` does when the quota is used up or the model is unavailable, and when waiting no longer works it turns into waiting for a person. It never switches to another worker, because another harness may lack the tool (an image tool) and would produce the result by other means (drawing with code).

### D10: The worker is recorded

The task object shows the worker of the latest attempt. The history line of a work step reads `work: claude` or `work: pi (fallback from claude)`. The metrics view splits cost, time and first-pass result by worker, so workers can be compared.

### D11: The reviewer is not in a pool

The reviewer keeps its own `reviewer` setting and its `fallback`. The per-model `concurrency` of a harness plugin stays and applies together with the two layers of the pool.
