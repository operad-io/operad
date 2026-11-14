# Mutation records — `cli`

Rows whose mutation broke code in `packages/cli/`, in the order they were
recorded. The root [MUTATIONS.md](../../MUTATIONS.md) explains the format and
the row fields.

## T-0020 — pairing, links and the notification hook

| id | file | mutation | failing test |
|---|---|---|---|
| T-0020-M5 | packages/cli/src/qr.ts | the format bits lost their `0x5412` mask | `qr encoder > the format bits for level M match the standard's table` |
| T-0020-M6 | packages/cli/src/qr.ts | version 8's block layout became four equal blocks | `qr encoder > every version round-trips at its capacity, and the next byte needs the next version` |
| T-0020-M7 | packages/cli/src/main.ts | `pair` stopped refusing a non-terminal without `--show-token` | `operad pair > refuses without a terminal and prints nothing of the token` |
| TK0008-M10 | `packages/cli/src/main.ts` | a typed history id resolved an object type no plugin declares | `operad command > history does not resolve an object type no plugin declares` |

| id | file | mutation | failing test |
|---|---|---|---|
| TK0016-M13 | packages/cli/src/main.ts | dropped the ambiguity check for an untyped object id | `operad command > history resolves a plugin object without mixing object types` |
| TK0016-M14 | packages/cli/src/main.ts | accepted arguments to `serve` | `operad command > serve rejects arguments as a usage error` |
| TK0025-M7 | packages/cli/src/main.ts | printed pending actions with `/` instead of `:` | `operad presentation commands > pending lists actions as plugin:action` |
| TK0025-M8 | packages/cli/src/main.ts | stopped colouring the two kernel flags | `operad presentation commands > colours follow only waiting and running` |
| TK0025-M10 | packages/cli/src/markdown.ts | made `renderMarkdown` ignore its `colour` option and always return plain text | `operad presentation commands > show styles Markdown for a terminal and stays plain otherwise` |
| TK0028-M12 | packages/cli/src/main.ts | restored the id-shaped-value heuristic in the action flag parser | `operad presentation commands > schema flags accept values that look like ids or negative numbers` |
| TK0029-M8 | packages/cli/src/main.ts | imported a disabled plugin while listing plugins | `operad command > plugin list does not import a disabled plugin` |
| TK0027-M6 | packages/cli/src/main.ts | printed `user` as the origin of every rule in the listing | `operad trigger rules > lists each rule with where it came from` |
| TK0024-M4 | packages/cli/src/main.ts | skipped resolving a scoped object id before reading history, so a task keyed by its repository had no run | `dogfood end to end > a task survives a killed run and reaches a merge with a history of every step` |
| TK0024-M6 | packages/cli/src/main.ts | wrote an internal word into the loop's own output | `dogfood end to end > a task survives a killed run and reaches a merge with a history of every step` |
| TK0024-M7 | packages/cli/src/main.ts | wrote an internal word into a `pending --json` page | `dogfood end to end > a task survives a killed run and reaches a merge with a history of every step` |
| TK0024-M8 | packages/cli/test/e2e.test.ts | installed no store watcher, so the wait only looked once instead of on each change | `dogfood end to end > a task survives a killed run and reaches a merge with a history of every step` |
| engine-followups-2-M3 | `packages/cli/src/main.ts` | a kernel action got the arguments with `--repo` still in them | `operad trigger > start and dismiss take --repo without counting it as an argument` |
| T-0026-M27 | packages/cli/src/main.ts | removed the `mcp` command branch, so `operad mcp` fell through to the action path | `initializes, lists the table and reads every tool on fixture objects` |
| T-0024-M15 | `packages/cli/src/main.ts` | the runner was not given `ask.graceSecs` from config.json | `ask.graceSecs in config.json > a grace of 0 sends the question to the person at once` |
| T-0030-M7 | packages/cli/src/main.ts | `tui --url` dropped the URL instead of handing it to the app | `operad tui > passes the url and token to the terminal app` |
| T-0030-M8 | packages/cli/src/main.ts | `tui` no longer refused a non-terminal without a runner | `operad tui > needs a terminal unless a runner is injected` |
| T-0028-M7 | packages/cli/src/main.ts | `mcp` enabled the channel whether or not `--claude-channel` was given | `without the flag there is no capability and no notification` |
| tui-autostart-M12 | packages/cli/src/main.ts | `--no-start` was not passed to the app | `operad tui > --no-start is passed on, and the app gets this process's entry and a way to print` |
| tui-autostart-M14 | packages/cli/src/main.ts | `serve` no longer checked the home lock before opening the HTTP port (superseded by M15: the lock is now taken first) | `operad command > exit codes: 1 unknown id, 2 usage, 4 lock held` |
| tui-autostart-M15 | packages/cli/src/main.ts | `serve` opened the config and store before it took the home lock, so a held home failed on the config, not with exit 4 | `a second operad serve > exits 4 on a held home before it reads the config, the store or the port` |
| serve-stop-M1 | packages/cli/src/serve-stop.ts | the command-line check was skipped, so a live process that is not a serve was signalled | `operad serve stop > refuses a live process that is not a serve, and never signals it` |
| serve-stop-M2 | packages/cli/src/serve-stop.ts | the command-line check matched `serve` anywhere in the text, not as a word | `operad serve stop > the command-line check wants serve as a word` |
| serve-stop-M3 | packages/cli/src/serve-stop.ts | a lock naming a dead process went on to the stop path | `operad serve stop > a stale lock: says so, exits 0, signals nothing and leaves the file` |
| serve-stop-M4 | packages/cli/src/serve-stop.ts | a serve still running after the timeout printed `stopped` | `operad serve stop > --timeout: a serve that ignores SIGTERM is an error that says how to force it` |
| serve-stop-M5 | packages/cli/src/serve-stop.ts | `--timeout 0` was accepted | `operad serve stop > --timeout takes a whole number of seconds, at least 1` |
| serve-stop-M6 | packages/cli/src/serve-stop.ts | the signal was SIGKILL, not SIGTERM | `operad serve stop > stops a real serve: the lock is gone and the process has exited`, `--timeout: a serve that ignores SIGTERM is an error that says how to force it` |
| pending-row-M7 | packages/cli/src/main.ts | `operad pending` did not print the row's title | `operad pending shows the object's title > a line with the title, the rest unchanged, and the row in --json` |

## T-0068 — `operad running` line

| id | file | mutation | failing test |
|---|---|---|---|
| T-0068-M1 | packages/cli/src/main.ts | the step time column showed the run age | `operad running line > object, step, step time, title, then the run age` |
| T-0048-M7 | packages/cli/src/main.ts | the hidden line printed only above 99 hidden rows | `operad presentation commands > list applies the default filter, --filter all shows everything, and a hidden line counts the rest` |
| T-0048-M8 | packages/cli/src/main.ts | `operad list` ignored the type's default filter | `operad presentation commands > list applies the default filter, --filter all shows everything, and a hidden line counts the rest` |
| T-0048-M9 | packages/cli/src/main.ts | the printed `next:` command dropped the `--where` predicates | `operad presentation commands > list filters on indexed fields and pages with --limit and --cursor` |
| T-0048-M10 | packages/cli/src/main.ts | the printed `next:` command left the `--repo` value unquoted | `operad presentation commands > the printed next: command shell-quotes the repo value` |
| serve-views-home-M1 | packages/cli/src/main.ts | serve opened its views in the directory it started in, so a bare id was scoped to that repository | `operad serve http > serve resolves ids from no directory: a bare id is not scoped to where serve started` |
| T-0052-M9 | packages/cli/src/main.ts | `list --root` was not passed to the views | `operad list hierarchy > --root and --parent list one level; show prints the parent` |
| T-0052-M10 | packages/cli/src/main.ts | `show` did not print the parent line | `operad list hierarchy > --root and --parent list one level; show prints the parent` |
| T-0052-M11 | packages/cli/src/main.ts | `list --parent` was not passed to the views | `operad list hierarchy > --root and --parent list one level; show prints the parent` |
| T-0077-M1 | packages/cli/src/main.ts | serve killed every run process it had started (SIGKILL) when it stopped, so the sentinel of the running check stopped its line | `a serve restart while a check runs > the check's command is not signalled and finishes with its exit code` |
| T-0096-M8 | packages/cli/src/main.ts | `operad flows` left the reason off the flow line | `operad command > flows shows a flow that cannot start, and why, on its line` |
| T-0079-M4 | packages/cli/src/main.ts | `show` passed the terminal width even when stdout was a pipe | `operad presentation commands > show lays a table out for the terminal's width; a pipe keeps the old output` |
| T-0098-M1 | packages/cli/src/code-reload.ts | `loadsAsWellAs` accepted any problem | `a serve picks up changed code > code that does not load leaves the old code running; fixing it reloads` |
| T-0098-M2 | packages/cli/src/code-reload.ts | a run's process did not wait out code that does not load | `a serve picks up changed code > code that does not load leaves the old code running; fixing it reloads` |
| T-0098-M3 | packages/cli/src/code-reload.ts | the wait ignored the settings files | `a serve picks up changed code > a settings file that does not read during a change is read again when it is fixed` |
| T-0098-M4 | packages/cli/src/main.ts | serve did not start again after it stopped for new code | `a serve picks up changed code > a running step finishes on the old code; the next step runs the new code` |
| T-0098-M5 | packages/cli/src/code-reload.ts | `problemKey` keyed a problem by its plugin name again, so a failure the running plugin logged matched a failed import | `what counts as loading > a problem is the same one only when it says the same thing` |
| T-0098-M6 | packages/cli/src/code-reload.ts | the supervisor ended with the child's reload exit code instead of starting the serve again | `a serve picks up changed code > a running step finishes on the old code; the next step runs the new code` |
| T-0098-M7 | packages/cli/src/main.ts | a serve that stopped for new code exited 0 instead of handing the restart to its supervisor | `a serve picks up changed code > a running step finishes on the old code; the next step runs the new code` |
| T-0098-M8 | packages/cli/src/main.ts | a supervised serve handled a stop signal once (`process.once`), so a repeated one ended it by the default action | `a serve picks up changed code > a stop signal that arrives twice after a reload still stops the serve gracefully` (caught in 3 of 4 runs: it depends on signals not being merged) |
| T-0098-M9 | packages/cli/src/main.ts | the serve did not count a triggers.json error at start among the problems it began with | `a serve picks up changed code > a triggers.json that did not read at start does not make code that loads look broken` |
| T-0108-M1 | packages/cli/src/serve-stop.ts | `serve stop` asked `ps` for the serve's command line only once, so an empty answer under load refused with exit 3 | `operad serve stop > a ps that answers nothing for a live serve is asked again, then the serve is stopped` |
| T-0128-M1 | packages/cli/src/code-reload.ts | problemKey kept newlines, so a multi-line known problem never matched its one-line form | `what counts as loading > a message that spans lines is the same problem as its one-line form` |
| T-0132-M1 | packages/cli/src/code-reload.ts | `takeSupervisedFlag` did not delete the flag from the environment | `a serve restart while a check runs > a supervised serve keeps the supervisor's flag from its run process and the commands it runs` |
| T-0132-M2 | packages/cli/test/reload.test.ts | `childEnv` passed the test's own `OPERAD_SERVE_SUPERVISED` on to the serve | `a serve picks up changed code > the same case passes when the test itself runs inside a supervised serve` |
| T-0090-M6 | packages/cli/src/main.ts | `--page` ignored a label and only took a number | `operad presentation commands > show --page prints one page by number or by label` |
| T-0080-M9 | packages/cli/src/main.ts | `settings set` took the value as a string and never parsed JSON | `operad settings > set parses JSON, falls back to a string, and keeps the rest of the file` |
| T-0080-M10 | packages/cli/src/main.ts | `settings set` ignored `--yes` | `operad settings > set refuses an invalid value, a read-only setting and a missing confirmation` |
| T-0080-M11 | packages/cli/src/code-reload.ts | `config.json` was not among the files a serve reloads on, so a changed setting never reached the plugin | `operad settings > a running serve answers GET and POST /v1/settings and sees what the CLI wrote` |
| T-0112-M12 | packages/cli/src/main.ts | an action not offered because its result is already true printed nothing | `operad with the dev plugin > the real binary registers, plans, lists, shows and confirms` |
| T-0127-M1 | packages/cli/src/main.ts | a serve that took over did not retry a failed bind, so the new code failed at once with a plain error | `a reload with two listen addresses > a bind that keeps failing leaves the old code serving both addresses, with one line in the log` |
| T-0127-M2 | packages/cli/src/code-reload.ts | the supervisor ignored the bind-failed exit and left no serve | `a reload with two listen addresses > a bind that keeps failing leaves the old code serving both addresses, with one line in the log` |
| T-0127-M3 | packages/cli/src/http-bind.ts | a wrong configuration was retried like a busy port | `startWithRetry > does not try again a configuration that is wrong` |
| T-0127-M4 | packages/cli/src/http-bind.ts | a reload that could not release its address ended the process without starting a replacement serve | `leaveStuck > a reload that cannot release ends the process, and a new serve starts first` |
| T-0127-M5 | packages/cli/src/http-bind.ts | a supervised serve that could not release ended with code 1, so the supervisor did not start the next one | `leaveStuck > under a supervisor the process ends with the reload code and starts nothing itself` |
| T-0148-M8 | packages/cli/src/main.ts | --page tried a label before a number again | `operad presentation commands > show --page takes a number as a position before a label` |
| T-0148-M10 | packages/cli/src/main.ts | `--page` of the first page read it again instead of reusing the read that gave the pages list | `operad presentation commands > show --page of the first page reads it once; another page costs one more read` |

