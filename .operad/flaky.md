A test that failed and then passed on rerun is a bug until shown otherwise.
Never raise a timeout or add a retry inside a test to make it pass.

Only a task that fixes a flaky test runs `scripts/stress.sh`, and it runs it
twice: once to reproduce before the fix and once to confirm after it. Every
other task's check is `bash scripts/check-changed.sh`: the packages the change
touches and the packages that load them. The full `bash scripts/verify.sh` runs
once more at integration, before merge.

Size a stress run by time, not by a fixed count: time one run of the file
alone, then choose `--runs` so the stress run takes about ten minutes, at least
20 runs and at most 200, with `--load 2`. The task is done when that run
passes; its final answer states the command, the number of runs and the result
before and after the fix.

A stress run takes a lock shared by every stress run on the machine (all
worktrees), so it may wait for another run to end; it prints which run holds
the lock while it waits. The wait is not part of its result: size and judge the
run by its own time and counts. `--no-lock` skips the lock only for a run that
knows it is alone.

Run one stress run at a time, in the foreground: never two at once, never in
the background, never left running when the task ends.

A failure seen only while the machine was overloaded (load average far above
the number of cores) is not yet a flaky test. Note the load, and reproduce it
with a stress run before you change anything.
