# @operad-io/harness-claude

**The claude harness.** Runs a prompt through the Claude Agent SDK, which starts your own `claude` command. operad bundles no claude.

This package is part of [operad](https://github.com/operad-io/operad). Most people install only [`@operad-io/cli`](https://www.npmjs.com/package/@operad-io/cli).

## Signed in

The plugin's `signedIn` answer, which `GET /v1/plugins` carries for clients, comes from `claude auth status`: `true` when `loggedIn` is true, `false` when it is false. The answer is kept for a short time, so a client can ask it without starting a session; the probe runs without blocking `serve`. It is absent when `claude` is not found or its answer cannot be read, and only the yes/no is ever exposed, never an account detail.

## Documentation

- User guide: [docs/user/dev.md](https://github.com/operad-io/operad/blob/main/docs/user/dev.md)
- Website: <https://operad.io>
- Developer reference: `REFERENCE.md` in this directory

MIT licensed.