## T-0205 — a wait backs a directory watch that misses the write

| id | file | mutation | failing test |
|---|---|---|---|
| T-0205-M5 | packages/cli/test/notify-serve.test.ts | `waitForLines` returned to waiting on the directory watch alone, with no 100 ms look | `waiting for a line another process writes > a watch that cannot see the directory is backed by the 100 ms look` (a directory that appears after the first look is never seen) |
| T-0125-M1 | packages/cli/src/main.ts | a write to a closed pipe was not recognised as EPIPE (the catch rethrew and the error event was not handled), so a stack trace reached stderr | `a reader that closes the pipe > list with more rows than the pipe holds: the reader reads one line and closes; status 141, nothing on stderr` |
| T-0208-M22 | packages/cli/src/main.ts | `store` accepted a missing or unknown store kind instead of a usage error | `store copy > it explains itself without internal words` |
| T-0122-M1 | packages/cli/src/main.ts | `show` did not print the object's children | `operad list hierarchy > show prints an object's children as rows between the row and the sections` |
| T-0239-M7 | packages/cli/src/main.ts | `operad running` did not show the queued time | `operad running line > a step that waited for a place shows its queued time after the step time` |
| T-0289-M1 | packages/cli/src/main.ts | `writeStream` wrote with `stream.write` again instead of a synchronous write on the descriptor, so a close during a large write went unseen and the status was 0 | `a reader that closes the pipe > list with more rows than the pipe holds: the reader reads one line and closes; status 141, nothing on stderr` (fails in a share of runs; found with `scripts/stress.sh --runs 20 --load 2`) |

## T-0297 — follow-ups from the flaky-test work

| id | file | mutation | failing test |
|---|---|---|---|
| T-0297-M1 | packages/cli/src/serve-stop.ts | a process that died during the empty `ps` answers was refused as a non-serve instead of reported as no run | `operad serve stop > a process that dies during the empty answers is a lock with no serve, not a refusal` |
| T-0297-M2 | packages/cli/src/serve-stop.ts | an unanswered `ps` was still reported as `is not an operad serve` | `operad serve stop > a ps that never answers for a live process refuses without signalling` |
| T-0297-M3 | packages/cli/src/http-bind.ts | a start whose own address could not be released was retried like a busy port | `startWithRetry > does not try again a start whose own address could not be released` |
| T-0297-M4 | packages/tui/src/autostart.ts | the port-in-use line claimed an operad serve of this home still runs although the home lock was free | `ensureServer > a child that cannot listen because the port is taken says the port is in use` |
| T-0297-M5 | packages/cli/src/http-bind.ts | `takeReplacesFlag` read the replacement flag without deleting it | `takeReplacesFlag > takes the flag from the environment so the replacement does not pass it on` |
| T-0297-M6 | packages/cli/src/http-bind.ts | a serve started as a replacement did not turn on the bind retry | `serveStartFlags > a supervised serve retries its bind, and a replacement does too` |
| T-0297-M7 | packages/cli/src/http-bind.ts | the environment of a replacement left out `OPERAD_SERVE_REPLACES` | `serveStartFlags > a replacement's environment carries the flag main starts it with` |

