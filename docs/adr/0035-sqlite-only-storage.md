# ADR 0035: Storage Is `sqlite` Only

Status: accepted

## Background

Two storage implementations (a JSONL file log and `sqlite`, and the same pair for plugin objects) doubled the code and the tests. After `sqlite` became the default, keeping the JSONL log fast as history grew cost many rounds of work while the default backend and most tests still ran on JSONL. The price of keeping one is that the storage can no longer be read or diffed as text; that is accepted.

## Decisions

### D1: Only `sqlite` is shipped and accepted

The log and the plugin object store have one implementation each, on `sqlite`; the default backend is `sqlite`. `store.backend` accepts only `sqlite`; any other value is an ordinary configuration error. A home that still holds the JSONL storage is not supported: there is no import of it and no special hint. The log interface and its conformance test remain, as ADR 0002 says.

### D2: Tests use `sqlite` or an in-memory implementation

A test that needs a log or an object store uses `sqlite` or the in-memory implementation. A harness's work log (a JSONL file a harness process writes) is not storage in this sense and is unaffected.
