/**
 * The search service: it brings the index up to date from the wiki, every bot's
 * memory and the chat records, then answers a search or a read. A backend only
 * stores and matches; this file owns what a scope means and what a result says.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JsonValue, ObjectStore } from "@operad-io/engine";
import { isRecord } from "@operad-io/engine";
import { lineCountOf, queryTerms, snippetOf } from "./chunks.ts";
import { splitMarkdown, titleFromName, titleOf } from "./frontmatter.ts";
import { SqliteSearchBackend } from "./backend.ts";
import {
  botMemoryDirectories,
  chatDocument,
  chatMessages,
  chatOwner,
  chatTitle,
  documentDirectory,
  documentPath,
  fileName,
  markdownFiles,
} from "./sources.ts";
import { wikiDirectory } from "../memory.ts";
import {
  SEARCH_SCOPES,
  SearchError,
  type AboutDocument,
  type BackendHit,
  type DocumentKey,
  type ReadRequest,
  type ReadResult,
  type SearchBackend,
  type SearchHit,
  type SearchRequest,
  type SearchResult,
  type SearchScope,
  type TokenizerName,
} from "./types.ts";

/** The index's file name under the operad home's `store/`. */
export const SEARCH_DATABASE_NAME = "search.sqlite";

/** Where the index lives: `<home>/store/search.sqlite`. Deleting it only costs a rebuild. */
export function searchDatabasePath(home: string): string {
  return join(home, "store", SEARCH_DATABASE_NAME);
}

/** The options a service opens with; a test replaces the file and tokenizer. */
export interface OpenSearchOptions {
  readonly file?: string | undefined;
  readonly tokenizer?: TokenizerName | undefined;
  readonly backend?: SearchBackend | undefined;
}

/** What one refresh changed. */
export interface RefreshStats {
  readonly indexed: number;
  readonly removed: number;
  readonly unchanged: number;
}

interface FileRoot {
  readonly scope: "wiki" | "memory";
  readonly owner: string;
  readonly directory: string;
}

function digestOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function rootsOf(home: string, settings: Readonly<Record<string, JsonValue>>): readonly FileRoot[] {
  const roots: FileRoot[] = [
    { scope: "wiki", owner: "", directory: wikiDirectory(home, settings) },
  ];
  for (const memory of botMemoryDirectories(home)) {
    roots.push({ scope: "memory", owner: dirname(memory), directory: memory });
  }
  return roots;
}

function documentId(root: FileRoot, file: string): string {
  const path = documentPath(file, root.directory);
  return root.scope === "wiki" ? `wiki:${path}` : `memory:${root.owner}:${path}`;
}

/** The scopes a request may reach; the default is all three. */
export function requestedScopes(scopes: readonly SearchScope[] | undefined): readonly SearchScope[] {
  if (scopes === undefined || scopes.length === 0) return [...SEARCH_SCOPES];
  const found: SearchScope[] = [];
  for (const scope of scopes) {
    if (!SEARCH_SCOPES.includes(scope)) throw new SearchError(`unknown scope "${scope}"`);
    if (!found.includes(scope)) found.push(scope);
  }
  return found;
}

/** A limit a caller may use: 20 by default, never more than 100. */
export function requestedLimit(limit: number | undefined): number {
  if (limit === undefined) return 20;
  if (!Number.isInteger(limit) || limit < 1) throw new SearchError("limit must be a whole number above zero");
  return Math.min(limit, 100);
}

function normaliseFields(
  fields: Readonly<Record<string, string | readonly string[]>> | undefined,
): Readonly<Record<string, readonly string[]>> | undefined {
  if (fields === undefined) return undefined;
  const found: Record<string, readonly string[]> = {};
  for (const [key, value] of Object.entries(fields)) {
    const values = typeof value === "string" ? [value] : value;
    const clean = values.filter((item) => item.length > 0);
    if (clean.length > 0) found[key.toLowerCase()] = clean;
  }
  return Object.keys(found).length === 0 ? undefined : found;
}

