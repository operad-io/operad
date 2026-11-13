# ADR 0009: Material, Usage and Step Limits

Status: accepted

## Background

Text from outside (events, messages, fetched items, web pages) is something a step handles, and it can be written by anyone. Every harness also reports its use in its own way unless one shape is fixed, and model concurrency and rate limits would be invented by each plugin unless the runner manages them.

## Decisions

### D1: External text enters only as material

Events, messages, fetched items and web page text are always files with provenance (source, time, reference), delivered to a step through `ctx.trigger`, which is read-only and holds file paths only. They do not appear as strings in params, and the kernel never puts them into any prompt. This is the rule for every entrance.

### D2: Standard fact shapes

`usage` (harness, model, tokens, cost) and the standard end result names (`done` | `nothing` | `failed` | `needs_decision` | `waiting` | `interrupted`) have one shape for every harness. The cost at the end of a row, the metrics and the budgets all read from it.

### D3: A step type can declare `limit: { key, concurrent }`

The runner queues by key. The concurrency and rate limiting of a model are managed here; a plugin does not invent its own.
