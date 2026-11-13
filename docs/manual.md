# operad manual

The user manual starts at [docs/user/index.md](user/index.md): the commands, the
home and `config.json`. A complete workflow is in [docs/dogfood.md](dogfood.md).

## Install

operad runs on [Bun](https://bun.com); install Bun first. The `operad` command
comes from the CLI package:

```sh
bun add -g @operad-io/cli
operad init
operad --help
```

`operad init` creates `~/.operad` when it is missing and checks the plugins that
are enabled. To use Claude as a worker, enable its plugin once:

```sh
operad plugin enable claude
```

That installs `@operad-io/harness-claude` and the Agent SDK client it needs into
a Bun project under `~/.operad/plugins`. It does not install Claude Code: use the
`claude` command you already installed and logged in to. The first enable needs
network access to the npm registry. `operad plugin check claude` says what to run
when it is not installed.
