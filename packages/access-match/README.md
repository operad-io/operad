# @operad-io/access-match

The access profile matcher. `match(profile, call)` says whether one tool call
may run under the `denyPaths`, `denyCommands` and `askCommands` of an access profile
(`docs/backlog/operad-sandbox.md` decisions 1 and 4,
`docs/backlog/operad-harness-pi.md` decision 7). Harnesses call it in their
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
is allowed. A caller that does not know `ask` sees `allow: false` and refuses,
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
| `readPaths` | array of paths, optional | directories the agent may read although `denyPaths` covers an ancestor: a read tool (`read`, `grep`, `find`, `ls`) or a `bash` command that only reads may touch a path under one. A write there asks (the entries count as `askPaths`); every other denied path stays denied |
| `allowMcp` | string[], optional | MCP tools that run without asking, as `<server>.<tool>` or `<server>.*`. The field's presence (even empty) puts MCP tools under the profile: a call with `tool: "mcp"` and `input: { server, tool }` that is not listed counts as a write and asks (`kind: "command"`, value `mcp <server>.<tool>`), per `operad-sandbox.md` decision 9 |
| `askCommands` | string[], optional | rules in the shape of `denyCommands`; a `bash` command part that matches one of these asks a person (`operad-sandbox.md` decisions 1 and 3). Writes to shell profiles are `askPaths` |

| `grants` | `{ waitId, kind: "command" \| "path", value, tool? }[]`, optional | one-time permissions not yet used; see `findGrant` |

`findGrant(profile, call)` returns the grant that covers a call, or `undefined`:
a `command` grant covers a `bash` call whose command equals `value` character
for character, a `path` grant a call of the one `tool` it names (not another path tool) on the same file; a path grant without a `tool` covers nothing. It is
pure. The caller must use the grant up (the engine writes `grant_used`) before it
lets the call run, and match the call as usual when it cannot.

Other fields of the access profile (`cwd`, `outside`, `network`) are not read
here. `readProfile(value)` checks an untrusted object
and names the field at fault.

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
what it runs cannot be matched (`operad-sandbox.md` decision 4).

## Inline code

Refused whatever the rules say, but only when the profile has at least one
`denyCommands` rule (an empty profile means no checking). The reason is
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

The profile is a guard rail, not a boundary (`operad-sandbox.md` decision 7).

## Shell expansion in bash paths

The matcher is a guardrail: where it cannot tell, it asks, and a deny always wins over an ask.

**Expansion.** `~`, `$HOME` and `${HOME}` become the matcher's home before a path word, a redirect target or a `cd` target is matched. Any other expansion in a path or `cd` target (`$OTHER`, `${…}`, `$(…)`, backticks, `<(…)`, `$((…))`, `$1`, `$@`, `~user`, a `$'…'` word with escapes) asks. Only words that look like paths (they hold a `/`, or start with `~` or `.`) are judged, so `cat $OTHER` is not.

**Directory.** Only a plain top-level `cd <path>` in a chain (`&&`, `||`, `;`, `|`) moves the directory the later relative paths are read against; `<path>` is literal or starts with `~`, `$HOME` or `${HOME}`, and `-L`, `-P` and `--` are skipped. Everything else that can change the directory makes it unknown for the rest of the command, and then every later relative path (or command name with a `/`) asks: brace groups `{ }`, subshells `( )`, `if`, `for`, `while`, `until`, `case`, `select`, functions, `eval`, `source` and `.`, `exec`, the `builtin`, `command` and `env` wrappers, `time`, `trap`, `pushd` and `popd` in any form, `cd -`, `cd` with no operand, a `cd` in a pipeline or the background, a `CDPATH` word, and a `cd` target with an unresolved expansion or a glob.

**Globs.** A path word with a glob character (`*`, `?`, `[`, `{`, or an extended glob such as `@(…)`) is judged by the literal text before the first one, not by evaluating the pattern: it is refused when a denied entry starts with that prefix or the prefix starts with a denied entry. A `..` after the glob asks.
