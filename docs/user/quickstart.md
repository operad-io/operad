---
description: Start operad: create the home, start serve, open the client.
---

# Quickstart

`operad init` creates the home and checks the plugins. `operad serve` runs the loop for the home; `operad tui` opens the [terminal client](tui.md) and starts `serve` when none answers. `operad pending` lists what waits for a person and `operad list <type>` lists objects.

To have your coding agent write `.operad/dev.json` for a repository, use [the setup prompt](setup-prompt.md). A complete workflow on a repository (a plan, tasks, a person at the merge) is in [Running operad on operad](../dogfood.md). The settings are in [config.json](config.md), the commands in [the command line](cli.md), and what to do when something does not work in [troubleshooting](troubleshooting.md).

## A repository that is not JavaScript

A repository needs no `package.json`, no `scripts/` directory and no tool of any particular language. Its `.operad/dev.json` names the shell lines dev runs, and dev uses nothing else of the repository. This one is a small shell project: `sh check.sh` runs its tests, a failing test prints `FAIL: <name>`, and `sh check.sh <name>` runs one test.

<!-- schema: dev.schema.json -->
```json
{
  "name": "greeter",
  "prepare": ["sh prepare.sh"],
  "gate": {
    "commands": [
      {
        "run": "sh check.sh",
        "failed": {
          "match": "^FAIL: (.+)$",
          "rerun": "sh check.sh {name}",
          "stress": "sh check.sh --repeat 20 {name}",
          "rule": "docs/flaky-rule.md"
        }
      }
    ],
    "commandTimeoutSecs": 60
  }
}
```

`prepare` runs in every checkout dev makes and in the main clone after a merge moved it. `run` is the check. `failed.match` finds the failed test's name in the log (one capture group), and `failed.rerun` runs that test alone; a test that fails and then passes there is not a failed check but a flaky one. For a flaky test dev proposes a task whose brief has the `failed.stress` command and the text of the `failed.rule` file; without them the brief has no command and one sentence that does not name a tool. The settings are described in [dev](dev.md).
