# ADR 0012: Plugin Versioning, Checking, Enabling, Reloading and Dependencies

Status: accepted

## Background

Plugins are written by agents as often as by people, so a plugin needs a version, a check that a plugin is well formed, a way to turn it off, safe hot reload, and a way for third-party dependencies to arrive without weighing down the base install. The base install had to stay small: the Claude Agent SDK that `@operad-io/harness-claude` depends on carries a platform Claude Code binary in `optionalDependencies` (317 MB on one machine), and the root `package.json` `overrides` apply only inside this repository, not when someone else installs.

## Decisions

### D1: A versioned SDK and a check

The SDK carries a version number (`operadPlugin: 1`). `operad plugin check <path>` validates a plugin declaration without starting it.

### D2: Plugins can be enabled and disabled

`plugins.<name>.enabled` in `config.json` (boolean, default `true`). `operad init` writes `chat`, `bot` and `memory` into a new home, and a harness plugin for each agent command it finds on `PATH`: `radian`, `claude` and `pi`, in that order. A new home leaves `shell`, `dev` and `pool` off; a person turns them on when a repository's work needs them. When it finds no agent command, it enables `pi` and installs operad's own pi into the home, so a first run never needs an agent installed beforehand (ADR 0022 D6, ADR 0023 D9). `codex` is not part of this choice: it needs Codex's own app-server and stays off until `operad plugin enable codex`. A home that already has a `config.json` is not rewritten, so an upgrade keeps the plugins and switches that home already had.

A repository whose `.operad/dev.json` names neither `worker` nor `workers`, and leaves `reviewer.use` out, uses the first enabled harness plugin in `config.json` in the fixed order `radian`, `claude`, `pi`, `codex`. With no enabled harness it uses `radian/agent`.

- A disabled plugin is not loaded: its commands, actions, views and default rules do not appear. Objects and history already stored are left alone and are visible again after re-enabling.
- A plugin that depends on it (`requires`) is not loaded either, and the reason is said.
- A plugin whose steps are still running in some run cannot be disabled; the command names those runs.
- Enabling a shipped plugin also enables the shipped plugins it needs, when they are off or not yet in `config.json`: `dev` needs `pool` and `shell`. The needed plugins are enabled first and each one turned on is named (`operad plugin enable dev` prints `pool: enabled`, `shell: enabled`, `dev: enabled`); one already on prints nothing. The `serve` HTTP switch does the same through the same code. This is a one-time convenience, not a link: disabling a plugin turns off only that plugin, and a plugin enabled this way stays off after a later disable of it, even while `dev` is on (the `pool` standing item in `operad pending` then says what is missing).
- The command line has `operad plugin list` (name, version, enabled or not), `operad plugin enable <name>` and `operad plugin disable <name>`. They take effect at the next `operad` command or at the next `serve` reload.

### D3: The boundary of hot reload

- A running step uses the code it started with, to its end. The next step of a run uses the code on disk.
- `serve` reloads when its own code, the code of a loaded plugin or the schema of a settings file changes: after a short quiet time it stops as `operad serve stop` does, then restarts in place.
- A run process compares the code between two steps; if it changed, it exits cleanly, `serve` starts a new process that continues from the next step, and the history keeps one line for the handover.
- A change to code that cannot be loaded (a syntax error, an invalid schema) does not bring down `serve` or a run process. `serve` keeps using the old code. A run process starts no new step (the next step must read the code on disk) and waits in place until the file loads or is changed back. The problem is shown where a user looks at load problems today, and the reload happens when the file loads again.
- A changed settings file is read again at the next use.

### D4: A plugin with third-party npm dependencies is not in the base install; enabling it installs it into the operad home

`@operad-io/cli` depends only on packages that have no third-party dependencies; a plugin such as `claude` is not its dependency. When a user enables such a plugin, operad installs the plugin package and its dependencies into one place under the operad home (a Bun project), skipping `optionalDependencies`, and the plugin loads from there. When it is not installed, `operad plugin check` and any command that uses it say how to install it. Development inside the repository uses the workspace as before and does not go through this.

A plugin whose third-party dependency is an optional peer, such as `pi`'s pi library, stays in the base install because that peer is absent from it; enabling the plugin installs the peer into the home when the machine has no copy of its own (ADR 0023 D9). The install reports each line it prints while it runs: `operad init` and `operad plugin enable` print them, and `GET /v1/plugins` carries the latest line on the plugin being installed, including a plugin the file does not name yet, so a client can show that the install is moving. A failed install names the reason and leaves the home ready for another try, so a network failure says so and running the enable or `operad init` again retries the same install.

### D5: A plugin from npm is added by package name, turned off

`operad plugin add <package>[@version]` installs a plugin from npm into the home's Bun project. It names an exact version, or the latest when none is given. The install runs with install scripts off, so it runs none of the package's own scripts; a package whose entry needs its install script cannot be added, and the refusal says so.

Before the plugin is turned on, operad checks it as `operad plugin check` does and adds it to `config.json` turned off, keyed by the name the plugin declares. Enabling it is the existing `operad plugin enable`, so a person sees what they enable. The command prints the package, its version, the plugin's declared name and version, and how to enable it. It refuses a name that is not a valid npm package name, a version that is not exact, a package whose default export is not a plugin declaration, and a declared name that a configured plugin already uses, each naming the reason.

`POST /v1/plugins` with `{ "install": "<package>[@version]", "confirmed": true }` does the same and answers the new entry, turned off.
