# Mutation records

A mutation check breaks the new code once by hand, runs the tests, names the
test that fails, and restores the code. Record each check in the `MUTATIONS.md`
of the package whose code the mutation broke, using this row format:

```
| id | file | mutation | failing test |
|---|---|---|---|
| TK0001-M1 | packages/<name>/src/... | what was broken | `the test that failed` |
```

A row's id is the arc task id followed by `-M` and a number starting at 1 for
each task: `TK0001-M1`.

## Package records

- [cli](packages/cli/MUTATIONS.md)
- [dev](packages/dev/MUTATIONS.md)
- [engine](packages/engine/MUTATIONS.md)
- [harness-pi](packages/harness-pi/MUTATIONS.md)
- [harness-radian](packages/harness-radian/MUTATIONS.md)
- [shell](packages/shell/MUTATIONS.md)
- [source-cron](packages/source-cron/MUTATIONS.md)
