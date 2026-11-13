# ADR 0012: Plugin Versioning, Checking, Enabling, Reloading and Dependencies

Status: accepted

## Background

Plugins are written by agents as often as by people, so a plugin needs a version, a check that a plugin is well formed, a way to turn it off, safe hot reload, and a way for third-party dependencies to arrive without weighing down the base install. The base install had to stay small: the Claude Agent SDK that `@operad-io/harness-claude` depends on carries a platform Claude Code binary in `optionalDependencies` (317 MB on one machine), and the root `package.json` `overrides` apply only inside this repository, not when someone else installs.

## Decisions

### D1: A versioned SDK and a check

The SDK carries a version number (`operadPlugin: 1`). `operad plugin check <path>` validates a plugin declaration without starting it.

### D2: Plugins can be enabled and disabled

`plugins.<name>.enabled` in `config.json` (boolean, default `true`). `operad init` enables `shell`, `radian`, `chat` and `dev` by default.

- A disabled plugin is not loaded: its commands, actions, views and default rules do not appear. Objects and history already stored are left alone and are visible again after re-enabling.
- A plugin that depends on it (`requires`) is not loaded either, and the reason is said.
- A plugin whose steps are still running in some run cannot be disabled; the command names those runs.
- The command line has `operad plugin list` (name, version, enabled or not), `operad plugin enable <name>` and `operad plugin disable <name>`. They take effect at the next `operad` command or at the next `serve` reload.

### D3: The boundary of hot reload

- A running step uses the code it started with, to its end. The next step of a run uses the code on disk.
- `serve` reloads when its own code, the code of a loaded plugin or the schema of a settings file changes: after a short quiet time it stops as `operad serve stop` does, then restarts in place.
- A run process compares the code between two steps; if it changed, it exits cleanly, `serve` starts a new process that continues from the next step, and the history keeps one line for the handover.
- A change to code that cannot be loaded (a syntax error, an invalid schema) does not bring down `serve` or a run process. `serve` keeps using the old code. A run process starts no new step (the next step must read the code on disk) and waits in place until the file loads or is changed back. The problem is shown where a user looks at load problems today, and the reload happens when the file loads again.
- A changed settings file is read again at the next use.

### D4: A plugin with third-party npm dependencies is not in the base install; enabling it installs it into the operad home

`@operad-io/cli` depends only on packages that have no third-party dependencies; a plugin such as `claude` is not its dependency. When a user enables such a plugin, operad installs the plugin package and its dependencies into one place under the operad home (a Bun project), skipping `optionalDependencies`, and the plugin loads from there. When it is not installed, `operad plugin check` and any command that uses it say how to install it. Development inside the repository uses the workspace as before and does not go through this.
