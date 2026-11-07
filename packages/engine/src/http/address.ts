/**
 * The addresses `http.listen` may name. A kernel port is reachable only from
 * the machine itself, the local network, or a Tailscale network; a wildcard
 * would open it to whatever the host is attached to.
 */

import { isIP } from "node:net";
import { ConfigError } from "../config/config.ts";

/** The kinds of address an `http.listen` entry may be. */
export type ListenAddressKind =
  | "loopback"
  | "private"
  | "link-local"
  | "tailscale";

function ipv4Bytes(address: string): readonly number[] | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return undefined;
    const value = Number(part);
    if (value > 255) return undefined;
    bytes.push(value);
  }
  return bytes;
}

function ipv4Group(text: string): number | undefined {
  const bytes = ipv4Bytes(text);
  if (bytes === undefined) return undefined;
  const [first = 0, second = 0] = bytes;
  return first * 256 + second;
}

function ipv6Groups(text: string): readonly number[] | undefined {
  if (text.length === 0) return [];
  const groups: number[] = [];
  const parts = text.split(":");
  for (const part of parts) {
    // An embedded IPv4 address is the last part and stands for two groups.
    if (part.includes(".")) {
      const group = ipv4Group(part);
      if (group === undefined) return undefined;
      groups.push(Math.floor(group / 256), group % 256);
      continue;
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return undefined;
    groups.push(Number.parseInt(part, 16));
  }
  return groups;
}

function ipv6Value(address: string): bigint | undefined {
  const halves = address.split("::");
  if (halves.length > 2) return undefined;
  const left = ipv6Groups(halves[0] ?? "");
  if (left === undefined) return undefined;
  let groups: number[];
  if (halves.length === 2) {
    const right = ipv6Groups(halves[1] ?? "");
    if (right === undefined) return undefined;
    const missing = 8 - left.length - right.length;
    if (missing < 1) return undefined;
    groups = [...left, ...Array.from({ length: missing }, () => 0), ...right];
  } else {
    groups = [...left];
  }
  if (groups.length !== 8) return undefined;
  let value = 0n;
  for (const group of groups) {
    value = (value << 16n) | BigInt(group);
  }
  return value;
}

/**
 * The class of an allowed listen address, or undefined when it must be
 * refused. A wildcard (`0.0.0.0`, `::`) is always undefined.
 */
export function listenAddressKind(
  address: string,
): ListenAddressKind | undefined {
  const version = isIP(address);
  if (version === 4) {
    const bytes = ipv4Bytes(address);
    if (bytes === undefined) return undefined;
    const [first = 0, second = 0] = bytes;
    if (first === 0 && second === 0 && bytes.every((byte) => byte === 0)) {
      return undefined;
    }
    if (first === 127) return "loopback";
    if (first === 10) return "private";
    if (first === 172 && second >= 16 && second <= 31) return "private";
    if (first === 192 && second === 168) return "private";
    if (first === 169 && second === 254) return "link-local";
    if (first === 100 && second >= 64 && second <= 127) return "tailscale";
    return undefined;
  }
  if (version === 6) {
    const value = ipv6Value(address);
    if (value === undefined) return undefined;
    if (value === 0n) return undefined;
    if (value === 1n) return "loopback";
    // fe80::/10
    if (value >> 118n === 0x3fan) return "link-local";
    // fd7a:115c:a1e0::/48
    if (value >> 80n === 0xfd7a115ca1e0n) return "tailscale";
    return undefined;
  }
  return undefined;
}

/** True when `address` may be named in `http.listen`. */
export function isAllowedListenAddress(address: string): boolean {
  return listenAddressKind(address) !== undefined;
}

function refusal(address: string): string {
  if (address === "0.0.0.0" || address === "::") {
    return `http.listen: "${address}" is a wildcard address; name each address to listen on`;
  }
  return `http.listen: "${address}" is not a loopback, private, link-local or Tailscale address`;
}

/** Refuses the first entry that is not an allowed address, naming it. */
export function validateListenAddresses(listen: readonly string[]): void {
  if (listen.length === 0) {
    throw new ConfigError("http.listen: needs at least one address");
  }
  for (const address of listen) {
    if (isIP(address) === 0) {
      throw new ConfigError(
        `http.listen: "${address}" is not an IP address`,
      );
    }
    if (!isAllowedListenAddress(address)) {
      throw new ConfigError(refusal(address));
    }
  }
}
