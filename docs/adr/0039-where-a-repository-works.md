# ADR 0039: Where a Repository Works

Status: accepted

## Background

A project that wants one agent in its own folder should not first have to learn worktrees, branches and merging, while a project with several agents needs a worktree for each task. The same flow, checks and merge serve both; what differs is where the task's changes are made.

## Decisions

### D1: `workIn` says where a repository's work is done

`workIn` is a setting of `.operad/dev.json` with a JSON Schema in the `dev` package; its title is "Work in" (工作位置). It has two values:

- `branch`, "A branch in this folder" (本目录的新分支): `dev` makes the task's branch in the main clone, switches the clone to it, and the task works there.
- `worktree`, "A separate worktree" (独立的 worktree): each task has its own worktree, as before this setting existed. It is the value of a repository that does not set it.

The two values change only where the task's changes are made. Flows, checks, review, integrate and the gate worktree work the same in both.

These decisions take effect as the work that builds them lands; until then every repository behaves as `worktree` does.

### D2: `branch` runs one task at a time, and `concurrency` 2 or more is refused

A repository with `workIn` `branch` has `concurrency` 1. Setting `concurrency` to 2 or more while `workIn` is `branch` is refused, as is a pool whose workers add up to more than 1; the refusal says which setting to change, and a settings save is refused the same way. The repository's cap on running tasks is 1 in `branch` mode. The `pool` plugin stays required in both modes; a task takes its place in a pool as ADR 0021 says.

### D3: In `branch` mode a task that has not ended holds the main clone

A task whose attempt works in the main clone holds the repository's slot from the start of that attempt until it is merged or cancelled. A task that is waiting for a person, ready to merge, paused, or ready again for its next start still holds it, so a second task does not start meanwhile (the scheduler counts such a task as active, and a ready task that holds the clone does not count against its own start). In `worktree` mode such a task does not hold a slot, as before. A rejection is not an end: it sends the task back to the worker on the same branch, so the task keeps the clone.

The exclusion goes both ways. A task does not start while a reply of a repository chat is being written that can write in the main clone (the chat has no worktree and its access level is `edits` or `full`); the start is refused with a note naming the chat, and a refused start holds nothing. A start that finds no such reply holds the clone from then on, and the replies that begin after it are read-only.

### D4: A task does not start in a main clone with uncommitted changes

In `branch` mode the task's first step refuses to start when the main clone has uncommitted changes, and the refusal names the files; nothing in the clone is moved or changed. Otherwise `dev` records the branch the clone is on, makes or reuses `work/<id>` from the remote's main (merging main into a reused branch) and switches the clone to it; the work runs there. A step that is run again after a crash goes on from the state the clone was left in: on the start branch it switches, on `work/<id>` it continues (leaving edits in the tree to the worker, so main is merged only into a clean tree), and on any other branch than the recorded start it stops and says so. The start is recorded before the clone is switched. The progress note the worker may write is kept out of the clone's status. Work that changes the main clone is by design in this mode, so an attempt in it is not held to the main-checkout rule of the review.

### D5: A cancelled task's branch is kept

When a `branch` task is cancelled, `dev` first stops its run, then switches the main clone back to the branch it started on and keeps the task branch, as a `worktree` task's branch is kept. A clone that has uncommitted changes, or that the person moved to another branch, is left as it is, and the cancel says so in its answer and in the task's changes. The main clone's other files are not touched. A plan's cancel does the same for each of its tasks.

### D6: `dev.json` is read once at the start of an attempt

`dev` reads `.operad/dev.json` once when an attempt starts and records what it read; the attempt uses the record and does not read the file again. In `branch` mode the main clone is on the task branch while the attempt runs, so a second read would give the task branch's version of the file; the record keeps the attempt on one configuration.

For a task whose earlier attempt worked in the main clone, the file `dev` reads when the next attempt starts is the one in the commit of the recorded start branch (`git show <start>:.operad/dev.json`), not the one on the task branch the clone is on; when that commit has no such file, the file in the clone is read. The settings editor refuses to save `dev.json` while a `branch` task holds the clone, and says which task.
