---
description: Reaching operad over a Tailscale network: the HTTPS name, pairing the phone app, and what does not work.
---

# Tailscale

[Tailscale](https://tailscale.com) joins your machines into one private network,
a tailnet. This page is about reaching `operad serve` over that network from
the phone app or another computer.

## The app needs the HTTPS name

The iOS app does not reach a plain `http://100.x.y.z:<port>` Tailscale address,
even when that address is in `http.listen` and `serve` listens on it. The app
says `the server cannot be reached at http://100.x.y.z:<port>`. Safari on the
same phone reached that address and got the `401` JSON, so the network was
fine: the app refuses plain HTTP to that address. iOS likely does not count
`100.64.0.0/10` as a local network. Use the
`https://<machine>.<tailnet>.ts.net` name that `tailscale serve` gives, set up
in the next section.

## Serve HTTPS on the tailnet

Run these steps on the machine that runs `operad serve`.

1. Enable HTTPS certificates for the tailnet in the Tailscale admin console,
   under DNS. This is a one-time step. Before it is on, `tailscale status
   --json` shows `"CertDomains": null`; after it, the list holds the machine's
   name.
2. Serve the port that `serve` listens on:

   ```sh
   tailscale serve --bg 8765
   ```

   `8765` is the default; use `http.port` from `config.json` when you set one.
   `--bg` keeps the proxy running after the command returns. It prints the
   HTTPS name and the address it proxies to:

   ```text
   https://mac.tail1234.ts.net/
   |-- proxy http://127.0.0.1:8765
   ```

   `http.listen` needs no change: Tailscale proxies to `127.0.0.1`, which the
   default listens on.
3. Pair the app with that name:

   ```sh
   operad pair --url https://mac.tail1234.ts.net
   ```

   Scan the code in the app. Pairing details are on
   [the app page](app.md#pairing-the-app); it needs `http.enabled` true.
4. To stop serving HTTPS, run `tailscale serve --https=443 off`.

## Always pass `--url` to pair

`operad pair` with no `--url` prints the first non-loopback entry of
`http.listen`, which is the LAN address when there is one, so a Tailscale
address listed after it never shows. Pass `--url` with the
`https://<machine>.<tailnet>.ts.net` name every time you pair over Tailscale.

## The terminal client

The terminal client on another computer can use a Tailscale address directly:
put it in `http.listen` and pass it with the token.

```sh
operad tui --url http://100.x.y.z:<port> --token <token>
```

`operad pair --show-token` prints the URL and the token to copy. Plain HTTP has
no restriction like the app's, so this path is expected to work, but it was not
tested. See [the terminal client](tui.md) for `--url`, `--token` and the rest.

## What was checked

Checked on 2026-11-15 on macOS with the iOS app: the HTTPS steps above, pairing
with the `https://<machine>.<tailnet>.ts.net` name, and scanning the code in the
app. Also checked: the app fails on a plain `http://100.x.y.z:<port>` address
while Safari on the same phone reaches it.

Not checked: `operad tui --url http://100.x.y.z:<port> --token <token>` from
another computer, which is expected to work as the section above says; and
Linux or Windows as the machine that runs `serve`. This page describes macOS.
