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
| T-0052-M9 | packages/cli/src/main.ts | `list --root` was not passed to the views (also T-0052-M11) | `operad list hierarchy > --root and --parent list one level; show prints the parent` |
| T-0052-M10 | packages/cli/src/main.ts | `show` did not print the parent line | `operad list hierarchy > --root and --parent list one level; show prints the parent` |
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
| T-0108-M1 | packages/cli/src/serve-stop.ts | `serve stop` asked `ps` for the serve's command line only once, so an empty answer under load refused with exit 3 | `serve stop > a ps that answers nothing for a live serve is asked again, then the serve is stopped` |
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
