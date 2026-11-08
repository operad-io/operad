# Mutation records — `access-match`

Rows whose mutation broke code in `packages/access-match/`, in the order they
were recorded. The root [MUTATIONS.md](../../MUTATIONS.md) explains the format
and the row fields.

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
