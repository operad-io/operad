# @operad-io/harness-codex

**The codex harness.** Starts your own `codex app-server` and speaks Codex's JSON-RPC to it, to run a prompt as one agent step.

This package is part of [operad](https://github.com/operad-io/operad). Most people install only [`@operad-io/cli`](https://www.npmjs.com/package/@operad-io/cli).

## Signed in

The plugin's `signedIn` answer, which `GET /v1/plugins` carries for clients, comes from `codex login status`: `true` on a zero exit, `false` on a non-zero one. The answer is kept for a short time and the probe runs without blocking `serve`. It is absent when `codex` is not found or cannot be asked. Only the yes/no is exposed, never an account or a key.

## Models

The plugin's `model` choices come from the app-server's own `model/list`, kept for a short time so a chat can offer the models Codex offers. A step's `--model` still wins.

## Documentation

- User guide: [docs/user/dev.md](https://github.com/operad-io/operad/blob/main/docs/user/dev.md)
- Website: <https://operad.io>
- Developer reference: `REFERENCE.md` in this directory

MIT licensed.
