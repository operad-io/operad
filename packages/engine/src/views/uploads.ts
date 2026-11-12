/**
 * Files a client sends for an action's argument. An upload is stored under the
 * operad home until an action takes it; taking moves it into the target
 * object's own attachment directory, so a reference works once. An upload no
 * action took within {@link UPLOAD_TTL_MS} is removed.
 */

import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { isRecord } from "../util.ts";

/** The largest file an upload takes, in bytes (20 MB). */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** How long an upload nobody used stays, in milliseconds. */
export const UPLOAD_TTL_MS = 60 * 60 * 1000;

/** The file name an action's `format` names: an argument that is a file. */
export const FILE_FORMAT = "file";

/** The upload is larger than {@link MAX_UPLOAD_BYTES}. */
export class UploadTooLargeError extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super(`the file is larger than the ${Math.floor(limit / (1024 * 1024))} MB limit`);
    this.name = "UploadTooLargeError";
    this.limit = limit;
  }
}

/** A reference that names no upload: never made, already used, or expired. */
export class UploadMissingError extends Error {
  constructor(ref: string) {
    super(`the upload "${ref}" is not there: it was already used, it expired, or it was never made`);
    this.name = "UploadMissingError";
  }
}

/** What an upload is, as the client is told. */
export interface UploadInfo {
  /** What a client passes as the action's file argument. */
  readonly ref: string;
  readonly name: string;
  readonly type: string;
  readonly size: number;
}

interface UploadMeta {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  readonly at: number;
}

const REF = /^up-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATA = "data";
const META = "meta.json";
const PART = ".part";

/** A file name that is safe as one path segment; the extension is kept. */
export function safeFileName(name: string): string {
  const base = basename(name.replace(/\\/g, "/")).replace(/[^\p{L}\p{N}._ +-]/gu, "_").trim();
  const cut = base.slice(-100).replace(/^\.+/, "");
  return cut.length === 0 ? "file" : cut;
}

/** The directory an object's attachments are stored in. */
export function attachmentDir(home: string, type: string, id: string): string {
  return join(home, "attachments", safeFileName(type), safeFileName(id));
}

export interface UploadsOptions {
  readonly home: string;
  readonly clock?: (() => number) | undefined;
  readonly ttlMs?: number | undefined;
  readonly limit?: number | undefined;
}

/** The upload store of one operad home. */
export class Uploads {
  private readonly root: string;
  private readonly clock: () => number;
  private readonly ttlMs: number;
  readonly limit: number;

  constructor(options: UploadsOptions) {
    this.root = join(options.home, "uploads");
    this.clock = options.clock ?? Date.now;
    this.ttlMs = options.ttlMs ?? UPLOAD_TTL_MS;
    this.limit = options.limit ?? MAX_UPLOAD_BYTES;
  }

  /**
   * Stores a stream as a new upload. Past the limit the stream is dropped and
   * nothing stays; the caller sees {@link UploadTooLargeError}.
   */
  async save(
    body: ReadableStream<Uint8Array> | null,
    name: string,
    type: string,
  ): Promise<UploadInfo> {
    const ref = `up-${randomUUID()}`;
    const part = join(this.root, `${ref}${PART}`);
    await mkdir(part, { recursive: true });
    const shown = safeFileName(name);
    const mediaType = type.trim().length > 0 ? type.trim().toLowerCase() : "application/octet-stream";
    try {
      // The start time goes first, so a sweep can tell how old an unfinished upload is.
      await writeFile(join(part, META), JSON.stringify({ name: shown, type: mediaType, size: 0, at: this.clock() }));
      let size = 0;
      const file = await open(join(part, DATA), "w");
      try {
        if (body !== null) {
          const reader = body.getReader();
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > this.limit) {
              await reader.cancel().catch(() => undefined);
              throw new UploadTooLargeError(this.limit);
            }
            await file.write(chunk.value);
          }
        }
      } finally {
        await file.close();
      }
      const meta: UploadMeta = { name: shown, type: mediaType, size, at: this.clock() };
      await writeFile(join(part, META), JSON.stringify(meta));
      await rename(part, join(this.root, ref));
      return { ref, name: shown, type: mediaType, size };
    } catch (error) {
      await rm(part, { recursive: true, force: true });
      throw error;
    }
  }

  /**
   * Moves the upload into `dir` and returns where its file is now. The move is
   * one rename, so two actions asking for the same reference cannot both get it.
   */
  async take(ref: string, dir: string): Promise<{ readonly path: string } & UploadInfo> {
    if (!REF.test(ref)) throw new UploadMissingError(ref);
    await mkdir(dir, { recursive: true });
    const target = join(dir, ref);
    try {
      await rename(join(this.root, ref), target);
    } catch {
      throw new UploadMissingError(ref);
    }
    const raw: unknown = JSON.parse(await readFile(join(target, META), "utf8"));
    const name = isRecord(raw) && typeof raw.name === "string" ? safeFileName(raw.name) : "file";
    const type = isRecord(raw) && typeof raw.type === "string" ? raw.type : "application/octet-stream";
    await rename(join(target, DATA), join(target, name));
    await rm(join(target, META), { force: true });
    const size = (await stat(join(target, name))).size;
    return { ref, name, type, size, path: join(target, name) };
  }

  /** Removes the uploads older than the time to keep one; returns how many went. */
  async sweep(): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const entry of names) {
      const dir = join(this.root, entry);
      let at: number;
      try {
        const raw: unknown = JSON.parse(await readFile(join(dir, META), "utf8"));
        if (!isRecord(raw) || typeof raw.at !== "number") continue;
        at = raw.at;
      } catch {
        continue;
      }
      if (this.clock() - at < this.ttlMs) continue;
      await rm(dir, { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  }
}
