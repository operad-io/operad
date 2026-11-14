# @operad-io/harness-pi

**The pi harness.** Runs a prompt with the pi coding agent library you installed.

This package is part of [operad](https://github.com/operad-io/operad). Most people install only [`@operad-io/cli`](https://www.npmjs.com/package/@operad-io/cli).

## Signed in

The plugin's `signedIn` answer, which `GET /v1/plugins` carries for clients, reports whether pi's auth file (`authPath`, `~/.pi/agent/auth.json` by default) holds a credential for the provider pi will use: the provider of the configured `model`, or pi's `defaultProvider`, or any stored credential when neither names one. Only the presence of that credential is read; the secret is never read into operad, kept or returned. A missing file is `false`; a file that cannot be read or parsed is absent.

## Documentation

- User guide: [docs/user/dev.md](https://github.com/operad-io/operad/blob/main/docs/user/dev.md)
- Website: <https://operad.io>
- Developer reference: `REFERENCE.md` in this directory

MIT licensed.
