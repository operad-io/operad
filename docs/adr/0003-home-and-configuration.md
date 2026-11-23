# ADR 0003: The Home Directory and Configuration Files

Status: accepted

## Background

The kernel is not about code repositories; the `dev` plugin is. Personal-assistant plugins need no repository at all.

## Decisions

### D1: The kernel is not bound to a repository

operad has one home directory (default `~/.operad`). The configuration, the storage and the scheduling loop live there. Commands work in any directory, and the kernel does not read git. The `dev` plugin is what binds to repositories: it registers them (`operad repo add`), and each repository keeps its own settings inside the repository.

### D2: Configuration files are JSON with a JSON Schema

Configuration files (the home's `config.json`, a repository's `.operad/dev.json`) are JSON, each with a JSON Schema, so an editor can complete and check them. Flows and plugins are TypeScript; nothing else is.

### D3: The home holds the person's own flows

`<home>/flows/<name>.flow.ts`, whose default export is a `defineFlow` value, is a flow named `home:<name>` (ADR 0002 D5). It may call the steps of every loaded plugin, is listed by `flows` and can be started by a routine. A file that does not load is refused with its reason, which names the file; the other files and `serve` are not affected. A file imports `@operad-io/engine` and gets the engine the running operad is made of: the kernel keeps `<home>/node_modules/@operad-io/engine` as a link to it, renewed when it points elsewhere, and leaves a real directory there alone. A home with no flow files is not written to.
