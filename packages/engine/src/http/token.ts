/**
 * The one bearer token `serve` checks. It lives beside the plugins' secrets in
 * `$OPERAD_HOME/secrets/http.json` (0600 in a 0700 directory), never in the log.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { FileSecretStore } from "../plugin/secrets.ts";

const PLUGIN = "http";
const TOKEN = "token";
const LABEL = "label";

/** The actor id used when a token has no label of its own. */
export const DEFAULT_HTTP_TOKEN_LABEL = "operad app";

/** The token and the name an action records it by. */
export interface HttpToken {
  readonly token: string;
  readonly label: string;
}

function tokenStore(home: string): FileSecretStore {
  return new FileSecretStore({ home, plugin: PLUGIN });
}

/** 32 random bytes, base64url, as the protocol asks. */
export function generateHttpToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Reads the token, or undefined before the first enabled `serve`. */
export async function readHttpToken(
  home: string,
): Promise<HttpToken | undefined> {
  const store = tokenStore(home);
  const token = await store.get(TOKEN);
  if (token === undefined) return undefined;
  const label = await store.get(LABEL);
  return {
    token: token.reveal(),
    label: label?.reveal() ?? DEFAULT_HTTP_TOKEN_LABEL,
  };
}

/** Creates the token on the first enabled `serve`; a later call keeps it. */
export async function ensureHttpToken(home: string): Promise<HttpToken> {
  const store = tokenStore(home);
  const existing = await store.get(TOKEN);
  let token: string;
  if (existing === undefined) {
    token = generateHttpToken();
    await store.set(TOKEN, token);
  } else {
    token = existing.reveal();
  }
  let label = await store.get(LABEL);
  if (label === undefined) {
    await store.set(LABEL, DEFAULT_HTTP_TOKEN_LABEL);
    label = await store.get(LABEL);
  }
  return { token, label: label?.reveal() ?? DEFAULT_HTTP_TOKEN_LABEL };
}

/**
 * Replaces the token. A running `serve` reads the file for each request, so the
 * old token is refused from the moment this returns.
 */
export async function rotateHttpToken(home: string): Promise<HttpToken> {
  const store = tokenStore(home);
  const token = generateHttpToken();
  await store.set(TOKEN, token);
  let label = await store.get(LABEL);
  if (label === undefined) {
    await store.set(LABEL, DEFAULT_HTTP_TOKEN_LABEL);
    label = await store.get(LABEL);
  }
  return { token, label: label?.reveal() ?? DEFAULT_HTTP_TOKEN_LABEL };
}

/** Compares two tokens without an early exit. */
export function tokensEqual(expected: string, provided: string): boolean {
  const left = createHash("sha256").update(expected, "utf8").digest();
  const right = createHash("sha256").update(provided, "utf8").digest();
  return timingSafeEqual(left, right);
}
