# ADR 0005: The Storage Backend and Change Facts

Status: accepted

## Background

The kernel's storage is a replaceable backend (ADR 0002). Plugin objects live in the same store, and recording a whole snapshot of an object on every change made the store grow by about 19 MB a day, almost all of it the full snapshots a `dev` task wrote on every state change together with its brief (14,703 snapshots, 108 MB when measured).

## Decisions

### D1: One log interface, one conformance test, one backend

The storage is a log interface plus one conformance test. The only backend shipped is `sqlite` (`bun:sqlite`, WAL), and it passes the conformance test. Storage stays `sqlite` only: a run is not stored as a separate JSONL file.

### D2: Object facts record changes only

Every status change of a `dev` task used to write a full snapshot of the object with its brief, so `plugins.sqlite` grew about 19 MB a day; recording changes only removes that. The object store's `put` does not write the whole object into the fact each time. It writes only the top-level fields that changed (those whose values differ by deep comparison) and the names of removed fields. The current value of an object is still stored whole in the object table. A plugin that reads facts (`dev`'s Answer section and throughput, `chat`'s transcript) reads them as changes.
