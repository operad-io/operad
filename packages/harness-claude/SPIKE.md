# Claude harness spike

Checked on macOS 27.0.1 (Darwin 27.0.0, arm64), Bun 1.3.14 (0d9b296a), with
the user's own `claude` binary. This is the task-1 spike from
[`docs/backlog/operad-harness-claude.md`](../../docs/backlog/operad-harness-claude.md):
Bun, the empty platform packages, the zero-token probe, and the isolation
environment variables opencode uses.

## Versions seen

| thing | version |
|---|---|
| Bun | 1.3.14 (0d9b296a) |
| Claude Code (user's binary) | 2.1.319 |
| `@anthropic-ai/claude-agent-sdk` | 0.3.319 |
| `@anthropic-ai/sdk` (SDK peer) | 0.129.0 |
| `@modelcontextprotocol/sdk` (SDK peer) | 1.32.2 |
| `zod` (SDK peer) | 4.6.7 |
| `empty-npm-package` (override target) | 1.0.0 |

The binary on PATH is `/Users/hai/.local/bin/claude`, a symlink to
`/Users/hai/.local/share/claude/versions/2.1.319`. The zero-token probe reports
`claudeCodeVersion: "2.1.319"` and 13 models. Its account labels are
`subscriptionType: "Claude Max"`, `apiProvider: "firstParty"`,
`apiKeySource: null`, `tokenSource: null`; no email, session id or credential is
printed.

## What Bun needed

- **The override syntax.** The root `package.json` maps each of the eight
  `@anthropic-ai/claude-agent-sdk-<platform>` names to
  `npm:empty-npm-package@1.0.0`. Bun 1.3.14 accepts the `npm:` alias in
  `overrides`; after `bun install`, the SDK's platform entries under
  `node_modules/.bun/@anthropic-ai+claude-agent-sdk@.../node_modules/@anthropic-ai`
  are symlinks to `empty-npm-package@1.0.0`. There is no real platform package
  and no 300 MB binary. The SDK's JavaScript package itself is still there.
- **Nothing else.** The SDK imports and runs directly under Bun:
  `query()`, `initializationResult()`, `accountInfo()` and `close()` all work.
  No `executable` option, no `bun build --compile`, and no
  `extractFromBunfs()` are needed when `pathToClaudeCodeExecutable` points at
  the user's native `claude`.
- **Resolving the user's binary.** `Bun.which("claude")` returns the PATH entry;
  `realpathSync` turns the symlink into the versioned executable before it is
  passed to the SDK. With no `claude` on PATH, the probe exits 1 and prints
  `probe: no \`claude\` on PATH; install Claude Code or put its binary on PATH`.
  This was checked with `PATH=/nonexistent`.
- **Zero tokens.** The probe passes a prompt stream that never yields a message,
  reads the initialization reply and account information, and closes the query.
  It reports `tokenRequestsSent: 0` and `deniedToolCalls: 0`; the tool callback
  is installed and denies if called, but the probe does not make a model request.
- **The binary test.** `test/platform-packages.test.ts` finds every installed
  `claude-agent-sdk-<platform>` package (root `node_modules`, the package's
  `node_modules`, the SDK's real directory, and Bun's `.bun` store), resolves
  it, and fails unless it is the `empty-npm-package` with only `package.json`
  and `index.js` and no file over 4096 bytes. It passes after
  `bun install --frozen-lockfile`.

## Isolation environment variables

opencode 2.2.3's Claude Agent provider sets the list below in
`packages/core/src/plugin/provider/claude-agent/claude/query-options.ts`.
Current opencode (2.2.5) keeps that list and adds the two fallback variables at
the bottom. Each name was checked against the Claude Code 2.1.319 binary with
`strings -a`; the snippets show a getter and a `process.env` read, not just a
user-facing help string. "Read" means the current binary still looks at the
variable; it does not mean the whole effect was exercised (see below).

| variable | opencode value | read by 2.1.319 | binary evidence |
|---|---|---|---|
| `CLAUDE_CODE_DISABLE_CLAUDE_MDS` | `"1"` | yes | `Boolean(i.CLAUDE_CODE_DISABLE_CLAUDE_MDS...)`; early return in the CLAUDE.md loaders |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | `"1"` | yes | `process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY`; memory mode becomes `"off"` |
| `DISABLE_AUTO_COMPACT` | `"1"` | yes | `i.DISABLE_AUTO_COMPACT` in the auto-compact check |
| `CLAUDE_CODE_ENABLE_AWAY_SUMMARY` | `"0"` | yes | `process.env.CLAUDE_CODE_ENABLE_AWAY_SUMMARY` in the away-summary check |
| `ENABLE_TOOL_SEARCH` | `"false"` | yes | parsed as a tool-search mode; `ENABLE_TOOL_SEARCH=false` is named in the fallback message |
| `CLAUDE_CODE_DISABLE_ADVISOR_TOOL` | `"1"` | yes | `Boolean(...)` in the advisor-tool availability check |
| `MAX_MCP_OUTPUT_TOKENS` | `"200000"` | yes | `i.MAX_MCP_OUTPUT_TOKENS` caps MCP tool output |
| `CLAUDE_CODE_SIMPLE` | unset | yes | the bare-mode variable; strings describe it as skipping OAuth and keychain reads, and the CLI can `unset CLAUDE_CODE_SIMPLE` |
| `CLAUDE_CODE_EFFORT_LEVEL` | unset | yes | named as a session effort override in the flag-settings code |
| `MCP_TOOL_TIMEOUT` | unset | yes | per-server MCP tool timeout fallback |
| `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK` | `"1"` (2.2.5) | yes | `i.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK` in the fallback decision |
| `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK` | `"1"` (2.2.5) | yes | `!i.CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK` in the refusal-fallback check |

opencode also clears `CLAUDE_CODE_SIMPLE`, `CLAUDE_CODE_EFFORT_LEVEL` and
`MCP_TOOL_TIMEOUT` rather than setting them, because a value inherited from the
user's shell would change the session. That is still an interaction with a
variable the current binary reads.

## What I could not check

- **The effect, not just the read.** I did not send a model request or run a tool
  call, so I did not observe `ENABLE_TOOL_SEARCH` hiding tools,
  `CLAUDE_CODE_SIMPLE` skipping the subscription login, the MCP timeout and
  output limits, or the fallback variables changing a failed request. Setting
  `CLAUDE_CODE_SIMPLE` was deliberately not tried because it changes the login
  path, and `MAX_MCP_OUTPUT_TOKENS`/`MCP_TOOL_TIMEOUT` need an MCP tool call.
- **The hosted Claude Code docs.** I checked the 2.1.319 binary, not the current
  docs page, so the docs may list variables that are not in opencode's list. I
  also did not verify that opencode's list is complete for the current release.
- **Other platforms.** The binary and the probe were checked only on macOS
  arm64. The platform empty-package layout is the same in the lockfile for all
  eight names, but it was not installed on Linux or Windows.
- **A real request and a real resumed session.** Those belong to the worker and
  dogfood tasks, not to this zero-token spike.
