# Architecture decision records

An ADR states a decision that is in force, as if it had always been the decision. It is the place to look for what the code and every later change must follow.

## Rules

- ADRs are English. Each has the form `# ADR 0004: Title`, `Status: accepted`, `## Background`, `## Decisions` with a `### D1: ...` per decision, and optionally `## Consequences` or `## Not decided here` when that states a boundary (not open work).
- An ADR holds only decided points: ones the code follows today, or rules that bind all future work.
- An ADR has no dates, no "the owner said on ...", no revision notes, no "was X, now Y", no task ids and no path of a plan or backlog file, and no "next task" or "later". A reason the owner gave stays as rationale ("because ...").
- Open questions, plans, acceptance criteria, ordering and status live in the backlog, not here. A decided point that is not built yet stays in its backlog item until it lands.
- To change a decision, change the ADR in its own commit; do not contradict it.
- One topic per ADR, numbered in the order written. Add each new ADR to the index below.
- A test (`scripts/test/adr-snapshot.test.ts`) enforces the form of these rules and that the index matches the files.

## Index

| Number | Title | One line |
|---|---|---|
| [0001](0001-direction.md) | The Direction of operad | What operad is, its name and language, and what it does not take from peers |
| [0002](0002-kernel-boundary.md) | The Kernel Boundary | The five things in the kernel, the storage backend, the three user words, `dev` as a plugin |
| [0003](0003-home-and-configuration.md) | The Home Directory and Configuration Files | One home, no repository in the kernel, JSON configuration with schemas |
| [0004](0004-flow-engine.md) | The Flow Engine | Flows as data plus TS, event sourcing, the four steps, idempotence and tests |
| [0005](0005-storage-backend-and-change-facts.md) | The Storage Backend and Change Facts | One log interface and backend, object facts record changes only |
| [0006](0006-plugin-objects-and-facts.md) | Plugin Objects and Facts | `list` with filters and paging, `facts` with subscription |
| [0007](0007-actions-and-person-input.md) | Actions and Input from a Person | Action `args` with a schema, `actor` on every input |
| [0008](0008-asking-a-person-inside-a-step.md) | Asking a Person Inside a Step | `ctx.ask`: grace, timeout pause, resume with a one-time grant |
| [0009](0009-material-usage-and-limits.md) | Material, Usage and Step Limits | External text only as material, one `usage` shape, step `limit` |
| [0010](0010-plugin-declaration.md) | What a Plugin Declares | Settings, secrets, access profile, rules, requires, testing package, what stays out |
| [0011](0011-plugin-kinds.md) | Plugin Kinds and Skills | The six kinds, skills as `SKILL.md` text |
| [0012](0012-plugin-lifecycle.md) | Plugin Versioning, Checking, Enabling, Reloading and Dependencies | SDK version and check, enable and disable, hot reload, third-party dependencies |
| [0013](0013-actions-as-commands.md) | Actions Are Commands | `plugin:action` commands, action parameters, two layers of keys |
| [0014](0014-display-interface.md) | The Display Interface and Content | `row`, `sections`, `load`, Markdown only, the client API |
| [0015](0015-hierarchy.md) | Hierarchy | `parent`, top-level objects, next layer, the TUI layout |
| [0016](0016-row-marks.md) | Row Marks, Badges, Ordering and the Progress Bar | The fixed `mark` set, `badge`, `after`, the progress bar |
| [0017](0017-settings.md) | Settings | Kernel-read settings changed through `settings` and `set` |
| [0018](0018-created-objects-and-settings-objects.md) | Opening Created Objects, Creating Actions, and Objects Under Settings | `opens`, `creates`, objects hosted under settings |
| [0019](0019-live-sections.md) | Live Sections | `after` mark, `tail`, update rate |
| [0020](0020-project-flows.md) | Project Flows in the `dev` Plugin | Flows as ordered stages in `dev.json`, two hard rules, `--flow`, `pool`, `workerBrief`, `commit` |
| [0021](0021-worker-pools.md) | Worker Pools | The `pool` plugin, home totals per harness, repository workers and pools, fallback |
| [0022](0022-harness-interface.md) | The Harness Interface | `sdk` and `acp` connections, harness names, the user's own harness, `codex` |
| [0023](0023-pi-harness.md) | The `pi` Harness | A Bun child process, no discovery, the user's pi and login, access matching |
| [0024](0024-claude-harness.md) | The `claude` Harness | The Agent SDK client, the user's binary and login, `canUseTool`, facts |
| [0025](0025-access-profile.md) | The Access Profile | A guardrail enforced by each harness, asks as pending items, the user layer |
| [0026](0026-chat.md) | The Chat | One object, message events and `chat:reply`, asking in the middle, agent, model and effort, closing |
| [0027](0027-chat-record.md) | Chat Attachments and the Record of a Reply | Uploads to the chat's directory, entries as facts, text through the section's tail |
| [0028](0028-repository-and-bot-chats.md) | Repository Chats and Bot Chats | Two kinds by origin, read-only main clone, MCP tools, first message creates, channels |
| [0029](0029-serve-and-clients.md) | `operad serve` and the Clients | The display interface over HTTP, one backend, an app that knows no plugin |
| [0030](0030-bot.md) | The Bot Plugin | The bot object, its directory, changes only through proposals, MCP servers in settings |
| [0031](0031-bot-mcp-servers.md) | MCP Servers on a Bot | No directory, pending registration, pinned versions, tool-change stop, secrets at start |
| [0032](0032-triggers-sources-and-channels.md) | Triggers, Sources and Channels | One start entry, rules, three modes, `source` plugins, run results as events, four channels |
| [0033](0033-telegram.md) | The Telegram Plugin | In-process channel and source, automatic binding, buttons and replies |