## T-0273 — a run cancelled from the CLI records the CLI as its source

| id | file | mutation | failing test |
|---|---|---|---|
| T-0273-M1 | packages/cli/src/main.ts | `onCancelRun` recorded the cancel under the plugin's name `dev` again | `cancelling an object ends the run that waits on it > through the command line` |

## T-0311 — a row's badge prints after its state

| id | file | mutation | failing test |
|---|---|---|---|
| T-0311-M1 | packages/cli/src/main.ts | `rowLine` dropped every row's badge, so a plan list lost its auto level | `operad presentation commands > a row's badge prints after its state, and a row without one keeps its line` |

## T-0325 — every plugin the CLI offers resolves from it

| id | file | mutation | failing test |
|---|---|---|---|
| T-0325-M1 | packages/cli/package.json | removed the `@operad-io/bot` dependency, so a fresh install links no `node_modules/@operad-io/bot` | `plugins the CLI offers > bot (@operad-io/bot) is a dependency of the CLI and resolves from it` |
| T-0389-M1 | packages/cli/src/main.ts | `operad init` called `ensureConfig(home)` without the distribution's config, so a fresh file had no plugins and no `mcp.actions` | `operad command > init creates the home and prints each plugin check` and `operad command > init reports a missing radian and leaves a complete config` |

## T-0377 — npm packages and the claude install on enable

| id | file | mutation | failing test |
|---|---|---|---|
| T-0377-M3 | packages/cli/src/main.ts | `plugin enable claude` wrote the config without installing the package into the home's Bun project | `publishing and installing the packages > enabling claude from the packed tarballs installs the SDK without a platform package` |
| T-0377-M4 | packages/cli/src/main.ts | `plugin check claude` treated the optional plugin name as a path instead of naming the command that installs it | `publishing and installing the packages > the packed CLI installs into a prefix and runs help and init` |
| T-0377-M6 | packages/cli/package.json | removed `"license": "MIT"` from the CLI manifest | `the packages a publish needs > every publishable package has one version, the repository fields and the licence` |
| T-0377-M8 | packages/cli/src/main.ts | `loadTui` skipped `ensureInstalledPackage` and imported the package directly, so a published CLI never installed the terminal client into the home | `operad tui > installs the terminal client into the home when the CLI has no copy` |

## T-0388 — rework 5: a restored serve shows the item once and does not try the same change again

| id | file | mutation | failing test |
|---|---|---|---|
| T-0388-M3 | packages/cli/src/code-reload.ts | `serveSnapshots` gave a restored serve the fresh disk snapshot instead of the one from the process's first start | `a serve restored after a restart could not listen > a changed engine file shows the item; …` (and the plugin one) |
| T-0388-M4 | packages/cli/src/main.ts | the restore callback of `superviseServe` ran `runOnce(false, true, false)`, so the restored serve took a fresh baseline | `a reload with two listen addresses > a bind that keeps failing leaves the old code serving both addresses, with one line in the log` (real serve and child processes; the item is missing) |
| T-0388-M5 | packages/cli/src/main.ts | the serve's code watch was not given `declined: context.code.tried`, so the restored serve reloaded on the same change again | same test (a second `reloading:` line, and the item is gone) |
| T-0388-M6 | packages/cli/src/main.ts | the serve's code watch did not report `onOlder` to the notice | same test (no `serve-older.json`) |
| T-0392-M1 | packages/cli/src/code-reload.ts | `listenForStop`'s release removed the handlers of a supervised serve too, so a late passed-on signal ended it with 130 | `the stop signal handlers of a serve > a supervised serve keeps them after its stop is done; another serve does not` |

## T-0399 — the supervised serve's stop listeners stay until it exits

| id | file | mutation | failing test |
|---|---|---|---|
| T-0399-M1 | packages/cli/src/main.ts | `commandServe` called `listenForStop(false, stop)`, so a supervised serve removed its SIGINT and SIGTERM listeners when its stop was done | `a supervised serve that has stopped > still listens for SIGINT and SIGTERM` |
## T-0398-open-framework-b-followups — a restored serve, the mcp install list, the older-code notice

| id | file | mutation | failing test |
|---|---|---|---|
| T-0398-M2 | packages/cli/src/code-reload.ts | `restoredBaseline` took the plugin files from the first snapshot too, so a plugin the restored serve imported again counted as changed | `a serve restored after a restart could not listen > a changed plugin file shows nothing: the restored serve imported the plugin again` |
| T-0398-M3 | packages/cli/src/main.ts | the `mcp` command did not pass `installOnEnable: INSTALL_ON_ENABLE` to `runMcpServer` | `the mcp command gets the same install-on-enable list as the other commands` |
| T-0398-M4 | packages/cli/src/defaults.ts | `dev:pause` was added to `DEFAULT_LEAD_ACTIONS` | `the actions \`operad init\` writes never include the owner's pause and resume` |
| T-0398-M5 | packages/cli/src/main.ts | `commandServe` did not clear the older-code notice at its start | `a serve picks up changed code > the older-code notice is cleared when serve starts and when it stops` |
| T-0398-M6 | packages/cli/src/main.ts | `commandServe` did not clear the older-code notice when it ended | same test |
| T-0398-M7 | packages/cli/src/main.ts | (re-check of T-0388-M5) the code watch was not given `declined: context.code.tried`; the end-to-end test could pass before the poll that finds the change ran, so a test now checks the wiring where the watch is built | `the serve command's code watch > is given the change a restart already tried and reports into the notice` |

