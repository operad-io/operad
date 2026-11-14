# @operad-io/harness-radian

**The radian harness.** Runs `radian exec` in a directory as one agent step and reads its closing result.

This package is part of [operad](https://github.com/operad-io/operad). Most people install only [`@operad-io/cli`](https://www.npmjs.com/package/@operad-io/cli).

## Signed in

The plugin's `signedIn` answer, which `GET /v1/plugins` carries for clients, reports whether radian's credentials file (`$RADIAN_HOME/credentials/auth.json`, or `~/.radian/credentials/auth.json`) holds a credential. Only the presence of a credential is read; no key or token is read into operad, kept or returned. A missing file is `false`; a file that cannot be read or parsed is absent.

## Documentation

- User guide: [docs/user/dev.md](https://github.com/operad-io/operad/blob/main/docs/user/dev.md)
- Website: <https://operad.io>
- Developer reference: `REFERENCE.md` in this directory

MIT licensed.
