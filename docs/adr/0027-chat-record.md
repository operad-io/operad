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

### D3: A reply is shown as Markdown lines, thinking included

The `transcript` section renders a tool call as a Markdown line (as `dev` shows a worker's activity), so no client changes. Thinking is recorded and shown, and a harness that does not give it (radian) shows none; radian's chats show tool lines only. A structured, collapsible block would need a structured kind in the display interface and is not part of this.

### D4: Text arrives by the section's incremental read

Live text uses the incremental read of a live section (ADR 0019), not a separate stream. The text the current run has not finished writing reaches `serve` through the step's log: the run is not inside the `serve` process, so the `tail` of the `transcript` section is read from the log of the step that is running for this chat. The `tail` holds only entries not yet finished; finished ones are already facts. After a reconnect, the text already written for the current turn is returned with it.

### D5: Where entries come from

The `chat` plugin does not understand a harness's log lines. The lines a harness writes are normalised by one shared type in the harness process package, together with text increments, thinking increments and tool output. A harness step takes a receiver through the options of `runStep` (the same place as `asker`), and the receiver `chat:reply` provides records finished entries as facts. claude enables partial messages and takes tool results; pi takes message increments and tool results; radian has only the start and end of a tool and no increments or thinking, and degrades honestly.

### D6: A rerun does not duplicate

An entry a rerun step produces again is deduplicated by call id, and the final reply is still recorded as a fact first (ADR 0026 D3).
