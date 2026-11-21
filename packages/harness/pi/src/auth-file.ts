/**
 * Reads pi's auth file as a shape, never as values: a credential's secret
 * strings are replaced as they stream past, so no secret reaches a string or
 * an object operad keeps. Only the top-level keys and which values are objects
 * survive, which is all `signedIn` needs.
 */

import { isMissingFile, isRecord } from "@operad-io/engine";
import { open } from "node:fs/promises";

const QUOTE = 0x22;
const COMMA = 0x2c;
const COLON = 0x3a;
const OPEN_ARRAY = 0x5b;
const BACKSLASH = 0x5c;
const CLOSE_ARRAY = 0x5d;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;

interface Frame {
  kind: "object" | "array";
  state: "key" | "colon" | "value" | "comma";
}

function isSpace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function isHex(byte: number): boolean {
  return (
    (byte >= 0x30 && byte <= 0x39) ||
    (byte >= 0x41 && byte <= 0x46) ||
    (byte >= 0x61 && byte <= 0x66)
  );
}

function isEscape(byte: number): boolean {
  return (
    byte === QUOTE ||
    byte === BACKSLASH ||
    byte === 0x2f ||
    byte === 0x62 ||
    byte === 0x66 ||
    byte === 0x6e ||
    byte === 0x72 ||
    byte === 0x74
  );
}

/** Turns a JSON stream into the same structure with every string value emptied. */
class JsonRedactor {
  readonly #out: number[] = [];
  readonly #frames: Frame[] = [];
  #root: "value" | "done" = "value";
  #inString = false;
  #stringValue = false;
  #escaped = false;
  #unicode = 0;
  #inScalar = false;
  #broken = false;

  get broken(): boolean {
    return this.#broken;
  }

  write(chunk: Uint8Array): void {
    for (let at = 0; at < chunk.length && !this.#broken; at += 1) {
      this.#step(chunk[at] ?? 0);
    }
  }

  finish(): string | undefined {
    if (this.#broken || this.#inString || this.#escaped || this.#unicode > 0) {
      return undefined;
    }
    if (this.#inScalar) {
      this.#inScalar = false;
      this.#complete();
    }
    if (this.#frames.length > 0 || this.#root !== "done") return undefined;
    return new TextDecoder().decode(Uint8Array.from(this.#out));
  }

  #push(byte: number): void {
    this.#out.push(byte);
  }

  #top(): Frame | undefined {
    return this.#frames[this.#frames.length - 1];
  }

  #topKind(): "object" | "array" | undefined {
    return this.#top()?.kind;
  }

