# Mutation records — `access-match`

Rows whose mutation broke code in `packages/access-match/`, in the order they
were recorded. The root [MUTATIONS.md](../../MUTATIONS.md) explains the format
and the row fields.

| id | file | mutation | failing test |
|---|---|---|---|
| T-0025-M9 | `packages/access-match/src/index.ts` | a command grant covered any call that began with its value | `a grant covers the call that equals its value exactly` |
| T-0025-M16 | `packages/access-match/src/index.ts` | a path grant covered every path tool | `a path grant covers the tool the person approved and no other` |
| T-0063-M1 | `packages/access-match/src/summary.ts` | a command was cut at 5000 characters instead of 500 | `a bash call summarizes to its command on one line, cut at 500 characters` |
| T-0063-M2 | `packages/access-match/src/summary.ts` | a call the profile refuses was summarized instead of redacted | `a call the profile refuses is redacted, and environment values never show` |
| T-0063-M3 | packages/access-match/src/summary.ts | environment redaction matched uppercase names only | `lowercase environment values never show` |
