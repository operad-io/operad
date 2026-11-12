# Claude Code isolation environment variables (2026-11-07)

Research note for the claude harness item in `docs/backlog/`, decision 4: besides
`settingSources: []`, which environment variables keep Claude Code quiet? The
table below was in the package's spike notes, which T-0266 deleted; this
note keeps the observation.

Observed on 2026-11-07 with Bun 1.3.14, `@anthropic-ai/claude-agent-sdk`
0.3.319 and the Claude Code 2.1.319 installed on this machine.

## Method

The list is the kind opencode sets: auto memory, auto compaction, tool search,
telemetry and the rest. A variable is in the table when its name appears in the
strings of the 2.1.319 binary (`grep -a` on the file the `claude` link resolves
to). A name in the binary means Claude Code reads it; **what each does at run
time was not exercised**, and accepted values were not read. The docs
(code.claude.com) were not read for this note; only the binary and `sdk.d.ts`
were.

## Variables

| variable | in the 2.1.319 binary | note |
|---|---|---|
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | yes | auto memory; the SDK also has a settings key `autoMemoryEnabled` |
| `DISABLE_AUTO_COMPACT` | yes | auto compaction |
| `DISABLE_COMPACT` | yes | all compaction |
| `ENABLE_TOOL_SEARCH` | yes | tool search |
| `CLAUDE_CODE_DISABLE_CLAUDE_MDS` | yes | CLAUDE.md files; `settingSources: []` already skips them |
| `DISABLE_TELEMETRY` | yes | |
| `DISABLE_ERROR_REPORTING` | yes | |
| `DISABLE_AUTOUPDATER` | yes | the user's `claude` updates itself; not changed here |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | yes | |
| `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` | yes | |
| `CLAUDE_CODE_DISABLE_CRON` | yes | |
| `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY` | yes | |
| `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` | yes | |
| `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS` | yes | |
| `CLAUDE_CODE_DISABLE_ATTACHMENTS` | yes | |
| `CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING` | yes | |
| `DISABLE_BUG_COMMAND` | yes | |
| `DISABLE_PROMPT_CACHING` | yes | do **not** set: it raises cost |

Checked in `sdk.d.ts` instead of the binary: `settingSources`, `disableAllHooks`
(a settings key), `strictMcpConfig`, `permissionPrompts` and `autoMemoryEnabled`
exist as options or settings keys in 0.3.319.

## Not checked

opencode's own list was not available here, so a variable that opencode sets and
is not in the table above was not looked up. The worker's current set, and the
reason auto compaction and tool search are left on, are in
`packages/harness/claude/README.md`.
