# ADR 0019: Live Sections

Status: accepted

## Background

A chat shows its reply as it is written. This is done within the section interface and not with a separate stream.

## Decisions

### D1: A live section reads only what is new, with an unfinished tail

The result of `load` can carry two more things: `mark`, an opaque position that says how far the finished content has gone; and `tail`, a Markdown text that is the part still changing (a reply and thinking being written, a running tool call in a chat), always the whole text as it is now. A client can read a section with `after: <mark>`; then `markdown` has only the content finished after that position, the client appends it to what it has, and replaces the old `tail` as a whole with the new one. Without `after`, one page is read as before, also carrying `mark` and `tail`, so a reconnect or coming back to the foreground needs only one re-read.

### D2: `events` does not change

`events` still says only which object changed. A change of unfinished content also counts as the object having changed, and the kernel limits such notifications to one per object per 250 milliseconds.

### D3: Compatibility

A client that does not know the two things works as before: it just does not see `tail`. The command line's `operad show --section` does not show `tail`.
