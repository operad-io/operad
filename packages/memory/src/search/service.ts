/**
 * The search service: it brings the index up to date from the wiki, every bot's
 * memory and the chat records, then answers a search or a read. A backend only
 * stores and matches; this file owns what a scope means and what a result says.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { JsonValue, ObjectStore } from "@operad-io/engine";
import { isRecord } from "@operad-io/engine";
import { lineCountOf, queryTerms, snippetOf } from "./chunks.ts";
import { splitMarkdown, titleFromName, titleOf } from "./frontmatter.ts";
import { parseNoteLinks, parseNoteLinksWithPositions, resolveNoteLink } from "../links.ts";
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
  type Backlink,
  type DocumentFields,
  type DocumentKey,
  type LinkQuery,
  type NoteLinkInfo,
  type NoteLinkTarget,
  type ReadRequest,
  type ReadResult,
  type SearchBackend,
  type SearchHit,
  type SearchRequest,
  type SearchResult,
  type SearchScope,
  type StoredNoteLink,
  type TokenizerName,
  type UnresolvedTarget,
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
   * modification time did not change is left alone; a chat is left alone when
   * its latest fact sequence did not change, and is otherwise compared by the
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
          links: parseNoteLinks(body),
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
    this.resolveNoteLinks();
    return { indexed, removed, unchanged };
  }

  /**
   * Points the stored links at the notes the index holds now. Links are kept
   * when nothing matches them, so a note written under a name somebody already
   * linked to takes those links on this pass. Only changed rows are written.
   */
  private resolveNoteLinks(): void {
    const notes = this.backend.keys().filter((key) => key.file !== undefined && key.path !== undefined);
    const byId = new Map<string, DocumentKey>();
    const groups = new Map<string, { readonly paths: string[]; readonly ids: Map<string, string> }>();
    for (const note of notes) {
      byId.set(note.id, note);
      const group = `${note.scope}\u0000${note.owner}`;
      const entry = groups.get(group) ?? { paths: [], ids: new Map<string, string>() };
      if (note.path !== undefined) {
        entry.paths.push(note.path);
        entry.ids.set(note.path, note.id);
      }
      groups.set(group, entry);
    }
    const updates: NoteLinkTarget[] = [];
    for (const link of this.backend.allLinks()) {
      const source = byId.get(link.docId);
      if (source?.path === undefined) continue;
      const group = groups.get(`${source.scope}\u0000${source.owner}`);
      if (group === undefined) continue;
      const resolved = resolveNoteLink(source.path, link, group.paths);
      const targetId = resolved === undefined ? undefined : group.ids.get(resolved);
      if (targetId === link.targetId) continue;
      updates.push({
        docId: link.docId,
        ordinal: link.ordinal,
        ...(targetId === undefined ? {} : { targetId }),
      });
    }
    this.backend.setLinkTargets(updates);
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
        const revision = store.latestFactSequence?.({ type: "chat", id: object.id });
        const before = this.backend.get(id);
        // The latest fact sequence changes for a message and for the object
        // itself, so an unchanged chat is left alone without reading its facts.
        if (revision !== undefined && before?.mtimeNs === String(revision)) {
          unchanged += 1;
          continue;
        }
        const title = chatTitle(object.id, object.data);
        const text = chatDocument(object.id, title, chatMessages(store, object.id));
        const digest = digestOf(text);
        if (revision === undefined && before?.digest === digest) {
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
          ...(revision === undefined ? {} : { mtimeNs: String(revision) }),
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
      owner: resolve(request.cwd),
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
      backlinks: this.readBacklinks(document.id),
    };
  }

  /**
   * The notes that link to a note, with the line and excerpt around each link.
   * A linking note marked untrusted is still listed, and says so.
   */
  readBacklinks(id: string): readonly Backlink[] {
    const notes = this.noteKeys();
    const found: Backlink[] = [];
    for (const link of this.backend.allLinks()) {
      if (link.targetId !== id) continue;
      const source = notes.get(link.docId);
      const document = this.backend.get(link.docId);
      if (source === undefined || document === undefined) continue;
      const place = backlinkPlace(document.text, link);
      found.push({
        id: source.id,
        path: source.path ?? source.id,
        title: document.title,
        target: link.target,
        ...(link.heading === undefined ? {} : { heading: link.heading }),
        kind: link.kind,
        line: place.line,
        excerpt: place.excerpt,
        untrusted: untrustedFields(document.fields),
      });
    }
    return found;
  }

  /**
   * The links a note writes, resolved or not. The index answers from what the
   * last refresh stored; a caller refreshes first.
   */
  linksFrom(id: string): readonly NoteLinkInfo[] {
    const notes = this.noteKeys();
    return this.backend
      .allLinks()
      .filter((link) => link.docId === id)
      .map((link) => linkInfo(link, notes));
  }

  /** The links that point at a note, from the notes that write them. */
  backlinks(id: string): readonly NoteLinkInfo[] {
    const notes = this.noteKeys();
    return this.backend
      .allLinks()
      .filter((link) => link.targetId === id)
      .map((link) => linkInfo(link, notes));
  }

  /** The targets nobody wrote a note for, and how many links name each. */
  unresolvedTargets(query: LinkQuery = {}): readonly UnresolvedTarget[] {
    const notes = this.noteKeys();
    const counts = new Map<string, number>();
    for (const link of this.backend.allLinks()) {
      if (link.targetId !== undefined) continue;
      const source = notes.get(link.docId);
      if (source === undefined || !inQuery(source, query)) continue;
      counts.set(link.target, (counts.get(link.target) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([target, count]) => ({ target, count }))
      .sort((left, right) => right.count - left.count || left.target.localeCompare(right.target));
  }

  /** The notes no other note links to; a note that only links to itself is one. */
  orphanNotes(query: LinkQuery = {}): readonly DocumentKey[] {
    const notes = this.noteKeys();
    const linked = new Set<string>();
    for (const link of this.backend.allLinks()) {
      if (link.targetId === undefined || link.targetId === link.docId) continue;
      linked.add(link.targetId);
    }
    return [...notes.values()]
      .filter((note) => inQuery(note, query) && !linked.has(note.id))
      .sort((left, right) => (left.path ?? "").localeCompare(right.path ?? ""));
  }

  /** The note documents the index holds, by id; chats write no links. */
  private noteKeys(): ReadonlyMap<string, DocumentKey> {
    const found = new Map<string, DocumentKey>();
    for (const key of this.backend.keys()) {
      if (key.file === undefined) continue;
      found.set(key.id, key);
    }
    return found;
  }

  close(): void {
    this.backend.close();
  }
}

/** Whether a note's frontmatter marks it as coming from untrusted content. */
export function untrustedFields(fields: DocumentFields): boolean {
  return fields["untrusted"]?.some((value) => value.trim().toLowerCase() === "true") === true;
}

/** The line of a stored link and a short piece of the line around it. */
function backlinkPlace(text: string, link: StoredNoteLink): { readonly line: number; readonly excerpt: string } {
  const links = parseNoteLinksWithPositions(text);
  const place =
    links[link.ordinal] ??
    links.find(
      (entry) =>
        entry.kind === link.kind &&
        entry.target === link.target &&
        entry.heading === link.heading,
    );
  if (place === undefined) return { line: 0, excerpt: "" };
  const before = text.slice(0, place.at);
  const line = before.length === 0 ? 1 : before.split(/\r?\n/u).length;
  const start = text.lastIndexOf("\n", place.at - 1) + 1;
  const next = text.indexOf("\n", place.at);
  const written = text.slice(start, next < 0 ? text.length : next).trim();
  return { line, excerpt: snippetOf(written, [link.target]) };
}

/** Whether a document is inside the scope a link query names. */
function inQuery(document: DocumentKey, query: LinkQuery): boolean {
  if (query.scope !== undefined && document.scope !== query.scope) return false;
  if (query.owner !== undefined && document.owner !== query.owner) return false;
  return true;
}

/** One stored link with the paths of both ends the index knows. */
function linkInfo(link: StoredNoteLink, notes: ReadonlyMap<string, DocumentKey>): NoteLinkInfo {
  const from = notes.get(link.docId);
  const to = link.targetId === undefined ? undefined : notes.get(link.targetId);
  return {
    from: link.docId,
    ...(from?.path === undefined ? {} : { fromPath: from.path }),
    ...(link.targetId === undefined ? {} : { to: link.targetId }),
    ...(to?.path === undefined ? {} : { toPath: to.path }),
    target: link.target,
    ...(link.heading === undefined ? {} : { heading: link.heading }),
    kind: link.kind,
  };
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
