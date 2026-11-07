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
