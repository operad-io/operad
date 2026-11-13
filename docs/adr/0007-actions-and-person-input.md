# ADR 0007: Actions and Input from a Person

Status: accepted

## Background

A person has one way to act on the system. A command line and a phone behave the same, and a client draws a form from the schema of an action generically.

## Decisions

### D1: An action's parameters are `args` with a JSON Schema

`note` and `confirm` are marks on the schema, not special cases: a string field with `role: "note"`, and an action property `confirm: true`. A client draws a form generically from the schema. The `dev` plugin's `auto` is one action with an enumerated parameter, not three actions.

### D2: Every input from a person carries an `actor`

An `actor` is `{ via: "ios" | "telegram" | "cli" | …, id }`. It is recorded in `person_answered` and in the facts of an action. Channel allow-lists, several devices and, later, several people rely on it.
