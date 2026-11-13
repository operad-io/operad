# operad

An open orchestration layer for coding agents: a graph engine that runs any
harness (radian, Claude Code, Codex, pi, …) through verified flows, with
channels to reach a human and plugins an agent can write on the spot.

In development. The direction and the open questions are in `docs/backlog/`.

The user manual (the commands and `config.json` keys) starts at
`docs/user/index.md`; plugin authors start at `docs/plugins/index.md`; a complete
workflow is in `docs/dogfood.md`.

When the worker adds no commit, the task waits with `work did nothing` if the branch has nothing beyond main or its latest commit already passed verify. If the branch already holds commits not on main and its latest commit has not passed verify (an earlier run stopped before verify ended), the task does not wait: history says `the branch already has unchecked work; checking it` and the task goes on to verify.
