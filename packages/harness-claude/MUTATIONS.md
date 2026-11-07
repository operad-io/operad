# Mutation records — `harness-claude`

Rows whose mutation broke code in `packages/harness-claude/` or the install
setup it depends on, in the order they were recorded. The root
[MUTATIONS.md](../../MUTATIONS.md) explains the format and the row fields.

| id | file | mutation | failing test |
|---|---|---|---|
| T-0037-M1 | package.json | one platform override pointed at the real package instead of `empty-npm-package` | `the root overrides name all eight platform packages` |
| T-0037-M2 | bun.lock | one platform entry resolved to the real package | `bun.lock resolves every platform package to the empty package` |
| T-0037-M3 | node_modules/.bun | a 200 KB `claude` file placed in a platform package directory | `after an install no platform package holds more than a stub` |
| T-0037-M4 | packages/harness-claude/spike/probe.ts | `findClaude` returned `"claude"` instead of throwing when none is on PATH | `with no claude on PATH it fails with a message that says what to do` |
| T-0037-M5 | packages/harness-claude/package.json | SDK range `^0.3.319` made exact | `the SDK is a range, not an exact version` |
