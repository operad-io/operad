# ADR 0012: Plugin Versioning, Checking, Enabling, Reloading and Dependencies

Status: accepted

## Background

Plugins are written by agents as often as by people, so a plugin needs a version, a check that a plugin is well formed, a way to turn it off, safe hot reload, and a way for third-party dependencies to arrive without weighing down the base install. The base install had to stay small: the Claude Agent SDK that `@operad-io/harness-claude` depends on carries a platform Claude Code binary in `optionalDependencies` (317 MB on one machine), and the root `package.json` `overrides` apply only inside this repository, not when someone else installs.

## Decisions

### D1: A versioned SDK and a check

The SDK carries a version number (`operadPlugin: 1`). `operad plugin check <path>` validates a plugin declaration without starting it.

### D2: Plugins can be enabled and disabled

`plugins.<name>.enabled` in `config.json` (boolean, default `true`). `operad init` turns every shipped plugin on in a new home, because a person should not have to learn a plugin's name before they can find what it does: `chat`, `bot`, `memory`, `cron`, `shell`, `pool`, `dev`, `telegram`, `terminal`, and the harnesses `pi`, `codex` and `radian`, each plugin listed after those it needs. The harnesses whose agent command is on `PATH` come first, in the order `claude`, `pi`, `radian`, then the others. One shipped plugin is not on in every new home: `claude` is on only when `claude` is on `PATH`, because turning it on downloads its package (D4) and without its agent the download serves nothing. `terminal` also has a package to download, and is on all the same: no start waits for it (D4, ADR 0040 D1). When no `claude`, `pi` or `radian` command is found, operad installs its own pi into the home, so a first run never needs an agent installed beforehand (ADR 0022 D6, ADR 0023 D9). A home that already has a `config.json` is not rewritten, so an upgrade keeps the plugins and switches that home already had; the shipped plugins it does not name are listed as off.

A plugin that is on and not set up is quiet: it loads, adds no pending item of its own and fails no start. `telegram` without a token starts nothing (ADR 0033 D4), `dev` with no repository and `pool` with no workers have nothing to do, `terminal` whose package is not installed yet runs nothing (D4), and a harness whose agent is not on the machine is not offered as an agent (ADR 0022 D14). A harness whose agent is signed out or older than its floor is not set up either: no check fails for it (ADR 0022 D14). One thing may still wait for such an agent: a bot whose agent declares a login step and says it is signed out has the bot's login item (ADR 0030 D14).

`operad init` exits `0` when plugins are only not set up. It exits non-zero for a real failure: a `config.json` that is not valid, an enabled plugin that does not load (a module that cannot be imported, a declaration that is refused, or a plugin it requires being off), or a failed check. A client may therefore treat any non-zero exit as a failed `init`.

A repository whose `.operad/dev.json` names neither `worker` nor `workers`, and leaves `reviewer.use` out, uses the first enabled harness plugin in `config.json`, in the fixed order `radian`, `claude`, `pi`, `codex`, whose agent is on the machine: its command is on `PATH` or set in its settings, or, for `pi`, operad's own pi is in the home. With no such harness it uses the first enabled one in that order, and with no enabled harness `radian/agent`.

- A disabled plugin is not loaded: its commands, actions, views and default rules do not appear. Objects and history already stored are left alone and are visible again after re-enabling.
- A plugin that depends on it (`requires`) is not loaded either, and the reason is said.
- A disabled plugin's setup guide is still readable, so a bot can start Setup for a plugin that is off; its check is not run and it reports one missing item, `enable` (ADR 0010 D7).
- A plugin whose steps are still running in some run cannot be disabled; the command names those runs.
- Enabling a shipped plugin also enables the shipped plugins it needs, when they are off or not yet in `config.json`: `dev` needs `pool` and `shell`. The needed plugins are enabled first and each one turned on is named (`operad plugin enable dev` prints `pool: enabled`, `shell: enabled`, `dev: enabled`); one already on prints nothing. The `serve` HTTP switch does the same through the same code. This is a one-time convenience, not a link: disabling a plugin turns off only that plugin, and a plugin enabled this way stays off once it is disabled, even while `dev` is on (the `pool` standing item in `operad pending` then says what is missing).
- `operad doctor` is the one read-only check of a home: it changes nothing in it. It prints one line per fact: the home and `config.json`, each enabled plugin (loaded, or why not), each agent (its version and whether it is signed in, or that it is not set up, which is a problem only when no agent is; an agent on the machine whose check reports something missing, such as a login or a newer version, cannot be used and is a problem), whether `serve` answers, whether the test host (`dev.testHost`) is reachable when one is set, and each setup problem `operad pending` reports. A problem line ends with the next command to type. For an agent whose check reports it as not set up that is never `operad init`, which would only repeat the reason: it is the command the reason quotes, with the agent's own sign-in replaced by `operad bot:login <bot>` where operad can log in to the agent, and with no command quoted it says to set the agent up and run `operad doctor`. And the exit code is `1` when there is a problem. `--json` gives the same facts. `doctor` is a verb the kernel owns, so a plugin cannot take it as a short command.
- The command line has `operad plugin list` (name, version, enabled or not, and the description), `operad plugin enable <name>` and `operad plugin disable <name>`. They take effect at the next `operad` command or at the next `serve` reload.
- `GET /v1/plugins` lists the configured plugins and then, off, each shipped optional plugin `config.json` does not name, with the shipped version, so a client can turn any of them on. Such a row has no field that sets it apart: turning it on is the same request. `operad plugin list` lists only the configured ones.
- A plugin's description is the `description` of its `package.json`, one line saying what the plugin gives the person; a plugin without one has none. A shipped plugin installed on enable (D4) is described before its package is there, in the same words.

