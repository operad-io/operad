# ADR 0027: Chat Attachments and the Record of a Reply

Status: accepted

## Background

A person reading a chat needs what the agent did, not only what it finally said, and that record must not depend on the agent's own session file (claude removes its files by default after 30 days, and what is read back after compaction is not the original). A photo, a camera shot or a file has to reach the agent without opening the chat to the whole machine.

## Decisions

### D1: Attachments are uploaded to the chat's own directory

A photo, camera shot or file is uploaded through the client API into the chat's own attachment directory under the operad home, never into the repository's or the bot's working directory. A single file may be at most 20 MB. The message's fact records the attachment path. At reply time claude and pi get images they can read as images; other files are given as paths for the agent to read. The agent's access profile opens only this chat's attachment directory, read-only. Upload is a general ability of the client API (an action parameter may be an uploaded file), not an interface of the chat.

### D2: The process of a reply is recorded as facts, one per finished entry

The finished entries of a reply (a tool call, an intermediate piece of reply text, thinking, and the half-written reply of a run that was stopped) are recorded as facts of the chat in the store, in one shape for every harness. Each carries the run id and belongs to the same turn as the final `chat.message`. A tool call's fields are: call id, tool name, input summary, result (`done`, `failed`, `blocked`, `denied`), start time, duration, the first part of its output, the path of the whole output and the first line of an error. Plans, available commands and mode changes are not recorded.

Tool output is kept in the fact only up to its first 4 KB; the whole output goes to a file under the chat's directory, beside the attachments. Increments of text are not stored. Text, thinking and tool output are masked with `secretValues` before they enter a fact or the tail, like a log line.

The model's context stays the agent's: a reply continues with `resumeSession`, and operad never rebuilds context from its own record.

### D3: A reply is Markdown and a structured form beside it

The `transcript` section keeps its Markdown lines, so a client that reads only Markdown is unchanged, and carries `data.replies` beside it. Each reply is `{ runId, input, process, answer?, durationMs? }`.

`data.replies` follows the same window as `markdown`: a page read carries the replies on that page; a read with `after` carries the replies whose answer is after the mark and the one still running; the pushed `tail` event (D4) carries the running reply. A client merges by `runId`: a page read replaces the replies it draws with that page's, and an `after` read or a `tail` event replaces the block of an existing `runId` and adds a new one.

`input` and `answer` are message blocks `{ id, text, at }`; a finished reply has `answer`, and a reply still being written has none. `durationMs` is the step's reported total when its harness reports timings.

`process` is the thinking, intermediate text and tool calls between input and answer, grouped per turn in time order. A message the reply took mid-run ends one group and starts the next, so the groups and the input keep the order the transcript records for a message sent during a reply. A group is `{ categories, items }`; `categories` are the category ids `read`, `edit`, `run`, `search` and `other`, in first-use order, and clients word them.

A process item is `{ kind: "thinking" | "text", text, at? }` or `{ kind: "tool", callId, name, input, at?, durationMs?, failed, result?, output }`. A tool's `input` is the recorded summary or null, and `at` is when the call started. `result` is absent while a call runs; `failed` is true only for the result `failed`. `output` is `{ text, lines, path?, truncated? }`: `text` is the recorded output (at most the first 4 KB D2 keeps), `lines` counts its lines, `path` is the file holding the whole output when D2 wrote one, and `truncated` says the recorded text is shorter than that file.

The size cap counts `markdown`, `tail` and `data.replies` together. When the replies do not fit, a tool's output text is cut first: it is left empty, `lines` stays its count and `truncated` is true. If they still do not fit, the other text in the replies is shortened and the oldest reply blocks are left out until the rest fits; the Markdown is shortened only after that. A read with `full` leaves both whole. The changed-file card and diff are not part of this.

### D4: Text arrives as the live tail, pushed and readable

Live text uses the live section (ADR 0019), not a separate connection. The text the current run has not finished writing reaches `serve` through the step's log: the run is not inside the `serve` process, so the `tail` of the `transcript` section is read from the log of the step that is running for this chat. The `tail` holds only entries not yet finished; finished ones are already facts. The transcript's `tail` function returns that tail, status and the running reply's `data.replies`, so `serve` pushes them on the event stream as a `tail` event as the reply is written; a client may also read the same tail with the section's incremental read. After a reconnect, the text already written for the current turn is returned with the section.

### D5: Where entries come from

The `chat` plugin does not understand a harness's log lines. The lines a harness writes are normalised by one shared type in the harness process package, together with text increments, thinking increments and tool output. A harness step takes a receiver through the options of `runStep` (the same place as `asker`), and the receiver `chat:reply` provides records finished entries as facts. claude enables partial messages and takes tool results; pi takes message increments and tool results; radian has only the start and end of a tool and no increments or thinking, and degrades honestly.

### D6: A rerun does not duplicate

An entry a rerun step produces again is deduplicated by call id, and the final reply is still recorded as a fact first (ADR 0026 D3).

### D7: A failed reply is recorded and shown, once

When a reply ends `failed`, the chat records one more entry, kind `failure`, and no reply message. Its text is one plain line that says the reply failed and why: the provider's message, masked with `secretValues` and cut to a sensible length. When the provider gives no message because the agent ended without answering and without calling the model, the line says that instead, with the agent's own reason when it gives one (ADR 0026 D14). The `transcript` section shows that line after the person's message for every harness. A channel bound to the chat sends it once as a message. A rerun of the step does not record the same failure again. A reply that is interrupted or waiting is not a failure and gets no such line.

### D8: A reply records the context it ended with

An assistant message carries `context: { used, window? }` beside its usage. `used` is the last model call's input plus its cache read and cache write, as the harness parsed it; it is not the sum over the reply's calls. `window` is the model's context window when the harness's model list gives one. A harness that cannot tell leaves `used` out, and an unknown window is left out; neither is ever guessed. The chat's view reads this from the last finished reply (ADR 0026 D16).

### D9: A retry being waited for is a live item

When a harness retries a failed model request, the live transcript carries a `retry` item beside `tail` and `status`: `{ attempt, maxAttempts, until, reason }`. `until` is the time of the next attempt in milliseconds since the epoch, so a client counts down from it instead of reading a fixed number of seconds; `reason` is the provider's message, masked like a log line. The live tail also says in one Markdown line that the request is being retried. ADR 0019 D7 says how the kernel checks and carries the item on a section read and a pushed `tail` event.

`pi` and `claude` report a retry: pi's automatic retry emits its start and end, and claude's `api_retry` system message gives the attempt, the retry budget and the delay. `codex` has no retry report in its app-server protocol, so a codex chat shows no retry item. A successful retry and retries that run out both remove the item from the live view: the harness's retry-end line or the next successful message clears it, and the successful text or the failure follows. The stored transcript keeps no retry entry. When the retries run out the reply fails as D7 says.