/** The search service over one index file. */
export class MemorySearch {
  readonly backend: SearchBackend;
  private readonly home: string;
  private readonly settings: Readonly<Record<string, JsonValue>>;

  constructor(home: string, settings: Readonly<Record<string, JsonValue>> = {}, options: OpenSearchOptions = {}) {
    this.home = home;
    this.settings = settings;
    this.backend =
      options.backend ??
      new SqliteSearchBackend({
        file: options.file ?? searchDatabasePath(home),
        ...(options.tokenizer === undefined ? {} : { tokenizer: options.tokenizer }),
      });
  }

  /**
   * Brings file documents and chat records up to date. A file whose size and
   * modification time did not change is left alone; a chat is compared by the
   * digest of its messages. A document whose file or chat is gone is removed.
   */
  async refresh(store?: ObjectStore | undefined): Promise<RefreshStats> {
    const known = new Map<string, DocumentKey>();
    for (const key of this.backend.keys()) known.set(key.id, key);
    const seen = new Set<string>();
    let indexed = 0;
    let unchanged = 0;

    for (const root of rootsOf(this.home, this.settings)) {
      for (const file of markdownFiles(root.directory)) {
        const id = documentId(root, file);
        seen.add(id);
        let stat;
        try {
          stat = statSync(file, { bigint: true });
        } catch {
          continue;
        }
        const mtimeNs = stat.mtimeNs.toString();
        const size = Number(stat.size);
        const before = this.backend.get(id);
        if (
          before !== undefined &&
          before.file === file &&
          before.mtimeNs === mtimeNs &&
          before.size === size
        ) {
          unchanged += 1;
          continue;
        }
        let raw: string;
        try {
          raw = readFileSync(file, "utf8");
        } catch {
          continue;
        }
        const { fields, body } = splitMarkdown(raw);
        const name = fileName(file);
        const title = titleOf(fields, body, titleFromName(name));
        this.backend.put({
          id,
          scope: root.scope,
          owner: root.owner,
          file,
          path: documentPath(file, root.directory),
          directory: documentDirectory(file, root.directory),
          name,
          title,
          text: body,
          fields,
          lineCount: lineCountOf(body),
          digest: digestOf(body),
          mtimeMs: Number(stat.mtimeMs),
          mtimeNs,
          size,
        });
        indexed += 1;
      }
    }

    let removed = 0;
    for (const key of this.backend.keys()) {
      if (key.file === undefined) continue;
      if (seen.has(key.id)) continue;
      this.backend.remove(key.id);
      removed += 1;
    }

    if (store !== undefined) {
      const chats = await this.refreshChats(store);
      indexed += chats.indexed;
      unchanged += chats.unchanged;
      removed += chats.removed;
    }
    return { indexed, removed, unchanged };
  }

  private async refreshChats(store: ObjectStore): Promise<RefreshStats> {
    const seen = new Set<string>();
    let indexed = 0;
    let unchanged = 0;
    let cursor: string | undefined;
    do {
      const page = await store.list("chat", { ...(cursor === undefined ? {} : { cursor }), limit: 200 });
      for (const object of page.objects) {
        const owner = chatOwner(object.data);
        if (owner === undefined) continue;
        const id = `chat:${object.id}`;
        seen.add(id);
        const title = chatTitle(object.id, object.data);
        const text = chatDocument(object.id, title, chatMessages(store, object.id));
        const digest = digestOf(text);
        const before = this.backend.get(id);
        if (before?.digest === digest) {
          unchanged += 1;
          continue;
        }
        this.backend.put({
          id,
          scope: "chats",
          owner,
          directory: "",
          name: "",
          title,
          text,
          fields: {},
          lineCount: lineCountOf(text),
          digest,
        });
        indexed += 1;
      }
      cursor = page.next;
    } while (cursor !== undefined);
    let removed = 0;
    for (const key of this.backend.keys()) {
      if (key.scope !== "chats" || seen.has(key.id)) continue;
      this.backend.remove(key.id);
      removed += 1;
    }
    return { indexed, removed, unchanged };
  }

