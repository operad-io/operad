# ADR 0010: What a Plugin Declares

Status: accepted

## Background

The conversation, knowledge-base, memory, source and daily-collection scenarios must all be writable as plugins without changing the kernel. The principle is to add no feature: make existing primitives general, and add only what is missing. Each point below answers a requirement that a scenario raised; what no scenario needs is not added.

## Decisions

### D1: `settings`

Each plugin has one JSON Schema. The kernel validates that plugin's section of `config.json` and hands it to the plugin as `ctx.settings`. The choice of a backend, the path of a library and an OAuth application id all go here. A plugin has no configuration file of its own for them. (The per-repository `.operad/dev.json` of `dev` is its own object and is not covered.)

### D2: `secrets`

`ctx.secrets.get(name)` and `set(name, value)` are scoped per plugin and are stored outside the log (a 0600 file, replaceable later by a keychain). A secret never enters a fact, a param, an environment variable or `history`. A login state and a scoped key are the same thing. The `Secret` type exists, and this is where it is kept.

### D3: Runs carry an access profile

A run carries an access profile, `ctx.access`, which is opaque to the kernel. A plugin declares the fields it can enforce (`enforces: ["denyPaths", "askCommands", …]`). The kernel refuses to start a run whose access profile requires a field that no one enforces, and names the field. The kernel does not sandbox; it only guarantees that no one silently ignores the access profile. A one-time grant (ADR 0008) is part of the access profile data.

### D4: Rules and requirements

The declaration has two more fields: **`rules`** (default trigger rules) and **`requires`** (the plugins and the plugin API version that it depends on, checked at load time and reported clearly).

### D5: The testing package

`@operad-io/engine/testing` offers a fake clock, an in-memory store, `runFlow`, `answer` and `emit`, so an agent can write and test a plugin without starting `serve`. This is the premise of the path "describe a need, an agent writes a plugin on the spot".

### D6: What stays out of the kernel

Per-token streaming, memory, search indexes, a plugin's backends, scheduling policy, channel delivery, client logic beyond Markdown rendering, and any platform's API are not in the kernel. A conversation scenario runs on the existing views and calls (`list conversation`, a `transcript` section, `act chat:send`), and that is the test that the contract is sufficient.
