# SSE fixtures

Raw server-sent event streams shared by the server tests and the clients. Each
file is UTF-8 and holds the bytes a client receives; the file itself is not
chunked. A client test may split a file at any byte, including in the middle of
a multi-byte character, if it decodes with streaming.

`MAX_SSE_EVENT_BYTES` is `65536` (64 KiB): the most bytes one line may hold,
including the `data: ` prefix. The server never writes a longer line, and a live
part that would need one becomes the object's change event instead.

| File | What it is |
|---|---|
| `tail-at-limit.sse` | One complete `tail` event whose `data:` line is exactly 65536 bytes. A client must accept it. |
| `tail-one-byte-over.sse` | The same event with a 65537-byte `data:` line. The server never sends it; a client test uses it to check its own limit. |
| `long-line-without-newline.sse` | A 65537-byte line with no line ending. A client must stop the stream without buffering it whole. |
| `frame-split-across-chunks.sse` | A comment, a change event and a `tail` event with CRLF line endings. A client test splits it across many chunks. |
| `reset-after-reconnect.sse` | A change event followed by `reset`. A reconnecting client that cannot resume refetches instead of replaying the old id. |
