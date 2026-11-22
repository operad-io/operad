# ADR 0039: Where a Repository Works

Status: accepted

## Background

A project that wants one agent in its own folder should not first have to learn worktrees, branches and merging, while a project with several agents needs a worktree for each task. The same flow, checks and merge serve both; what differs is where the task's changes are made.

## Decisions

### D1: `workIn` says where a repository's work is done

`workIn` is a setting of `.operad/dev.json` with a JSON Schema in the `dev` package; its title is "Work in" (工作位置). It has two values:

- `branch`, "A branch in this folder" (本目录的新分支): `dev` makes the task's branch in the main clone, switches the clone to it, and the task works there.
- `worktree`, "A separate worktree" (独立的 worktree): each task has its own worktree, as before this setting existed. It is the value of a repository that does not set it.

The two values change only where the task's changes are made. Flows, checks, review, integrate and the gate worktree work the same in both (ADR 0020 D3, D4). Chats follow ADR 0028 D3.

These decisions take effect as the work that builds them lands; until then every repository behaves as `worktree` does.

### D2: `branch` runs one task at a time, and `concurrency` 2 or more is refused

A repository with `workIn` `branch` has `concurrency` 1. Setting `concurrency` to 2 or more while `workIn` is `branch` is refused, as is a pool whose workers add up to more than 1; the refusal says which setting to change, and a settings save is refused the same way. The repository's cap on running tasks is 1 in `branch` mode. The `pool` plugin stays required in both modes; a task takes its place in a pool as ADR 0021 says.

### D3: In `branch` mode a task that has not ended holds the main clone

A task holds the main clone's slot from the start of its first attempt until it is merged, cancelled or rejected. A task that is waiting for a person, ready to merge or paused still holds it, so a second task does not start meanwhile and the chat of the repository is read-only (ADR 0028 D3). In `worktree` mode such a task does not hold a slot, as before.

### D4: A task does not start in a main clone with uncommitted changes

In `branch` mode a task refuses to start when the main clone has uncommitted changes, and the refusal names the files. The task's start records the branch the clone was on, and the end of the task switches back to it.

### D5: A rejected or cancelled task's branch is kept

When a `branch` task is rejected or cancelled, `dev` switches the main clone back to the branch it started on and keeps the task branch, as a `worktree` task's branch is kept. The main clone's other files are not touched.

### D6: `dev.json` is read once at the start of an attempt

`dev` reads `.operad/dev.json` once when an attempt starts and records what it read; the attempt uses the record and does not read the file again. In `branch` mode the main clone is on the task branch while the attempt runs, so a second read would give the task branch's version of the file; the record keeps the attempt on one configuration.