  #topState(state: Frame["state"]): void {
    const top = this.#top();
    if (top === undefined) {
      this.#broken = true;
      return;
    }
    top.state = state;
  }

  #expectsKey(): boolean {
    const top = this.#top();
    return top?.kind === "object" && top.state === "key";
  }

  #colonState(): boolean {
    const top = this.#top();
    return top?.kind === "object" && top.state === "colon";
  }

  #expectsValue(): boolean {
    if (this.#frames.length === 0) return this.#root === "value";
    return this.#top()?.state === "value";
  }

  #commaState(): boolean {
    return this.#top()?.state === "comma";
  }

  #complete(): void {
    if (this.#frames.length === 0) {
      this.#root = "done";
      return;
    }
    this.#topState("comma");
  }

  #close(byte: number): void {
    this.#push(byte);
    if (this.#frames.pop() === undefined) {
      this.#broken = true;
      return;
    }
    this.#complete();
  }

  #value(byte: number): void {
    if (byte === OPEN_OBJECT) {
      this.#push(byte);
      this.#frames.push({ kind: "object", state: "key" });
      return;
    }
    if (byte === OPEN_ARRAY) {
      this.#push(byte);
      this.#frames.push({ kind: "array", state: "value" });
      return;
    }
    if (byte === QUOTE) {
      this.#push(byte);
      this.#inString = true;
      this.#stringValue = true;
      return;
    }
    if (byte === CLOSE_OBJECT || byte === CLOSE_ARRAY || byte === COMMA || byte === COLON) {
      this.#broken = true;
      return;
    }
    this.#push(byte);
    this.#inScalar = true;
  }

  #string(byte: number): void {
    if (this.#unicode > 0) {
      if (!isHex(byte)) {
        this.#broken = true;
        return;
      }
      if (!this.#stringValue) this.#push(byte);
      this.#unicode -= 1;
      return;
    }
    if (this.#escaped) {
      this.#escaped = false;
      if (byte === 0x75) {
        this.#unicode = 4;
        if (!this.#stringValue) this.#push(byte);
        return;
      }
      if (!isEscape(byte)) {
        this.#broken = true;
        return;
      }
      if (!this.#stringValue) this.#push(byte);
      return;
    }
    if (byte === BACKSLASH) {
      this.#escaped = true;
      if (!this.#stringValue) this.#push(byte);
      return;
    }
    if (byte === QUOTE) {
      this.#inString = false;
      this.#push(byte);
      if (this.#stringValue) {
        this.#stringValue = false;
        this.#complete();
      } else {
        this.#topState("colon");
      }
      return;
    }
    if (byte < 0x20) {
      this.#broken = true;
      return;
    }
    if (!this.#stringValue) this.#push(byte);
  }

  #step(byte: number): void {
    if (this.#inString) {
      this.#string(byte);
      return;
    }
    if (this.#inScalar) {
      if (isSpace(byte) || byte === COMMA || byte === CLOSE_ARRAY || byte === CLOSE_OBJECT) {
        this.#inScalar = false;
        this.#complete();
        this.#step(byte);
        return;
      }
      if (byte === OPEN_OBJECT || byte === OPEN_ARRAY || byte === QUOTE || byte === COLON) {
        this.#broken = true;
        return;
      }
      this.#push(byte);
      return;
    }
    if (isSpace(byte)) {
      this.#push(byte);
      return;
    }
    if (this.#expectsKey()) {
      if (byte === QUOTE) {
        this.#push(byte);
        this.#inString = true;
        this.#stringValue = false;
        return;
      }
      if (byte === CLOSE_OBJECT) {
        this.#close(byte);
        return;
      }
      this.#broken = true;
      return;
    }
    if (this.#colonState()) {
      if (byte !== COLON) {
        this.#broken = true;
        return;
      }
      this.#push(byte);
      this.#topState("value");
      return;
    }
    if (this.#expectsValue()) {
      if (byte === CLOSE_ARRAY && this.#topKind() === "array") {
        this.#close(byte);
        return;
      }
      this.#value(byte);
      return;
    }
    if (this.#commaState()) {
      if (byte === COMMA) {
        this.#push(byte);
        this.#topState(this.#topKind() === "object" ? "key" : "value");
        return;
      }
      if (
        (byte === CLOSE_OBJECT && this.#topKind() === "object") ||
        (byte === CLOSE_ARRAY && this.#topKind() === "array")
      ) {
        this.#close(byte);
        return;
      }
    }
    this.#broken = true;
  }
}

/**
 * The redacted JSON text for these chunks: keys and structure kept, every
 * string value emptied; undefined when the text is not JSON.
 */
export function redactJsonValues(chunks: Iterable<Uint8Array>): string | undefined {
  const redactor = new JsonRedactor();
  for (const chunk of chunks) {
    redactor.write(chunk);
    if (redactor.broken) return undefined;
  }
  const redacted = redactor.finish();
  if (redacted === undefined) return undefined;
  try {
    JSON.parse(redacted);
  } catch {
    return undefined;
  }
  return redacted;
}

function hasCredential(auth: Record<string, unknown>, provider: string | undefined): boolean {
  const stored = (id: string): boolean => Object.hasOwn(auth, id) && isRecord(auth[id]);
  return provider === undefined ? Object.keys(auth).some(stored) : stored(provider);
}

/**
 * Whether pi's auth file holds a credential for the provider it will use. The
 * file is streamed and its values are dropped as they pass, so no credential
 * value is kept or returned; a missing file means no credential (false), and
 * an unreadable or malformed one means it cannot tell (undefined).
 */
export async function authFileHasCredential(
  authPath: string,
  provider: string | undefined,
): Promise<boolean | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(authPath, "r");
  } catch (error) {
    return isMissingFile(error) ? false : undefined;
  }
  const redactor = new JsonRedactor();
  try {
    const buffer = new Uint8Array(64 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      redactor.write(buffer.subarray(0, bytesRead));
      if (redactor.broken) return undefined;
    }
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
  const redacted = redactor.finish();
  if (redacted === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(redacted);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  return hasCredential(value, provider);
}
