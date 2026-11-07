# Acceptance of harness-claude, by hand

For the lead to run. Each point of the acceptance in
`docs/backlog/operad-harness-claude.md` is below with the exact command and what
to look for. Points 3 to 10 make real model requests through **your own claude
login**; `scripts/verify.sh` and the tests never do. Nothing here changes this
repository's `.operad/dev.json`.

Start from a checkout of `feat/harness-claude`, with `claude` on `PATH` and
logged in:

```sh
cd ~/Code/operad/.operad-worktrees/harness-claude
bun install --frozen-lockfile
operad plugin enable harness-claude
mkdir -p /tmp/claude-acceptance
```

`packages/harness-claude/acceptance/step.ts` runs one `harness-claude/agent` step
in a scratch home and prints what it recorded. It prints no token and no account
detail.

## 1. No platform binary after a frozen install

```sh
bun install --frozen-lockfile
bun test packages/harness-claude/test/binaries.test.ts
find node_modules -maxdepth 4 -type d -name '*claude-agent-sdk-*' -exec du -sk {} \;
```

Look for: the test passes; every directory the `find` lists is a few KB (an empty
package). There is no 300 MB directory and no file named `claude` under
`node_modules/@anthropic-ai/`.

## 2. `operad plugin check` reports both versions and the login

```sh
operad plugin check
```

Look for: a `harness-claude` line like
`claude 2.1.319 at /path/to/claude (floor 2.1.319); agent sdk 0.3.319; login claude.ai (max); the worker program is available`.
The claude version and the SDK version are both there; the login is a kind
(`claude.ai (max)`), never an e-mail or an organisation. To see the refusals,
run it once with a bad command and once logged out:

```sh
operad plugin check   # with "command": "/nowhere/claude" in the harness-claude section of config.json -> names the missing command and says to install claude
claude auth logout && operad plugin check   # -> "claude is not logged in; run `claude auth login`"
claude auth login     # log in again
```

## 3. The zero-token probe

```sh
bun packages/harness-claude/spike/probe.ts
```

Look for: JSON with `claudeCodeVersion`, `sdkVersion`, `apiProvider`
(`firstParty`), `subscriptionType`, `apiKeySource` and `deniedCalls: 0`. No
model request is made.

## 4. One real step: usage, an estimated cost and a session id

```sh
bun packages/harness-claude/acceptance/step.ts --cwd /tmp/claude-acceptance \
  --prompt "Reply with the single word pong." --model sonnet
```

Look for: `"result": "done"`; `sessionId` a UUID; `usage.tokens` non-zero;
`usage.costQuality` `"estimated"` and a non-zero `usage.costMicros` (an API-price
figure; the subscription is not charged by it); `usage.model` a model name;
`logLines` starts with a `session` line whose `apiKeySource` is `none`. If it
says `ANTHROPIC_API_KEY`, an API key is in the environment and **that key is
billed**: unset it and run again.

## 5. A second step resumes the same session

Use the `sessionId` of point 4:

```sh
bun packages/harness-claude/acceptance/step.ts --cwd /tmp/claude-acceptance \
  --resume <sessionId> --prompt "What single word did I ask you to reply with?"
cd /tmp/claude-acceptance && claude --resume <sessionId>   # Ctrl-C to leave
```

Look for: `finalMessage` says `pong`; the `sessionId` is the same (note it if it
is not); `claude --resume` shows both turns. Resuming an id that does not exist
(`--resume 00000000-0000-4000-8000-000000000000`) ends `failed` with reason
`session_missing`.

## 6. A denied `Bash` call: the agent gets the reason and goes on

```sh
mkdir -p /tmp/claude-acceptance-victim
bun packages/harness-claude/acceptance/step.ts --cwd /tmp/claude-acceptance \
  --deny-command rm \
  --prompt "Use the Bash tool to run: rm -rf /tmp/claude-acceptance-victim. Then say what happened."
ls -d /tmp/claude-acceptance-victim
```

Look for: `"result": "done"`; in `logLines` a `blocked` line for `Bash` whose
`reason` names `denyCommands rule "rm"`, then a `tool_execution_end` with
`isError: true`; `finalMessage` says the command was refused; the directory
still exists.

## 7. A one-time permission

```sh
bun packages/harness-claude/acceptance/step.ts --cwd /tmp/claude-acceptance \
  --deny-command rm --grant-command "rm -rf /tmp/claude-acceptance-victim" \
  --prompt "Use the Bash tool to run: rm -rf /tmp/claude-acceptance-victim. Then say what happened."
ls -d /tmp/claude-acceptance-victim   # -> No such file or directory
```

Look for: the line `grant used: acceptance-grant`; no `blocked` line; the
directory is gone.

## 8. `askCommands` is refused when a run starts

```sh
bun packages/harness-claude/acceptance/step.ts --ask-command "git push"
```

Look for: `refused as expected: access.askCommands: no step of flow
"harness-claude:prompt" enforces it ...` (the field is named).

## 9. A dogfood task to `review` with claude as the worker

Use a scratch clone so this repository's config is not touched:

```sh
git clone ~/Code/operad /tmp/claude-dogfood && cd /tmp/claude-dogfood
```

In `/tmp/claude-dogfood/.operad/dev.json` set `worker` to
`{ "use": "harness-claude/agent", "args": ["--model", "sonnet"], "stallSecs": 900, "wallTimeSecs": 3600 }`
(leave the reviewer as it is). Then, as in `docs/dogfood.md`:

```sh
operad repo add .
echo "Add a file HELLO.md that says hello." | operad plan add --slug claude-try --title "Try claude"
echo "Create HELLO.md with one line." | operad task add --plan P-0001-claude-try --slug hello --title "Add HELLO.md"
operad dev:confirm P-0001-claude-try
operad serve              # leave it running; in another terminal:
operad pending
operad history T-0001-hello
```

Look for: the task reaches `pending` for review; `history` shows the worker step
as `harness-claude/agent`; the step's facts have `usage` with
`costQuality: "estimated"` and a `sessionId` that is a UUID. Then
`operad dev:reject T-0001-hello --note "also add a second line"`: check whether
the next worker step carries the same `sessionId` (resuming is the `dev`
plugin's rule; the harness continues whatever session it is given).

## 10. `kill -9` on the worker: the step is interrupted, `serve` is not

While point 9's worker step is running:

```sh
pgrep -f 'harness-claude/src/worker.ts'
kill -9 <that pid>
operad running
operad history T-0001-hello
```

Look for: `operad serve` is still running and `operad running` still answers; the
worker step ends `interrupted` with reason `signal`; the loop starts it again
from its last recorded step.

## 11. Open question 1: does it count against the subscription like `claude` does?

Open `claude` interactively and run `/usage`; note the figures. Do points 4 and
5; run `/usage` again. Write down whether the five-hour and weekly figures moved
and by how much. (Not decided in the backlog; this is the evidence.)

## What is not covered by any test

The real `claude`, the real login and a real model are used only by points 2 to
11. The tests use a fake `claude` process (`test/fake-claude.ts`) and fake
`claude` shell scripts for the check.
