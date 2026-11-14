# ADR 0034: The Boundary Between operad and a Project's Way of Working

Status: accepted

## Background

operad and `dev` are an open framework: a project with another technology stack uses them without taking over operad's own way of developing itself. That way appears only in this repository's `.operad/dev.json`, `.operad/review.json`, `.operad/worker-brief.md`, `CLAUDE.md` and `scripts/`. Code that bakes in one project's tools (Bun, a lock file, a directory layout, a document name) makes every other project hit a convention it never chose, so the code names none of them.

## Decisions

### D1: The rule and the reproduction command for a flaky test come from the check command's `failed`

The rule for flaky tests and the command that reproduces one are a project's to give, in `gate.commands[].failed` (and `integration.keyCommands[].failed`), with no new top-level word:

- `failed.stress` is the reproduction command. It takes `{pattern}` and `{file}`, the same placeholders as `failed.rerun`. Without it, the brief of a flaky task writes no command.
- `failed.rule` is a file path, relative to the repository, whose content is the project's rule for flaky tests. Without it, `dev` uses one sentence that names no tool: a test that passes on a rerun after failing is a bug, and a timeout or a retry must not be added to make it pass.
- `dev` does not read `CLAUDE.md`, does not probe for `scripts/stress.sh`, and does not fall back to `bun test --rerun-each`.
- The excerpt of a failure log is found with the `failed.match` of the command that found the failure; `dev` knows no tool's output format.
- `dev` does not derive an area from `packages/<name>/`; a flaky task it opens has no area.

### D2: After a merge the main clone runs `prepare`

When the main clone has been fast-forwarded after a merge, `dev` runs the repository's `prepare` lines in it, on every merge. `dev` does not look at `bun.lock` or any other lock file, and there is no new key for this. `prepare` therefore means: run in every checkout `dev` makes, and in the main clone after it moves.

### D3: "The serve runs older code" is a kernel observation

That a running `serve` has loaded code that has since changed is reported by the kernel's code watch, which records which files `serve` loaded. It holds for any loaded code and does not recognise `dev`, the `@operad-io/` prefix or a `packages/` layout. It is one more pending item of the existing watch, not a new kernel concept.

### D4: The engine names no plugin; defaults belong to the CLI

The engine contains no plugin name and no action name. The default plugin list, the optional plugin list, the map from plugin name to package, and the default `mcp.actions` belong to the CLI, as the defaults of the distribution. For an absent `mcp.actions` the engine has the empty list. `operad init` writes a `config.json` carrying the distribution's defaults. The plugin contract does not change: which actions a lead may run is decided only by the owner's configuration, and the actions of a plugin enabled afterwards are added to `mcp.actions` by hand.

The configuration names a plugin's module by its current name. The engine does not rewrite an old module name into a new one.

### D5: A test keeps the boundary

The non-test source of `packages/dev/src` contains none of `bun `, `bun.lock`, `scripts/`, `CLAUDE.md`, `packages/`. The non-test source of the engine contains no plugin name that ships with operad and no `<plugin>:` action name.

### D6: The boundary is shown with a repository that does not use Bun

A small fixture repository has no `package.json`, no `scripts/`, no `CLAUDE.md`, and checks by shell commands. A test runs a flow on it, and the user documentation gives the same example.
