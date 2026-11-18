# @operad-io/access-match

The access profile matcher. `match(profile, call)` says whether one tool call
may run under the `denyPaths`, `denyCommands` and `askCommands` of an access profile
(ADR 0025 D1 and D3, and ADR 0023 D7). Harnesses call it in their
tool-call hook: pi today, Claude and the command adapter later.

```ts
match(profile, { tool, input, cwd }):
  | { allow: true }
  | { allow: false, reason, rule? }                          // refused
  | { allow: false, ask: true, reason, rule, kind: "command" | "path", value, tool? }  // asks a person
```

Precedence: **deny wins over ask, and ask wins over allow.** A call that matches
`denyCommands` or `denyPaths` anywhere is refused, whatever `askCommands` says,
and nobody is asked; a call that matches only `askCommands` asks; any other call
is allowed. An `alwaysAllow` entry lifts an ask for its exact call and cwd; it
never lifts a deny. A caller that does not know `ask` sees `allow: false` and refuses,
never passes.

The matcher is pure and synchronous and keeps no state between calls. It never
touches the file system: paths are resolved **lexically** against `cwd`. The
only outside value it reads is the home directory for `~` (`os.homedir()`, or
the `home` option). `test/match.test.ts` follows the tables below.

## Profile

| field | type | meaning |
|---|---|---|
| `denyPaths` | string[], optional | a call that touches a path under one of these is refused |
| `denyCommands` | string[], optional | a `bash` command part that matches one of these is refused |
| `askPaths` | string[], optional | paths a write asks about (`~/.zshrc`, `~/.*profile`); `*` stays within one path segment and a path under a match counts. Judged for `write` and `edit`, and for a `bash` redirect (`>`, `>>`) to such a path, which asks with the whole command. Deny wins over it |
| `readOnly` | boolean, optional | the call's working directory is read-only: a write under it (`write`, `edit`, a `bash` redirect) asks, as if the directory were in `askPaths`. Deny wins over it |
| `level` | `plan`, `ask`, `edits` or `full`, optional | a chat's access level. It adds asks to the profile and never removes a deny or a rule: `plan` is `readOnly`; `ask` asks about every write and every command not known to only read; `edits` lets a write inside the working directory pass and asks about a write outside it and a command not known to only read; `full` adds no ask. The profile's own `askCommands`, `askPaths` and `readOnly` still hold |
| `readPaths` | array of paths, optional | directories the agent may read although `denyPaths` covers an ancestor: a read tool (`read`, `grep`, `find`, `ls`) or a `bash` command that only reads may touch a path under one. A write there asks (the entries count as `askPaths`); every other denied path stays denied |
| `allowMcp` | string[], optional | MCP tools that run without asking, as `<server>.<tool>` or `<server>.*`. The field's presence (even empty) puts MCP tools under the profile: a call with `tool: "mcp"` and `input: { server, tool }` that is not listed counts as a write and asks (`kind: "command"`, value `mcp <server>.<tool>`), per the MCP-tool rule in `docs/backlog/operad-sandbox.md`, not in an ADR yet. When the field is absent, MCP tools are not under the profile and are allowed |
| `askCommands` | string[], optional | rules in the shape of `denyCommands`; a `bash` command part that matches one of these asks a person (ADR 0025 D1). Writes to shell profiles are `askPaths` |
| `defaultAsks` | boolean, optional | `false` starts the profile from the built-in default's deny rules only: its `askCommands` and `askPaths` are not added. The profile's own asks still hold. Every step a dev task runs sets it so scripted edits run without a question (ADR 0025 D9); a flow profile still only adds |

| `alwaysAllow` | `{ kind: "command" \| "path", value, cwd, tool? }[]`, optional | calls a person answered `allow_always` for. A command entry is the exact command text and cwd; a path entry is the tool, the path and cwd. Such a call is allowed when it would otherwise ask. A deny still wins, and a harness leaves the entries out of a run no person's message started (ADR 0025 D3, D4 and D7; the background-run rule is still in `docs/backlog/operad-sandbox.md`) |