## T-0398 rework 1 — a restored serve treats only what it imported again as loaded from the disk

| id | file | mutation | failing test |
|---|---|---|---|
| T-0398-M13 | packages/cli/src/code-reload.ts | `restoredBaseline` ignored the path plugins' entry files, so an entry file the restored serve imported again counted as changed | `what a restored serve counts as loaded again > the entry file of a path plugin is loaded again; its other files are not` |
| T-0398-M14 | packages/cli/src/code-reload.ts | files of a plugin not loaded at the first start came from the first snapshot (absent), not the disk | `what a restored serve counts as loaded again > a plugin enabled since the first start counts as loaded from the disk` |
| T-0398-M15 | packages/cli/src/code-reload.ts | every file labelled `plugin …` was taken from the disk (the earlier behaviour), so a package-name plugin or a path plugin's helper read as loaded again | `what a restored serve counts as loaded again > a plugin given by package name stays as the first start loaded it` |
| T-0415-M1 | packages/telegram/package.json | the telegram package's version set to `0.1.1` while the rest stayed `0.1.0` | `the packages a publish needs > every public package has the same version` |
| T-0423-M9 | packages/cli/src/main.ts | an empty user name was used as the actor id, so every CLI action was refused | `the CLI's actor > is the user name, and `cli` when the name is empty so the action is not refused` |

