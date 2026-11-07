# Spike: the Claude Agent SDK under Bun (T-0037)

Facts checked while setting up the package. Everything here was observed on
2026-11-07 with Bun 1.3.14, `@anthropic-ai/claude-agent-sdk` 0.3.319 and the
Claude Code 2.1.319 that is on this machine's PATH. Items marked **not checked**
were not run or read.

## What Bun needed

- Nothing special to install the SDK client: `bun install` resolves
  `@anthropic-ai/claude-agent-sdk@^0.3.319` and its peers (`@anthropic-ai/sdk`,
  `@modelcontextprotocol/sdk`, `zod`) with no extra flag.
- The SDK lists the Claude Code binary in eight `optionalDependencies`
  (`@anthropic-ai/claude-agent-sdk-<platform>`, 317 MB on this machine). The
  root `package.json` has `overrides` that replace each of the eight with
  `npm:empty-npm-package@1.0.0`. `bun.lock` then resolves all eight to
  `empty-npm-package@1.0.0`, and a frozen install adds no platform directory
  under `node_modules/`. `test/binaries.test.ts` fails when an override is
  missing, when `bun.lock` names a real platform package, or when an installed
  platform package holds more than a stub.
- The SDK client is used with `pathToClaudeCodeExecutable` set to the real path
  of the `claude` on PATH. The probe resolves it with `Bun.which` and
  `realpathSync`.
- `package.json` writes the SDK as the range `^0.3.319`; `bun.lock` records the
  version in use.

## The probe (`spike/probe.ts`)

A script the lead runs by hand: `bun packages/harness-claude/spike/probe.ts`.
It is not part of `verify`, and no test runs it. It opens a streaming query
whose input never yields (so no prompt, no model request), with
`settingSources: []`, `permissionMode: 'default'`, `permissionPrompts: 'host'`
and a `canUseTool` that logs and denies. It reads `initializationResult()` and
`accountInfo()`, prints the Claude Code version, the SDK version, `apiProvider`,
`subscriptionType`, `apiKeySource` and `tokenSource` as JSON, and closes. It
prints no e-mail, organisation or token. With no `claude` on PATH it exits 1 with
"no `claude` command was found on PATH; install Claude Code first …"
(`test/binaries.test.ts` covers that message).

**Not checked by the author:** the probe's run against a real login. It makes
`claude` read the user's login, so the lead runs it. Expected from
`operad-harness-claude.md`: `apiProvider` `firstParty` and a `subscriptionType`
for a subscription login.

## Isolation environment variables (open question 3)

The list is the kind opencode sets to keep Claude Code quiet: auto memory, auto
compaction, tool search, telemetry and the rest. Method: whether the variable
name appears in the 2.1.319 binary's strings (`grep -a` on the file the `claude`
link resolves to). A name in the binary means Claude Code reads it; **what
each does at run time was not exercised**, and accepted values were not read.

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

**Not checked:** opencode's own list was not available here, so a variable that
opencode sets and is not in the table above was not looked up. The docs
(code.claude.com) were not read in this task; only the binary and `sdk.d.ts`
were. The worker task decides which of these it sets; the ones the spec names
(auto memory, auto compaction, tool search) are all still read.
