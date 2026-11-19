# ADR 0019: Live Sections

Status: accepted

## Background

A chat shows its reply as it is written. This is done within the section interface and not with a separate stream.

## Decisions

### D1: A live section reads only what is new, with an unfinished tail

The result of `load` can carry more things beside the page: `mark`, an opaque position that says how far the finished content has gone; `tail`, a Markdown text that is the part still changing (a reply and thinking being written, a running tool call in a chat), always the whole text as it is now; `status` (D4); and `context` (D5). A client can read a section with `after: <mark>`; then `markdown` has only the content finished after that position, the client appends it to what it has, and replaces the old `tail` as a whole with the new one. Without `after`, one page is read as before, also carrying `mark` and `tail`, so a reconnect or coming back to the foreground needs only one re-read.

### D2: `events` says what changed, and pushes a live tail

`events` says which object changed. A change of unfinished content also counts as the object having changed, and the kernel limits such change notifications to one per object per 250 milliseconds.

A live section whose plugin supplies its changing part (D6) is also pushed as a `tail` event on the same event stream. It carries the object type, the section's id and its whole current `tail` and `status`, in the shapes a section read uses, and is limited to one per object per 50 milliseconds. A `tail` event has no resume id and is not replayed: a client that reconnects reads the section again. A client that does not know `tail` ignores it and keeps its change-event reads.

### D3: Compatibility

A client that does not know these things works as before: it just does not see `tail` or `status`. The command line's `operad show --section` does not show `tail` or `status`.

### D4: A live section can say what it is doing

The result of `load` may carry `status`, an object `{ "text": string, "since": number }` where `since` is a time in milliseconds since the epoch. The kernel passes it through as it passes `tail`: it does not read it, a client that does not know it works as before, and a change of it counts as growth of the object (announced under the same 250 ms limit as D2). It is served by the HTTP section read and by the MCP `section` tool. The text and its words belong to the plugin; the elapsed time beside it belongs to the client.

### D5: A section can carry numbers beside its text

`load` may return `context`, the same `{ used, window?, model? }` a detail page can carry (ADR 0014 D1). The kernel passes it through on every read, including a read with `after`, and does not read it. A chat's `transcript` uses it for how full the agent's context is (ADR 0026 D16); a client that does not know it works as before.

### D6: A live section's changing part is pushed as it is written

A type's views may supply `tail(ctx, object)`, returning `{ section, tail?, status? }`: the same part a section read returns, without the finished content. The kernel calls it when the object grows and pushes the result as a `tail` event (D2). A plugin that supplies no `tail` function keeps id-only change events. The chat's `transcript` supplies it, so the text being written, thinking, and tool calls starting and ending reach a client without a section re-read; finished content still arrives by the incremental read of D1.
