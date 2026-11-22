# Radian benchmarks

These are radian's evaluation tools, copied from radian's `benchmarks/`
directory. They measure the radian binary; they are not part of operad's Bun
workspace, no package depends on them, and `bun test` and `scripts/verify.sh`
do not run them. The files are Python and shell so people can run them directly;
there is no build step.

Paths such as `crates/...`, `scripts/...` and `docs/...` inside these files
name files in the radian checkout. The tools never guess that checkout from
where this directory sits: name it with an environment variable, and a missing
one is one clear error line.

## What each tool is

| Path | What it does |
|---|---|
| `terminal-bench/` | The Terminal-Bench (Harbor) adapter. `radian_agent.py` runs the radian binary in task containers; `metrics.py` reports on finished Harbor jobs; `tests/` holds the stdlib-only tests; `ab/` holds the side-by-side A/B scripts. |
| `repo-tasks/` | A fixed set of real radian repository tasks, with `run.sh` (one agent run), `check.sh` (crate-scoped fmt, clippy and nextest), `eval.sh` (one arm end to end), `report.py`, `leak.py` and their tests. |
| `journal_metrics.py` | The fixed column definitions read from radian session journals and pi session JSONL. `terminal-bench/metrics.py` and `repo-tasks/report.py` both use it. |
| `edit-check-timing.sh` | Measures incremental `cargo check` time after a trivial edit. |
| `perf-baseline.md` | The recorded performance baseline and the methods behind it. |
| `terminal-bench/MUTATIONS.md`, `repo-tasks/MUTATIONS.md` | The tools' own mutation records from radian. |

Some files use different names from when they lived in radian: the terminal-bench
scripts are now invoked from this directory, so their usage lines and READMEs
spell `benchmarks/radian/...`.

## Radian checkout

`repo-tasks` takes the radian checkout in `REPO_TASKS_SOURCE`:

```sh
REPO_TASKS_SOURCE=/path/to/radian bash benchmarks/radian/repo-tasks/eval.sh full 1
```

`repo-tasks/run.sh`, `report.py` and `leak.py` read the same variable. Without
it, a command that needs the checkout exits with one line:
`no radian checkout; set REPO_TASKS_SOURCE`.

`edit-check-timing.sh` and `terminal-bench/build-static.sh` take it in
`RADIAN_CHECKOUT`:

```sh
RADIAN_CHECKOUT=/path/to/radian bash benchmarks/radian/edit-check-timing.sh
RADIAN_CHECKOUT=/path/to/radian bash benchmarks/radian/terminal-bench/build-static.sh
```

Without it they exit with one line naming `RADIAN_CHECKOUT`.

The terminal-bench adapter does not need a radian checkout to read finished
jobs; it runs the binary named by `RADIAN_BENCH_BINARY` (and the A/B scripts use
the binaries under `$HOME/tb2/bin`).

## Self-tests

The terminal-bench self-test runs the metrics tests on the checked-in fixture
jobs. It needs only Python's standard library, no Harbor, model or Docker:

```sh
python3 benchmarks/radian/terminal-bench/metrics.py --self-test
```

The repo-tasks tests drive the runner, checks, report and leak scanner with stub
agents and cargo; no model is called:

```sh
python3 benchmarks/radian/repo-tasks/tests/test_repo_tasks.py
python3 benchmarks/radian/repo-tasks/report.py --self-test   # the same tests
```

The agent tests under `terminal-bench/tests/` that import Harbor need the pinned
Harbor installation; the terminal-bench README names those commands.
