---
description: Pairing the operad app with a serve.
---

# The phone app

The app reaches `operad serve` over [the HTTP interface](http.md). Pairing gives it the address and the token.

## Pairing the app

`operad pair` shows what the app needs to reach this `serve`:

```text
url http://192.168.1.20:7480
token <the token>

Scan this in the operad app:

<a QR code>
```

The URL is `http://<address>:<port>` for the first non-loopback entry of
`http.listen`. Pass `--url <base url>` to name another address, such as a
Tailscale HTTPS name (`operad pair --url https://mac.tail1234.ts.net`); it must
be an `http` or `https` URL without credentials or a query. The QR code encodes
`operad://pair?url=<url>&token=<token>`. It needs `http.enabled` true, and with no
`--url` an address in `http.listen` that is not loopback. With the default `http`
values, `pair` says that `http.listen` has only loopback addresses and asks for
one or `--url`; it names `http.enabled` only when that is false.

`pair` is the one command that prints the token. It refuses when its output is
not a terminal, so a pipe or a log never receives it; `--show-token` overrides
that and prints `url`, `token` and the pairing `link` as plain lines, with no
QR code. If you paste the token anywhere, rotate it with `operad http token
rotate`.