## T-0427 — the CLI reads its output streams only when it writes

| id | file | mutation | failing test |
|---|---|---|---|
| T-0427-M1 | packages/cli/src/main.ts | the module hooked `process.stdout` and `process.stderr` again when it loaded, so importing it read the streams | `the CLI's module > does not touch process.stdout or process.stderr when it is imported` |
| T-0427-M2 | packages/cli/src/main.ts | `main` took the terminal from `process.stdout.isTTY` and `process.stdin.isTTY` again, so a command with injected output read the streams | `the CLI's main with injected output > list takes the terminal from the descriptors, not process.stdout` |
| T-0427-M3 | packages/cli/src/main.ts | `pair` took its terminal from `process.stdout.isTTY` again | `the CLI's main with injected output > pair takes the terminal from the descriptor, not process.stdout` |
| T-0427-M4 | packages/cli/src/main.ts | `stdoutColumns` read `process.stdout.columns` without checking that the descriptor is a terminal | `the CLI's main with injected output > show takes its width without reading process.stdout when it is not a terminal` |

## T-0428-flaky-cli-stdout-epoll-followups — interactive prompts do not read process streams

| id | file | mutation | failing test |
|---|---|---|---|
| T-0428-M1 | packages/cli/src/main.ts | `readLine` fell back to `process.stdin` and `process.stdout` for an injected io without `readLine`, so a note prompt read the streams | `the CLI's main with injected output > a note prompt does not read process.stdin when injected io has no readLine` |
| T-0428-M2 | packages/cli/src/main.ts | `readSecretValue` checked `process.stdin.isTTY` instead of the descriptor, so `secret set` read the stream even when stdin was a pipe | `the CLI's main with injected output > secret set does not read process.stdin when injected io has no readLine` |
| T-0428-M3 | packages/cli/src/main.ts | `readSecretValue` let an injected io without `readLine` read `process.stdin` when stdin was a terminal, so `secret set` touched the stream instead of stopping | `the CLI's main with injected output > secret set with a terminal stdin stops before reading process.stdin` |

