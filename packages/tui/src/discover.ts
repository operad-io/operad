/**
 * Where `operad tui` finds its server: the flags first, then the home's
 * `config.json` (or its defaults) for the address and the token file `operad
 * pair` reads. It never starts a server and never opens the store.
 */

import {
  defaultOperadHome,
  ensureHttpToken,
  readConfig,
  validateListenAddresses,
} from "@operad-io/engine";
import { normalizeBaseUrl, TuiError } from "./client.ts";

/** No usable server location could be found. */
export class TuiDiscoveryError extends TuiError {
  constructor(message: string) {
    super(message, { kind: "config" });
    this.name = "TuiDiscoveryError";
  }
}

/** The flags and home a caller may name. */
export interface TuiDiscoverOptions {
  readonly home?: string | undefined;
  readonly url?: string | undefined;
  readonly token?: string | undefined;
}

/** The address and bearer token a client needs. */
export interface TuiServerLocation {
  readonly url: string;
  readonly token: string;
}

/** The base URL `http.listen` and `http.port` name. */
export function urlFromConfig(
  listen: readonly string[],
  port: number,
): string {
  validateListenAddresses(listen);
  const address = listen[0];
  if (address === undefined) {
    throw new TuiDiscoveryError("http.listen: needs at least one address");
  }
  if (port === 0) {
    throw new TuiDiscoveryError(
      'http.port is 0; set a port in config.json or pass --url',
    );
  }
  const host = address.includes(":") ? `[${address}]` : address;
  return `http://${host}:${port}`;
}

/**
 * Resolves the server location. A given `--url` wins over `http.listen`; a
 * given `--token` wins over the home's token file.
 */
export async function discoverServer(
  options: TuiDiscoverOptions = {},
): Promise<TuiServerLocation> {
  const home = options.home ?? defaultOperadHome();

  let url: string;
  if (options.url !== undefined) {
    if (options.url.length === 0) {
      throw new TuiDiscoveryError("--url needs a URL");
    }
    url = normalizeBaseUrl(options.url);
  } else {
    const config = await readConfig(home);
    url = urlFromConfig(config.http.listen, config.http.port);
  }

  let token: string;
  if (options.token !== undefined) {
    if (options.token.length === 0) {
      throw new TuiDiscoveryError("--token needs a token");
    }
    token = options.token;
  } else {
    // `operad pair` reads the token through ensureHttpToken: the first enabled
    // serve created it, and a home that never served creates it now.
    token = (await ensureHttpToken(home)).token;
  }

  return { url, token };
}