### D3: The boundary of hot reload

- A running step uses the code it started with, to its end. The next step of a run uses the code on disk.
- `serve` reloads when its own code, the code of a loaded plugin, a flow file of the home (ADR 0003 D3) or the schema of a settings file changes: after a short quiet time it stops as `operad serve stop` does, then restarts in place.
- A run process compares the code between two steps; if it changed, it exits cleanly, `serve` starts a new process that continues from the next step, and the history keeps one line for the handover.
- A change to code that cannot be loaded (a syntax error, an invalid schema) does not bring down `serve` or a run process. `serve` keeps using the old code. A run process starts no new step (the next step must read the code on disk) and waits in place until the file loads or is changed back. The problem is shown where a user looks at load problems today, and the reload happens when the file loads again.
- A flow file of the home that does not load is refused with its reason and is not a load problem in this sense: the reload happens and the other flows load.
- A changed settings file is read again at the next use.

### D4: A plugin with third-party npm dependencies is not in the base install; enabling it installs it into the operad home

`@operad-io/cli` depends only on packages that have no third-party dependencies; a plugin such as `claude` is not its dependency. When a user enables such a plugin, operad installs the plugin package and its dependencies into one place under the operad home (a Bun project), skipping `optionalDependencies`, and the plugin loads from there. When it is not installed, `operad plugin check` and any command that uses it say how to install it. `terminal` is the exception, so that a new home can have it on without a start waiting for a download: `operad init` does not install it, `operad serve` installs it in the background once it is serving and reloads to load it, and until then the distribution loads in its place a plugin of its own that is only not set up, with the missing item `install` and a setup guide (ADR 0040 D1). The engine is told which module stands in for which package and names neither. Development inside the repository uses the workspace as before and does not go through this.

A plugin whose third-party dependency is an optional peer, such as `pi`'s pi library, stays in the base install because that peer is absent from it; enabling the plugin installs the peer into the home when the machine has no copy of its own (ADR 0023 D9). The install reports each line it prints while it runs: `operad init` and `operad plugin enable` print them, and `GET /v1/plugins` carries the latest line on the plugin being installed, including a plugin the file does not name yet, so a client can show that the install is moving. A package whose installed version is not the one operad wants counts as not installed, so a failed upgrade is tried again. A failed install names the reason and leaves the home ready for another try, so a network failure says so and running the enable or `operad init` again retries the same install.

### D5: A plugin from npm is added by package name, turned off

`operad plugin add <package>[@version]` installs a plugin from npm into the home's Bun project. It names an exact version, or the latest when none is given. The install runs with install scripts off, so it runs none of the package's own scripts; a package whose entry needs its install script cannot be added, and the refusal says so.

Before the plugin is turned on, operad checks it as `operad plugin check` does and adds it to `config.json` turned off, keyed by the name the plugin declares. Enabling it is the existing `operad plugin enable`, so a person sees what they enable. The command prints the package, its version, the plugin's declared name and version, and how to enable it. It refuses a name that is not a valid npm package name, a version that is not exact, a package whose default export is not a plugin declaration, and a declared name that a configured plugin already uses, each naming the reason.

`POST /v1/plugins` with `{ "install": "<package>[@version]", "confirmed": true }` does the same and answers the new entry, turned off.
