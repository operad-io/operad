---
description: When something does not work: where to look and what to run.
---

# Troubleshooting

- A `serve` that does not start because the port is taken: a second `operad serve` for a home that already has one exits with code 4; see [the HTTP interface](http.md#the-http-section) and [stopping serve](cli.md#stopping-serve).
- The terminal client cannot reach a `serve`: check `http.enabled` in [config.json](config.md); see [the terminal client](tui.md).
- Changed code that does not load: `serve` keeps running the old code; see [Changed code](cli.md#changed-code).
- A run's history: `operad history <id>`; see [the command line](cli.md#the-history-section).
- A task that is stuck, or a reviewer that is unavailable: see [Running operad on operad](../dogfood.md#when-something-is-stuck).
