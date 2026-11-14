# Contributing to operad

Thanks for helping. Bug reports and ideas are welcome as
[issues](https://github.com/operad-io/operad/issues); questions go to
[Discussions](https://github.com/operad-io/operad/discussions). For a larger
change, open an issue first so we can agree on the direction before you write it.

## Set up

1. Install [Bun](https://bun.sh).
2. Clone the repository and run `bun install`.
3. Run `bash scripts/verify.sh` before you open a pull request. It type-checks
   and runs the tests, and it takes a while; while you work, `bunx tsc -b` and
   `bun test <file>` on the files you touch are faster.

There is no build step: Bun runs the TypeScript directly.

## Where to read

- [User manual](docs/user/index.md): what operad does and the words it uses.
- [Writing a plugin](docs/plugins/index.md): the plugin API.
- [Architecture decision records](docs/adr/): the decisions in force. Please
  do not contradict one; if a change needs a decision reversed, propose that in
  an issue first and edit the ADR in its own docs-only commit merged with the
  code.
- [docs/backlog/](docs/backlog/): the maintainers' working notes, one file per
  item, in Chinese. Each references the ADRs it touches.

## Rules

- **Keep the kernel small.** The kernel has three words: flow, pending and
  history. A feature a plugin could provide belongs in a plugin, not the kernel.
- **Strict TypeScript.** No `any`, no `@ts-ignore`, and no non-null `!` to
  silence the checker.
- **Every behaviour has a test**, written with `bun:test`. A test that needs time
  uses an injected clock, not the real one. A test never sleeps to wait for
  something: it waits for the event.
- **No new runtime dependency** without asking first. The engine has none.
- **Configuration is JSON, with a JSON Schema** in the package that reads it.
  Flows and plugins are TypeScript.
- **Words users see.** Command output, errors and user docs speak in flows,
  pending and history, plus the words of the plugin concerned. Do not introduce
  a new user-visible word (a command, an action, a setting) without agreeing it
  in an issue first.
- **Repository text is English:** code, comments, commit messages and docs.

Maintainers may ask for a test that fails without your change. Keep a pull
request to one piece of work, and say in it what changed and why.

## Security

Do not report a vulnerability in an issue; see [SECURITY.md](SECURITY.md).
