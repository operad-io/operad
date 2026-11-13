# ADR 0029: `operad serve` and the Clients

Status: accepted

## Background

The phone is the main place a person talks to a bot, so the display interface has to reach it over the network without a second backend, and without the app learning any plugin.

## Decisions

### D1: `operad serve` exposes the display interface as HTTP

`operad serve` exposes the client API (`list`, `get`, `section`, `events`, `act`) as HTTP. It listens only on the local machine, the local network or a Tailscale address (never a wildcard), requires a token, and uses SSE for `events`.

### D2: The app has one backend and knows no plugin

The iOS app is the operad app and connects only to `operad serve`: it keeps no second backend and no transition between two. It knows no plugin: the plans and tasks of `dev`, and the chats of `chat`, are shown and operated through the generic object interface of the display interface.