| `grants` | `{ waitId, kind: "command" \| "path", value, tool? }[]`, optional | one-time permissions not yet used; see `findGrant` |
| `outwardCommands` | string[], optional | command rules in the shape of `askCommands`; a matching `bash` part is an outward write in a background run (`git push` names `origin/main`, a `curl` write its URL, mail its recipients, otherwise the whole command). The built-in default names `git push`, `gh pr create`, `gh issue comment`, `curl`, `wget`, `mail`, `mailx` and `sendmail` |
| `outwardAllow` | string[], optional | targets a background run may write to without asking: a channel and conversation (`telegram:123`), an address, a repository and branch (`origin/main`), or a service. `owner` stands for the owner's own channels; the built-in default contains it |
| `background` | boolean, optional | set by a harness on a run no person's message started. An outward command or unknown MCP tool then asks even without another rule, and `alwaysAllow` is ignored (ADR 0025 D3 and D10) |

`outwardAllowed(profile, write)` says whether one outward write is on the allowlist or to an owner channel. `outwardQuestion(write)` is the pending question that names its target and carries its content; its choices are `send_once` and `reject_once`, plus `allow_target` when the caller can bind a grant (`Always for this flow and target`). `guardOutward(ctx, write)` asks it only in a background run and only when the target is not allowed; with `home` and `flow` it first checks the target grants of `access-grants.json` and records one for the `allow_target` answer. `declaredOutward(declaration, input)` reads a step or action's `reachesOutside`/`outward` declaration, and `guardDeclaredOutward` guards every write it names. `personStarted(trigger)` tells a person's chat message from every other event.

## Target grants

`$OPERAD_HOME/access-grants.json` is the user layer of the third outward
answer (ADR 0025 D12). `readTargetGrants(home)` returns `{ file, problem? }`,
where `file` is `{ flows, grants }`. `targetGrantFor(home, flow, target)`
returns the grant for this flow definition and target, and first records a
changed definition: the flow's digest is kept beside a generated id, and a
digest that differs from the last one seen gives a new id. So an edit and a
later revert both change the identity, and no older grant comes back.
`appendTargetGrant(home, flow, write, by, at)` writes or replaces the grant of
that definition and target; `revokeTargetGrants(home, target, flow?)` removes
the grants of a target and returns how many went. The grant is bound to the
target, never to the content sent. The file is written under the platform file
lock and replaced whole; an unreadable file is reported and treated as empty.
`flowDefinitionDigest(flow)` is the stable digest on which the identity rests.

`findGrant(profile, call)` returns the grant that covers a call, or `undefined`:
a `command` grant covers a `bash` call whose command equals `value` character
for character, a `path` grant a call of the one `tool` it names (not another path tool) on the same file; a path grant without a `tool` covers nothing. It is
pure. The caller must use the grant up (the engine writes `grant_used`) before it
lets the call run, and match the call as usual when it cannot.

Other fields of the access profile (`cwd`, `outside`, `network`) are not read
here. `readProfile(value)` checks an untrusted object
and names the field at fault.

## The built-in default

`defaultAccess()` is the profile every chat and every ordinary generated step
starts from: the credential and keychain paths, `.git/config` and `.git/hooks` in
`denyPaths`; `sudo`, `su`, destructive disk and shutdown commands,
`git push --force*`, `git push --delete`, `curl … | sh`, `wget … | sh`,
`pkill` and `killall` in `denyCommands`; `git push`, `brew install`,
`npm install -g`, `pip install`, `osascript` and `open` in `askCommands`; and
`~/.zshrc` and `~/.*profile` in `askPaths` (ADR 0025 D9).

`defaultDenies()` returns only the default's `denyPaths` and `denyCommands`.
Every agent a dev task runs starts from these: the default's asks, and the
inline-code ask they trigger, are left out (ADR 0025 D9).

`withDefaultAccess(profile)` returns that default with the profile's rules
appended to the four lists and `readOnly` turned on when either side has it.
Nothing in the profile removes a default deny. A profile with
`defaultAsks: false` uses `defaultDenies()` instead, so the default's asks are
left out while the profile's own asks are still appended. `withAccessLevel` uses
it before composing a chat's level, so every level, `full` included, keeps the
default's rules. A bot adds the operad home and command, and a repository chat
adds its qualification, in their plugins; the default itself stays free of a
home or a plugin.

## Call

| tool | what is checked |
|---|---|
| `read`, `write`, `edit` | `input.path` (or `input.file_path`) against `denyPaths` |
| `grep`, `find`, `ls` | `input.path`, when given, against `denyPaths` |
| `bash` | `denyCommands` and inline code, then every path-like argument against `denyPaths` |
| anything else | allowed |

