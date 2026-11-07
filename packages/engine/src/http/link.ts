/**
 * The links the app understands. An object link opens one object; a pairing
 * link carries the address and the token of a `serve`, so a phone can scan it.
 */

/** The scheme of every link. */
export const LINK_SCHEME = "operad://";

/**
 * The link that opens one object: `operad://objects/<id>`, with the id as
 * `get` takes it (`<type>:<id>`) and URL-encoded.
 */
export function objectLink(type: string, id: string): string {
  return `${LINK_SCHEME}objects/${encodeURIComponent(`${type}:${id}`)}`;
}

/** The link a QR code carries: `operad://pair?url=<url>&token=<token>`. */
export function pairLink(url: string, token: string): string {
  return `${LINK_SCHEME}pair?url=${encodeURIComponent(url)}&token=${encodeURIComponent(token)}`;
}
