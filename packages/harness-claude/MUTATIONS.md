# Mutation records — `harness-claude`

Rows whose mutation broke code in `packages/harness-claude/`, in the order
they were recorded. The root [MUTATIONS.md](../../MUTATIONS.md) explains the
format and the row fields.

| id | file | mutation | failing test |
|---|---|---|---|
| T-0037-M1 | packages/harness-claude/test/platform-packages.test.ts | inverted the `empty-npm-package` name check, so the real placeholders were reported as platform packages | `every installed Claude Agent SDK platform package is an empty placeholder` |
