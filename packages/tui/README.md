# @operad-io/tui

The terminal client for operad's `/v1` interface. It never opens the store and
never loads a plugin. The manual's `operad tui` section is the reference for
keys, flags and states.

## Hand tests (the lead runs these after a merge)

Use a scratch `OPERAD_HOME` with the `dev` plugin and some objects in it.

1. **Live row.** Run `operad tui`. In another terminal change an object (an
   action, or a new object). Its row updates within about a second; the list
   keeps its cursor.
2. **Live section.** Open an object with a live section (dot on its tab) and
   leave it at the bottom. Cause new output: the section grows and follows.
   Scroll up: it stops following.
3. **Pending and Running.** Start a flow that waits for you: it appears in
   Pending with no key press, and leaves it once answered.
4. **Server lost.** Stop the `serve` (`operad serve stop`). Within a few seconds
   the footer shows `no server at <url>: is `operad serve` running?`, the lists
   stay, dimmed. Start `operad serve` again: the footer clears and the lists
   come back without a key press.
5. **Rotated token.** Run `operad http token rotate` while the TUI is open. After
   the next change or `r` the footer says `the token was rotated: run the TUI
   again or pass --token`, and nothing is retried.
6. **Empty states.** With no waiting items Pending says `nothing waits for you`;
   an object type with no objects says `no <type> yet`.
7. **Failed section.** Open an object whose section fails (stop its source or
   use the `hang` fixture section). The section shows its message and `r
   retries`; `r` asks again.
8. **Leaving.** Quit with `q`, then with Ctrl-C, then `kill -TERM <tui pid>`
   (from another terminal), then `kill -INT <tui pid>`: each time the shell
   prompt is back with the normal screen, a visible cursor and working echo, and
   the exit code is 0.