## T-0430-fresh-home-runs-task — a fresh home has pool

| id | file | mutation | failing test |
|---|---|---|---|
| T-0430-M1 | packages/cli/src/defaults.ts | `pool` left out of `DEFAULT_PLUGINS`, so `operad init` did not install the plugin dev runs its workers through | `a fresh home follows the Quickstart > operad init, then the Quickstart's commands in order, start the task` (in `packages/dev/test/heavy/fresh-home.test.ts`) |

## T-0441-init-finds-agent — a new home enables the agents on PATH

| id | file | mutation | failing test |
|---|---|---|---|
| T-0441-M1 | packages/cli/src/main.ts | the harness list was always empty, so `operad init` never enabled claude or pi for a command on `PATH` | `\`operad init\` finds the agent on PATH > only claude is enabled, and its package is not a CLI dependency` and `... > only pi is enabled` |
| T-0441-M5 | packages/cli/src/main.ts | `init` installed claude only when it had just created the config, so a second init did not retry an install that failed after the config was written | `publishing and installing the packages > init retries a claude install that failed after config.json was written` |

## T-0445 — serve survives a busy store

| id | file | mutation | failing test |
|---|---|---|---|
| T-0445-M3 | packages/cli/src/main.ts | the serve context did not close its plugin store, so the process that became the supervisor kept `plugins.sqlite` open | `the process that becomes the supervisor closes the old plugin store on reload` |
