# Mutation records — `tui`

Rows whose mutation broke code in `packages/tui/`, in the order they were
recorded. The root [MUTATIONS.md](../../MUTATIONS.md) explains the format and
the row fields.

| id | file | mutation | failing test |
|---|---|---|---|
| TK0029-M1 | packages/tui/src/client.ts | `401` fell through to the generic error instead of `TuiUnauthorizedError` | `TuiClient > turns each server error into its typed error and keeps the message` |
| TK0029-M2 | packages/tui/src/client.ts | `section` stopped sending `full=true` | `TuiClient > gets one object with its row, sections, actions and a URL-encoded id` |
| TK0029-M3 | packages/tui/src/client.ts | `act` dropped `confirmed` from the request body | `TuiClient > acts with a note, arguments and confirmation` |
| TK0029-M4 | packages/tui/src/discover.ts | a given `--token` was replaced by the home's token | `TuiClient > discovers the server from the home, and the flags win` |
| TK0029-M5 | packages/tui/src/events.ts | `reset` no longer cleared the old `Last-Event-ID` | `TuiEvents > an id the server cannot resume becomes one reset signal` |
| TK0029-M6 | packages/tui/src/events.ts | the reconnect sent a fixed id instead of the last event's id | `TuiEvents > a reconnect with the last id gets the event it missed` |
| TK0029-M7 | packages/tui/src/events.ts | a stream that closed without an event still reset the retry to the minimum | `TuiEvents > a stream that closes without an event keeps backing off` |
| TK0029-M8 | packages/tui/test/support.ts | closing a harness left its scratch home behind | `TuiClient > a harness removes its own scratch home and leaves another's alone` |
| TK0029-M9 | packages/tui/src/events.ts | a `401` no longer ended the stream | `TuiEvents > a bad token ends the stream after one error event` |
| TK0029-M10 | packages/tui/src/events.ts | a refused stream pushed no `error` event | `TuiEvents > 404 and 409 end the stream; 500 is retried with backoff` |
| TK0029-M11 | packages/tui/src/events.ts | a reconnect with no id to resume from sent no `reset` | `TuiEvents > a reconnect with no id to resume from sends one reset` |
| TK0029-M12 | packages/tui/src/events.ts | an event's id was not kept for the next request | `TuiEvents > the same instance reconnects with the last id and gets the missed event` |
| TK0029-M13 | packages/tui/src/client.ts | the abort signal was not passed to `fetch` | `TuiClient > an aborted request rejects with the abort, not an unreachable server` |
| TK0029-M14 | packages/tui/src/client.ts | an aborted request was reported as an unreachable server | `TuiClient > an aborted request rejects with the abort, not an unreachable server` |
| T-0030-M1 | packages/tui/src/state.ts | a cursor move near the end never asked for the next page | `the TUI reducer > moving past the end asks for the next page once and appends it once` |
| T-0030-M2 | packages/tui/src/state.ts | the two-pane threshold became `>` instead of `>=`, so 100 columns stayed one pane | `the TUI reducer > resize crosses 100 columns and carries the theme` |
| T-0030-M3 | packages/tui/src/state.ts | a Pending row lost its waiting flag | `the TUI reducer > each list maps its own flags to a row mark` |
| T-0030-M4 | packages/tui/src/state.ts | an appended page kept `loading` true | `the TUI reducer > moving past the end asks for the next page once and appends it once` |
| T-0030-M5 | packages/tui/src/view/index.ts | the waiting marker used the weak gray instead of the accent | `the TUI view > two panes show the header, a waiting marker and the footer` |
| T-0030-M6 | packages/tui/src/view/index.ts | the view always drew both panes, ignoring the width | `the TUI view > below 100 columns the right pane is gone` |
| T-0030-M7 | packages/tui/src/state.ts/app.ts | the shell no longer cleared a page request as it launched it, so every key fetched the page again | `the TUI app > keys, resizes and refreshes while a page is in flight fetch it once` |
| T-0030-M8 | packages/tui/src/state.ts | an appended page for an older list version was no longer dropped | `the TUI app > a page that lands after a refresh's replace is dropped` |
| T-0030-M9 | packages/tui/src/app.ts | a new refresh no longer aborted the previous refresh's requests | `the TUI app > the previous refresh is aborted and its late answer is dropped` |
| T-0030-M10 | packages/tui/src/state.ts | a replace no longer bumped the list version | `the TUI app > a page that lands after a refresh's replace is dropped` |
| T-0030-M11 | packages/tui/src/state.ts | an answer to an older refresh was applied | `the TUI app > the previous refresh is aborted and its late answer is dropped` |
| T-0030-M12 | packages/tui/src/view/index.ts | the list drew every row instead of the window around the cursor | `the TUI view > a long list scrolls with the cursor and the status takes the footer` |
| T-0030-M13 | packages/tui/src/state.ts | a replace kept the cursor index instead of following the selected object's id | `the TUI app > a refresh keeps the selected object, fetching as deep as the list was` |
| T-0030-M14 | packages/tui/src/app.ts | a refresh fetched only the first page, not as deep as the list was | `the TUI app > a refresh keeps the selected object, fetching as deep as the list was` |
| T-0030-M15 | packages/tui/src/app.ts | an `error` event from the stream was not shown | `the TUI app > an error event from the stream shows its reason` |
| T-0030-M16 | packages/tui/src/app.ts | messages were written to stderr while the screen was up | `runTui > failures are printed after the screen is closed, never while it is up` |
| T-0030-M17 | packages/tui/src/state.ts | a Ctrl or Meta chord acted like its plain key | `the TUI reducer > ctrl and meta chords are ignored, and only ?, escape and q act while the keys are open` |
| T-0030-M18 | packages/tui/src/state.ts | keys other than `?`, escape and `q` acted on the list hidden behind the key list | `the TUI reducer > ctrl and meta chords are ignored, and only ?, escape and q act while the keys are open` |
| T-0030-M19 | packages/tui/src/app.ts | a failure while the screen was being set up was thrown, not reported | `runTui > restores the terminal and reports the failure when the view cannot be made` |
| T-0030-M20 | packages/tui/src/app.ts | the renderer was not remembered for the final cleanup, so a failed setup left it open | `runTui > restores the terminal and reports the failure when the view cannot be made` |
| tui-autostart-M3 | packages/tui/src/autostart.ts | a held home lock was ignored, so a second serve could be started | `ensureServer > a home lock with a silent port is an error naming http.enabled and http.port, and starts nothing` |
| tui-autostart-M4 | packages/tui/src/autostart.ts | an answering serve was not recognised and a second one was started | `ensureServer > a serve that already answers is not started again` |
| tui-autostart-M5 | packages/tui/src/autostart.ts | a non-operad answer was treated as silence | `ensureServer > a port that answers but is not operad is an error naming the port` |
| tui-autostart-M6 | packages/tui/src/autostart.ts | `http.enabled` false still started a serve | `ensureServer > http.enabled false starts nothing and names the key` |
| tui-autostart-M7 | packages/tui/src/autostart.ts | an early exit of the child was not noticed | `ensureServer > a child that exits at once is an error naming the log and showing its tail` |
| tui-autostart-M8 | packages/tui/src/autostart.ts | the `starting operad serve` line was not printed | `ensureServer > a fresh home with no config starts serve, waits for it and returns the address` |
| tui-autostart-M9 | packages/tui/src/autostart.ts | the child was not detached from the TUI's process group | `a real serve > a fresh home on a free port: tui starts serve, connects, and the child is stopped after` |
| tui-autostart-M10 | packages/tui/src/app.ts | `--url` no longer skipped the start check | `runTui and the flags > --url and --no-start never start or check a serve; neither does nothing at all` |
| tui-autostart-M11 | packages/tui/src/app.ts | `--no-start` no longer skipped the start check | `runTui and the flags > --url and --no-start never start or check a serve; neither does nothing at all` |
| tui-autostart-M13 | packages/tui/src/autostart.ts | a `200` reply without a `types` list counted as operad | `probeServer > tells operad, a silent address and another service apart` |
| tui-autostart-M16 | packages/tui/src/autostart.ts | an early exit of the child always failed, even when another serve held the lock | `ensureServer: races and bounds > two tui starting at once both end connected to the one serve` |
| tui-autostart-M17 | packages/tui/src/discover.ts | `http.port` 0 no longer failed before a start | `ensureServer: races and bounds > port 0 or an empty listen fails before anything is spawned` |
| tui-autostart-M18 | packages/tui/src/autostart.ts | the start deadline was a hundred times too far, so probe time did not bound the wait | `ensureServer: races and bounds > probe time counts against the start deadline` |
| pending-row-M6 | packages/tui/src/state.ts | a pending item with a row still showed the prompt as its title | `the TUI reducer > a pending item with a row shows the object's title and state, and the question as the note` |
