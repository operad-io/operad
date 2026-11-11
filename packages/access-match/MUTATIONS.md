# Mutation records — `access-match`

Rows whose mutation broke code in `packages/access-match/`, in the order they
were recorded. The root [MUTATIONS.md](../../MUTATIONS.md) explains the format
and the row fields.

## TK0015 — pi worker

| id | file | mutation | failing test |
|---|---|---|---|
| TK0017-M1 | packages/access-match/src/command.ts | `\|` removed from the split operators | `split operator "\|" reaches the part after it` |
| TK0017-M2 | packages/access-match/src/index.ts | relative paths joined to `cwd` without resolving `..` | `~ is expanded, relative paths are joined to cwd, and .. is resolved` |
| TK0017-M4 | packages/access-match/src/command.ts | `xargs` and `eval` not seen as inline code | `inline code xargs is refused though no rule names it` |

| id | file | mutation | failing test |
|---|---|---|---|
| T-0025-M9 | `packages/access-match/src/index.ts` | a command grant covered any call that began with its value | `a grant covers the call that equals its value exactly` |
| T-0025-M16 | `packages/access-match/src/index.ts` | a path grant covered every path tool | `a path grant covers the tool the person approved and no other` |
| T-0063-M1 | `packages/access-match/src/summary.ts` | a command was cut at 5000 characters instead of 500 | `a bash call summarizes to its command on one line, cut at 500 characters` |
| T-0063-M2 | `packages/access-match/src/summary.ts` | a call the profile denies showed its argument instead of saying it was denied | `a call the profile denies is logged as denied, never its arguments or reason` |
| T-0063-M3 | `packages/access-match/src/summary.ts` | secret values were not masked by value | `bash command: env secret by value` |
| T-0063-M4 | `packages/access-match/src/summary.ts` | the minimum length of an environment secret was 1 instead of 6 | `bash command: env secret under 6 characters stays` |
| T-0063-M5 | `packages/access-match/src/summary.ts` | a leading assignment with a substitution was shown instead of withheld | `bash command: command substitution` |
| T-0063-M6 | `packages/access-match/src/summary.ts` | the shell-word reader took an unbalanced quote as readable | `bash command: unbalanced single quote` |
| T-0063-M10 | `packages/access-match/src/summary.ts` | `firstErrorLine` skipped the secret-value masking | `an error line masks secret values, from the store and from the environment` |
| T-0063-M11 | `packages/access-match/src/summary.ts` | a denied call dropped the rule name | `a call the profile denies is logged as denied, never its arguments or reason` |
| T-0187-M1 | packages/access-match/src/index.ts | `askCommands` was checked before the deny rules, so an ask won over a deny | `deny wins over ask, and ask wins over allow` |
| T-0187-M2 | packages/access-match/src/index.ts | inline code (`$(…)`) did not ask while `askCommands` was set | `inline code asks while askCommands is set and is allowed without it` |
| T-0187-M12 | packages/access-match/src/index.ts | `write` and `edit` calls were not judged against `askPaths` | `a write or edit to an askPaths path asks with the path and the tool` |
| T-0188-M8 | packages/access-match/src/index.ts | readOnly no longer made writes in the working directory ask | `a read-only working directory asks about a write under it, and only a write` |
| T-0188-M21 | packages/access-match/src/readonly.ts | a command with an output redirect (`>`, `>>`, `&>`) counted as read-only | `everything else is not read-only: redirects, tee, sed -i, cp, mv, git writes, a pipeline whose last stage writes` |
| T-0188-M22 | packages/access-match/src/index.ts | a read-only directory no longer asked about a command that is not on the allowlist | `a read-only directory asks about a command that is not on the allowlist, and lets a reading one run` |

## T-0240 — a log keeps a command's lines

| id | file | mutation | failing test |
|---|---|---|---|
| T-0240-M7 | packages/access-match/src/summary.ts | `keepLines` was ignored, so a command was flattened to one line | `a bash call keeps its lines when the log asks for them, still cut at 500 characters` |