  /** Answers a search over the scopes this bot may reach. */
  search(request: SearchRequest): SearchResult {
    const query = request.text.trim();
    if (query.length === 0) throw new SearchError("search needs a query");
    const scopes = requestedScopes(request.scopes);
    const limit = requestedLimit(request.limit);
    const fields = normaliseFields(request.fields);
    const hits = this.backend.search({
      text: query,
      scopes,
      owner: request.cwd,
      ...(fields === undefined ? {} : { fields }),
      limit,
    });
    const terms = queryTerms(query);
    const found = new Map<string, BackendHit>();
    for (const hit of hits) {
      // A backend returns chunks; a reader wants the best chunk per document.
      const before = found.get(hit.id);
      if (before === undefined || hit.score > before.score) found.set(hit.id, hit);
    }
    const results: SearchHit[] = [];
    const about = new Map<string, AboutDocument>();
    for (const hit of found.values()) {
      const document = this.backend.get(hit.id);
      if (document === undefined) continue;
      results.push({
        id: document.id,
        scope: document.scope,
        title: document.title,
        ...(document.path === undefined ? {} : { path: document.path }),
        lineStart: hit.lineStart,
        lineEnd: hit.lineEnd,
        snippet: snippetOf(hit.text, terms),
        score: hit.score,
        fields: document.fields,
      });
      const key = `${document.scope}\u0000${document.owner}\u0000${document.directory}`;
      if (about.has(key)) continue;
      const description = this.backend.about(document.scope, document.owner, document.directory);
      if (description === undefined) continue;
      about.set(key, { id: description.id, title: description.title, text: description.text.trim() });
    }
    results.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
    return { query, scopes, hits: results.slice(0, limit), about: [...about.values()] };
  }

  /** Reads one document, or the requested line range of it. */
  read(request: ReadRequest): ReadResult {
    const document = this.backend.get(request.id);
    if (document === undefined) {
      throw new SearchError(
        `no document "${request.id}" in the index; search first, or check that the wiki and memory directory still exist`,
      );
    }
    const lines = document.text.length === 0 ? [] : document.text.split(/\r?\n/u);
    const total = lines.length;
    let from = request.from ?? 1;
    let to = request.to ?? total;
    if (!Number.isInteger(from) || from < 1) throw new SearchError("from must be a whole line number above zero");
    if (!Number.isInteger(to) || to < 1) throw new SearchError("to must be a whole line number above zero");
    from = Math.min(from, Math.max(1, total));
    to = Math.min(to, total);
    if (to < from) to = from;
    return {
      id: document.id,
      scope: document.scope,
      title: document.title,
      ...(document.path === undefined ? {} : { path: document.path }),
      lineStart: total === 0 ? 0 : from,
      lineEnd: total === 0 ? 0 : to,
      totalLines: total,
      text: total === 0 ? "" : lines.slice(from - 1, to).join("\n"),
      fields: document.fields,
    };
  }

  close(): void {
    this.backend.close();
  }
}

/** Opens the index a home uses, with the memory plugin's settings. */
export function openMemorySearch(
  home: string,
  settings: Readonly<Record<string, JsonValue>> = {},
  options: OpenSearchOptions = {},
): MemorySearch {
  return new MemorySearch(home, settings, options);
}

/** Whether a parsed value can be a field filter. */
export function fieldFiltersOf(value: unknown): Record<string, string | readonly string[]> | undefined {
  if (!isRecord(value)) return undefined;
  const found: Record<string, string | readonly string[]> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") found[key] = item;
    else if (Array.isArray(item)) {
      const values = item.filter((entry): entry is string => typeof entry === "string");
      if (values.length > 0) found[key] = values;
    } else {
      throw new SearchError(`field filter "${key}" must be text or a list of text`);
    }
  }
  return Object.keys(found).length === 0 ? undefined : found;
}
