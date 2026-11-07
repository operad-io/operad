# Mutation records — `access-match`

Rows whose mutation broke code in `packages/access-match/`, in the order they
were recorded. The root [MUTATIONS.md](../../MUTATIONS.md) explains the format
and the row fields.

| id | file | mutation | failing test |
|---|---|---|---|
| T-0025-M9 | `packages/access-match/src/index.ts` | a command grant covered any call that began with its value | `a grant covers the call that equals its value exactly` |
| T-0025-M16 | `packages/access-match/src/index.ts` | a path grant covered every path tool | `a path grant covers the tool the person approved and no other` |