A missing or non-string path argument of a checked tool is allowed: the tool
itself reports that error.

## Splitting a `bash` command

Outside quotes the command is split into parts at these operators. Each part
remembers the operator before it.

| operator | note |
|---|---|
| `&&`, `\|\|`, `;`, `\|`, `\|&`, `&` | `\|\|` and `&&` are read before `\|` and `&` |
| newline | a backslash before the newline joins the lines instead |
| `(` and `)` | read as separators; `$(` is inline code, see below |

Quotes: `'…'` keeps everything literal; `"…"` keeps operators literal and
still lets `\"`, `\\`, `` \` `` and `\$` escape; outside quotes a backslash
escapes the next character. An operator inside quotes or after a backslash
does not split. An unterminated quote runs to the end of the command.

## Matching a part against `denyCommands`

The words of a part are unquoted. Leading `NAME=value` words are skipped. The
command name is the first word without its directory (`/bin/rm` is `rm`).
These wrappers are looked through, and the rule is tried at every level:
`env`, `command`, `exec`, `nohup`, `time`, `builtin`, `sudo`, `doas`. After a
wrapper, `NAME=value` words and words starting with `-` are skipped.

A rule is a pattern of words; `*` in a word matches any characters.

| pattern word | matches |
|---|---|
| the first word | the command name, whole (`git`) |
| a word like `-rf` (one dash, letters) | the union of the single-dash letters of the part's arguments contains every letter, so `-fr`, `-rfv` and `-r -f` all match `-rf` |
| any other word | an argument of the part equal to it (a trailing `/` ignored, except for `/` itself), in any position, so `git -C x push --force` matches `git push --force*` |
| `…` or `...` | nothing; it only reads well. It adds no condition |
| `\|` between words | the rule spans a pipeline: each side matches one part, and the parts follow each other joined by `\|`, so `curl … \| sh` matches `curl x \| sh` and `curl x \| tee y \| sh` does not |

The reason is `part "<part>" is refused by denyCommands rule "<rule>"`.

`askCommands` rules are matched the same way, after every deny check has passed
(precedence above). The reason is `part "<part>" matches askCommands rule
"<rule>"`, and the verdict's `value` is the whole command of the call: that is
what a person is asked about and what a one-time permission (`findGrant`) covers.
Inline code (below) asks while `askCommands` is set, with the rule `inline code`:
what it runs cannot be matched (ADR 0025 D3).

## Inline code

Refused whatever the rules say, but only when the profile has at least one
`denyCommands` rule and no `askCommands` rule (an empty profile means no
checking). When `askCommands` is set, inline code asks instead, because what it
runs cannot be matched. The refusal reason is
`part "<part>" runs inline code (<form>); it is refused while denyCommands is set`.

| form | seen as |
|---|---|
| `bash -c`, `sh -c`, `zsh -c`, `dash -c` | the command name and a single-dash argument with the letter `c` (`-lc` too) |
| `python -c`, `python3 -c` | the command name and a single-dash argument with `c` |
| `node -e`, `bun -e`, `osascript -e` | the command name and a single-dash argument with `e` |
| `find … -exec`, `-execdir`, `-ok`, `-okdir` | the command name `find` and such an argument |
| `xargs` | the command name |
| `eval` | the command name |
| `` `…` ``, `$(…)`, `<(…)`, `>(…)` | in the command text outside single quotes (also inside double quotes) |

## Access levels

`withAccessLevel(profile, level)` composes a chat's level into its profile. It
first tightens the profile with `defaultAccess()`, then sets `level` and, for
`plan`, `readOnly: true`. `match` then adds the level's asks after every deny
and after the profile's own asks:

| level | write inside the working directory | write outside it | command not known to only read |
|---|---|---|---|
| `plan` | asks | as `readOnly` says today | asks |
| `ask` | asks | asks | asks |
| `edits` | no level ask | asks | asks |
| `full` | no level ask | no level ask | no level ask |

A deny wins at every level, and an `alwaysAllow` entry lifts a level's ask for
its exact call and working directory. The level never loosens a `readOnly`
profile: a repository chat in its main clone stays read-only at `edits` and
`full` until its worktree exists, and `plan` at `full` is still read-only.

## Read-only commands

`isReadOnlyCommand` decides whether a `bash` command only reads, for a `readOnly`
working directory and for the read side of `readPaths`. Every part must be
known to read. `cd <dir>` is a reading part; the path rules below read the
relative words after a plain top-level `cd` against its target (see
**Directory**). Known reading programs include
`ls`, `cat`, `head`, `tail`, `wc`, `grep`, `rg`, `pwd`, `stat`, `file`, `du`,
`tree`, `which`, `true`, `cd`, `echo`, `printf`, `sort`, `uniq`, `cut`, `tr`,
`basename`, `dirname`, `realpath`, `readlink`, `date`, `env` with no arguments,
`jq`, `diff`, `cmp`, `find`, `sed -n <range>p`, `git` read verbs, `bun test` and
`bunx tsc --noEmit`; `printf -v`, `sort -o` or `--compress-program`, `date -s`,
`jq -i` and the other writing options are refused. A redirection that writes
nowhere (`>/dev/null`,
`2>/dev/null`, `&>/dev/null`, `2>&1`, `1>&2`) is allowed; any other redirection,
a substitution or inline code makes the command not read-only. Anything else is
not read-only, and the path rules still apply to every part, a `cd` target
included.

## Paths

For `bash`, every word of every part is a candidate, the command name
included. A word is path-like when it contains `/` or starts with `~` or `.`.
Two readings are tried: the word with a leading redirect (`>`, `>>`, `<`,
`2>`, `&>`) removed, and the text after the first `=` of that word
(`--out=/x`). Each path-like reading is normalised:

| step | rule |
|---|---|
| `~` | `~` and `~/…` become the home directory; `~name` is left as it is |
| relative | joined to `cwd` |
| `.` and `..` | resolved, so `a/../../x` leaves `cwd`; `..` above `/` stays at `/` |
| trailing `/` | removed |

A `denyPaths` entry is normalised the same way (so `.git/config` means the
one under `cwd`). A path is refused when it equals an entry or is below it
(`/a/b` is below `/a`; `/ab` is not). The comparison is case-sensitive. The
reason is `path "<path>" is under denyPaths entry "<entry>"`, with the path as
written in the call.

## What it cannot see

Lexical means the file system is never asked. These pass:

- a symlink, hard link or mount that leads into a denied path;
- case differences on a case-insensitive disk;
- shell variables and globs (`$HOME/.ssh`, `~/.s*`), and `~name`;
- a path built by a program the command starts, or read from a file;
- paths in a script the agent wrote and then runs.

The profile is a guard rail, not a boundary (ADR 0025 D6).

## Shell expansion in bash paths

The matcher is a guardrail: where it cannot tell, it asks, and a deny always wins over an ask.

**Expansion.** `~`, `$HOME` and `${HOME}` become the matcher's home before a path word, a redirect target or a `cd` target is matched. Any other expansion in a path or `cd` target (`$OTHER`, `${…}`, `$(…)`, backticks, `<(…)`, `$((…))`, `$1`, `$@`, `~user`, a `$'…'` word with escapes) asks. Only words that look like paths (they hold a `/`, or start with `~` or `.`) are judged, so `cat $OTHER` is not.

**Directory.** Only a plain top-level `cd <path>` in a chain (`&&`, `||`, `;`, `|`) moves the directory the later relative paths are read against; `<path>` is literal or starts with `~`, `$HOME` or `${HOME}`, and `-L`, `-P` and `--` are skipped. Everything else that can change the directory makes it unknown for the rest of the command, and then every later relative path (or command name with a `/`) asks: brace groups `{ }`, subshells `( )`, `if`, `for`, `while`, `until`, `case`, `select`, functions, `eval`, `source` and `.`, `exec`, the `builtin`, `command` and `env` wrappers, `time`, `trap`, `pushd` and `popd` in any form, `cd -`, `cd` with no operand, a `cd` in a pipeline or the background, a `CDPATH` word, and a `cd` target with an unresolved expansion or a glob.

**Globs.** A path word with a glob character (`*`, `?`, `[`, `{`, or an extended glob such as `@(…)`) is judged by the literal text before the first one, not by evaluating the pattern: it is refused when a denied entry starts with that prefix or the prefix starts with a denied entry. A `..` after the glob asks.
