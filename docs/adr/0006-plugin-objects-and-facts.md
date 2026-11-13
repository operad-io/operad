# ADR 0006: Plugin Objects and Facts

Status: accepted

## Background

The kernel does only five things (ADR 0002), and everything else is a plugin. Conversations, notes and tasks must all fit one storage model, so the contract is made general where it is used and gains new primitives only where a scenario needs one.

## Decisions

### D1: `list(type, { where, cursor, limit })`

A plugin lists in an object declaration the fields that can be filtered (`index: ["plan", "phase"]`), and the kernel filters only by those fields. Results are paged. Conversations by channel, tasks by plan and thousands of notes paged are all this one call.

### D2: `facts(object, { cursor })` and subscription

Messages, worker logs and costs are facts on an object. The `live` section of the display interface pages over these facts.
