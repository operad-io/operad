# Mutation records — `terminal`

Rows whose mutation broke code in `packages/terminal/`, in the order they were
recorded. The root [MUTATIONS.md](../../MUTATIONS.md) explains the format and
the row fields.

## T-0810 — terminals that serve keeps

| id | file | mutation | failing test |
|---|---|---|---|
| T-0810-M1 | packages/terminal/src/session.ts | a command line ran with `-lc`, not as an interactive login shell | `starting a terminal > runs the command line in the login shell with -ilc, and an empty one opens the shell` |
| T-0810-M2 | packages/terminal/src/session.ts | an empty command line ran `-ilc ""` and not the login shell | `starting a terminal > runs the command line in the login shell with -ilc, and an empty one opens the shell` |
| T-0810-M3 | packages/terminal/src/index.ts | `loginShell` ignored `$SHELL` | `starting a terminal > the login shell is $SHELL, or the system's usual one` |
| T-0810-M4 | packages/terminal/src/folders.ts | any existing directory was accepted as a folder | `starting a terminal > accepts a repository and its worktrees, and no other folder` |
| T-0810-M5 | packages/terminal/src/folders.ts | a repository's worktrees were not accepted | `starting a terminal > accepts a repository and its worktrees, and no other folder` |
| T-0810-M6 | packages/terminal/src/http.ts | a size had no upper bound | `starting a terminal > refuses a size outside 1 to 1000 and a body without a folder` |
| T-0810-M7 | packages/terminal/src/host.ts | a shell that cannot start was thrown on instead of refused with the reason | `starting a terminal > a shell that cannot start is refused with the reason, and nothing is listed` |
| T-0810-M8 | packages/terminal/src/host.ts | every loaded harness was offered as a preset | `starting a terminal > offers the loaded agents as command lines` |
| T-0810-M9 | packages/terminal/src/session.ts | output was not passed to the readers | `starting a terminal > runs the command in the folder, passes output on, and takes input`, `starting a terminal > resize reaches the program, the list and the readers` |
| T-0810-M10 | packages/terminal/src/session.ts | input was dropped | `starting a terminal > runs the command in the folder, passes output on, and takes input`, `starting a terminal > resize reaches the program, the list and the readers` |
| T-0810-M11 | packages/terminal/src/session.ts | a resize did not reach the pseudo terminal | `starting a terminal > resize reaches the program, the list and the readers` |
| T-0810-M12 | packages/terminal/src/session.ts | readers were not told of a resize | `starting a terminal > resize reaches the program, the list and the readers` |
| T-0810-M13 | packages/terminal/src/session.ts | a stop signaled only the shell's own process group | `the list > shows each terminal, and close stops everything it started and takes it off`, `serve stops > every terminal ends, and the next serve lists none` |
| T-0810-M14 | packages/terminal/src/host.ts | a closed terminal stayed on the list | `the list > shows each terminal, and close stops everything it started and takes it off`, `the list > an ended terminal stays with its exit code, takes no input, and closes` |
| T-0810-M15 | packages/terminal/src/session.ts | the exit code was not kept | `the list > an ended terminal stays with its exit code, takes no input, and closes` |
| T-0810-M16 | packages/terminal/src/host.ts | an ended terminal took input and a size | `the list > an ended terminal stays with its exit code, takes no input, and closes` |
| T-0810-M17 | packages/terminal/src/host.ts | a stream naming a missing terminal was told nothing | `the list > a stream naming a terminal that is not there is told it is closed` |
| T-0810-M18 | packages/terminal/src/host.ts | streams were not told that the list changed | `the list > a stream is told when the list changes`, `clients come and go > with no reader the headless terminal answers a program's question` |
| T-0810-M19 | packages/terminal/src/host.ts | a client that disconnected closed the terminals it read | `clients come and go > a terminal keeps running when its client disconnects` |
| T-0810-M20 | packages/terminal/src/session.ts | a joining reader got no screen, only what follows | `starting a terminal > runs the command line in the login shell with -ilc, and an empty one opens the shell`, `clients come and go > a client that reconnects gets the screen first, then only what follows` |
| T-0810-M21 | packages/terminal/src/session.ts | a joining reader read output before its screen | `clients come and go > a client that reconnects gets the screen first, then only what follows`, `a client that is joining when the terminal closes > is told it closed` |
| T-0810-M22 | packages/terminal/src/session.ts | the scrollback cap was 1000 lines | `clients come and go > the replayed scrollback is capped at 5000 lines` |
| T-0810-M23 | packages/terminal/src/session.ts | output was passed on as it came, cut inside an escape sequence | `clients come and go > a client that joins in the middle of a sequence or a character gets it whole` |
| T-0810-M24 | packages/terminal/src/session.ts | each piece of output was decoded alone, cutting characters | `clients come and go > a client that joins in the middle of a sequence or a character gets it whole` |
| T-0810-M25 | packages/terminal/src/escape.ts | a string sequence ended at its first ESC | `where output may be cut > an unfinished sequence at the end is held` |
| T-0810-M26 | packages/terminal/src/escape.ts | a sequence of any length was held | `where output may be cut > a sequence longer than the limit is passed on` |
| T-0810-M27 | packages/terminal/src/session.ts | nobody answered a program's question while no client read | `clients come and go > with no reader the headless terminal answers a program's question` |
| T-0810-M28 | packages/terminal/src/session.ts | serve answered a question also while a client read | `clients come and go > with a reader the reader answers, and serve stays quiet` |
| T-0810-M29 | packages/terminal/src/session.ts | a reader still joining was not told that the terminal closed | `a client that is joining when the terminal closes > is told it closed` |
| T-0810-M30 | packages/terminal/src/http.ts | a change from another address was carried out | `this machine only > a request from another address may read the list and nothing else`, `this machine only > a start from another address starts nothing` |
| T-0810-M31 | packages/terminal/src/http.ts | a screen was sent to another address | `this machine only > a request from another address may read the list and nothing else` |
| T-0810-M32 | packages/terminal/src/http.ts | reading the list was refused from another address | `this machine only > a request from another address may read the list and nothing else`, `this machine only > a start from another address starts nothing` |
| T-0810-M33 | packages/terminal/src/host.ts | serve stopping left its terminals running | `serve stops > every terminal ends, and the next serve lists none` |
| T-0810-M34 | packages/terminal/src/session.ts | a released folder gave no reason | `a removed folder > releasing a worktree stops its terminals, and they say why`, `a removed folder > dev's cleanup stops a task worktree's terminals before it removes the worktree` |
| T-0810-M35 | packages/terminal/src/host.ts | removed folders were not looked for | `a removed folder > a worktree removed by anything else is noticed and its terminals stopped`, `a removed folder > a folder removed and made again is not the folder the terminal started in` |
| T-0810-M36 | packages/terminal/src/session.ts | a folder removed and made again counted as the same one | `a removed folder > a folder removed and made again is not the folder the terminal started in` |
| T-0810-M37 | packages/terminal/src/host.ts | a group named at the start was ignored | `groups > take terminals of any folder, one group for each, at the start or after`, `groups > stay when their terminals end, and over a serve restart` |
| T-0810-M38 | packages/terminal/src/host.ts | an unknown group was accepted at the start | `groups > take terminals of any folder, one group for each, at the start or after` |
| T-0810-M39 | packages/terminal/src/host.ts | putting a terminal in a group changed nothing | `groups > take terminals of any folder, one group for each, at the start or after` |
| T-0810-M40 | packages/terminal/src/host.ts | a rename kept the old name | `groups > are created, renamed and deleted` |
| T-0810-M41 | packages/terminal/src/host.ts | deleting a group stopped its terminals | `groups > deleting a group leaves its terminals running, in no group` |
| T-0810-M42 | packages/terminal/src/host.ts | a deleted group stayed on its terminals | `groups > deleting a group leaves its terminals running, in no group` |
| T-0810-M43 | packages/terminal/src/host.ts | a group was not removed from the store | `groups > are created, renamed and deleted` |
| T-0810-M44 | packages/terminal/src/host.ts | groups were not written to the store | `groups > are created, renamed and deleted`, `groups > take terminals of any folder, one group for each, at the start or after` |

## T-0810 — what the plugin list says terminal gives

| id | file | mutation | failing test |
|---|---|---|---|
| T-0810-M69 | packages/terminal/package.json | the package's description was written about operad, not about what the plugin gives | `plugin descriptions > every shipped plugin's package says in one line what it gives`, `plugin descriptions > a plugin installed on enable is described before its package is there, in the package's words` |

## T-0817 — what the reviews of the terminal tasks found

| id | file | mutation | failing test |
|---|---|---|---|
| T-0817-M9 | packages/terminal/src/session.ts | an ended terminal dropped its folder hold while processes still ran | `what an ended terminal left running > is stopped when its folder is released` |
| T-0817-M10 | packages/terminal/src/session.ts | stopping an ended terminal did nothing | `what an ended terminal left running > is stopped when the terminal is closed`, `what an ended terminal left running > is stopped when serve stops` |
| T-0817-M11 | packages/terminal/src/session.ts | the folder of an ended terminal was not looked at | `what an ended terminal left running > is stopped when its folder is removed by anything else` |
| T-0817-M12 | packages/terminal/src/queue.ts | the screen was given any amount of output at once | `the order of output through a slow terminal > gives the terminal only so much at a time, and keeps work in its place` |
| T-0817-M13 | packages/terminal/src/queue.ts | work was left out with the output | `the order of output through a slow terminal > when too much waits, leaves out the oldest whole pieces and no work, saying so once` |
| T-0817-M14 | packages/terminal/src/queue.ts | the newest piece was left out too | `the order of output through a slow terminal > keeps the newest piece even when it is over the limit alone` |
| T-0817-M15 | packages/terminal/src/queue.ts | each piece left out was logged | `the order of output through a slow terminal > when too much waits, leaves out the oldest whole pieces and no work, saying so once` |
| T-0817-M17 | packages/terminal/src/replay.ts | a hidden cursor was not replayed | `a replayed screen > keeps the cursor hidden, and only when it was` |
| T-0817-M18 | packages/terminal/src/replay.ts | the scrolling lines were not replayed | `a replayed screen > scrolls the same lines, with the cursor where it was` |
| T-0817-M19 | packages/terminal/src/replay.ts | the cursor's row ignored origin mode | `a replayed screen > keeps the cursor where it was when rows count from the lines that scroll` |
| T-0817-M20 | packages/terminal/src/session.ts | every reader was told to answer | `several readers > one is told to answer the program, and the next when it leaves` |
| T-0817-M21 | packages/terminal/src/session.ts | no reader was told to answer when the first left | `several readers > one is told to answer the program, and the next when it leaves` |
| T-0817-M22 | packages/terminal/src/host.ts | a preset ignored the harness's command | `starting a terminal > offers the loaded agents as command lines` |
| T-0817-M26 | packages/terminal/src/index.ts | the plugin did not say it starts without trigger rules | `serve without trigger rules > still serves terminals` |

## T-0831 — review findings of the offered shipped plugins

| id | file | mutation | failing test |
|---|---|---|---|
| T-0831-M8 | packages/terminal/src/host.ts | the terminal kept the first answer about agents | `starting a terminal > offers an agent installed while it runs` |
