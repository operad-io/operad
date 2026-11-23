/**
 * The SQLite FTS5 backend. One file holds every document and its chunks; the
 * document table says which scope and owner a hit belongs to, which is how a
 * bot sees only its own memory and chats beside the shared wiki.
 *
 * The default tokenizer is `trigram`. It is the one measured on Chinese and
 * mixed text: `unicode61` takes a whole run of Chinese characters as one token,
 * so a word inside a sentence does not match. Trigram cannot match a query
 * shorter than three characters, so the backend falls back to a substring scan
 * for those terms.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { enableWal, setBusyTimeout, writeImmediate } from "@operad-io/engine/platform";
import { chunksOf, characterLength, queryTerms } from "./chunks.ts";
import {
  type BackendHit,
  type BackendQuery,
  type DocumentFields,
  type DocumentKey,
  type IndexedDocument,
  type NoteLinkTarget,
  type SearchBackend,
  type StoredNoteLink,
  type SearchScope,
  type TokenizerName,
} from "./types.ts";

interface DocumentRow {
  readonly id: string;
  readonly scope: string;
  readonly owner: string;
  readonly file: string | null;
  readonly path: string | null;
  readonly directory: string;
  readonly name: string;
  readonly title: string;
  readonly text: string;
  readonly fields: string;
  readonly line_count: number;
  readonly digest: string;
  readonly mtime_ms: number | null;
  readonly mtime_ns: string | null;
  readonly size: number | null;
}

interface KeyRow {
  readonly id: string;
  readonly scope: string;
  readonly owner: string;
  readonly file: string | null;
  readonly path: string | null;
}

interface MatchRow {
  readonly id: string;
  readonly line_start: number;
  readonly line_end: number;
  readonly text: string;
  readonly rank: number;
}

interface VersionRow {
  readonly value: string;
}

interface LinkRow {
  readonly doc_id: string;
  readonly ordinal: number;
  readonly target: string;
  readonly heading: string | null;
  readonly kind: string;
  readonly target_id: string | null;
  readonly line: number | null;
  readonly excerpt: string | null;
}

/** The options a backend opens with. */
export interface SqliteSearchBackendOptions {
  readonly file: string;
  readonly tokenizer?: TokenizerName | undefined;
}

/**
 * The version of the link table. A table from another version, and an index
 * built before there was one, is filled from the notes again.
 */
const LINK_TABLE_VERSION = "2";

function scopeOf(value: string): SearchScope {
  if (value === "wiki" || value === "chats") return value;
  return "memory";
}

function fieldsOf(text: string): DocumentFields {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const fields: Record<string, readonly string[]> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) continue;
      const values = value.filter((item): item is string => typeof item === "string");
      if (values.length > 0) fields[key] = values;
    }
    return fields;
  } catch {
    return {};
  }
}

function documentOf(row: DocumentRow): IndexedDocument {
  return {
    id: row.id,
    scope: scopeOf(row.scope),
    owner: row.owner,
    ...(row.file === null ? {} : { file: row.file }),
    ...(row.path === null ? {} : { path: row.path }),
    directory: row.directory,
    name: row.name,
    title: row.title,
    text: row.text,
    fields: fieldsOf(row.fields),
    lineCount: row.line_count,
    digest: row.digest,
    ...(row.mtime_ms === null ? {} : { mtimeMs: row.mtime_ms }),
    ...(row.mtime_ns === null ? {} : { mtimeNs: row.mtime_ns }),
    ...(row.size === null ? {} : { size: row.size }),
  };
}

function linkOf(row: LinkRow): StoredNoteLink {
  return {
    docId: row.doc_id,
    ordinal: row.ordinal,
    target: row.target,
    ...(row.heading === null ? {} : { heading: row.heading }),
    kind: row.kind === "wikilink" ? "wikilink" : "markdown",
    ...(row.target_id === null ? {} : { targetId: row.target_id }),
    ...(row.line === null ? {} : { line: row.line }),
    ...(row.excerpt === null ? {} : { excerpt: row.excerpt }),
  };
}

function quoteTerm(term: string): string {
  return `"${term.replace(/"/g, "\"\"")}"`;
}

function ftsQuery(terms: readonly string[]): string {
  return terms.map(quoteTerm).join(" OR ");
}

/** The default SQLite FTS5 backend. */
export class SqliteSearchBackend implements SearchBackend {
  readonly tokenizer: TokenizerName;
  private readonly db: Database;

  constructor(options: SqliteSearchBackendOptions) {
    this.tokenizer = options.tokenizer ?? "trigram";
    if (options.file !== ":memory:") mkdirSync(dirname(options.file), { recursive: true });
    this.db = new Database(options.file);
    setBusyTimeout(this.db);
    if (options.file !== ":memory:") enableWal(this.db);
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.run("CREATE TABLE IF NOT EXISTS search_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.db.run(
      "CREATE TABLE IF NOT EXISTS search_documents (" +
        "id TEXT PRIMARY KEY, scope TEXT NOT NULL, owner TEXT NOT NULL, file TEXT, path TEXT, " +
        "directory TEXT NOT NULL, name TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL, " +
        "fields TEXT NOT NULL, line_count INTEGER NOT NULL, digest TEXT NOT NULL, " +
        "mtime_ms REAL, mtime_ns TEXT, size INTEGER)",
    );
    // A store made before the nanosecond column existed gains it without a
    // version: the column is an optimisation, not the identity of a document.
    const columns = this.db.query<{ name: string }, []>("PRAGMA table_info(search_documents)").all();
    if (!columns.some((column) => column.name === "mtime_ns")) {
      this.db.run("ALTER TABLE search_documents ADD COLUMN mtime_ns TEXT");
    }
    this.db.run("CREATE INDEX IF NOT EXISTS search_documents_scope ON search_documents (scope, owner)");
    this.db.run("CREATE INDEX IF NOT EXISTS search_documents_file ON search_documents (file)");
    this.db.run(
      "CREATE TABLE IF NOT EXISTS search_fields (" +
        "doc_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, " +
        "PRIMARY KEY (doc_id, key, value))",
    );
    this.db.run("CREATE INDEX IF NOT EXISTS search_fields_lookup ON search_fields (key, value)");
    const current = this.db
      .query<VersionRow, []>("SELECT value FROM search_meta WHERE key = 'tokenizer'")
      .get();
    if (current !== null && current.value !== this.tokenizer) {
      // The index is a cache: a different tokenizer means a fresh one, links too.
      this.db.run("DROP TABLE IF EXISTS search_chunks");
      this.db.run("DROP TABLE IF EXISTS search_links");
      this.db.run("DELETE FROM search_fields");
      this.db.run("DELETE FROM search_documents");
    }
    // The link table is part of the same cache as the chunks. An index built
    // before it, or with another version of it, holds notes whose links were
    // never parsed, and a refresh skips a note whose modification time and
    // size did not change. Clearing that stored time makes the next refresh
    // read every note again and fill the table.
    const links = this.db
      .query<VersionRow, []>("SELECT value FROM search_meta WHERE key = 'links'")
      .get();
    if (links === null || links.value !== LINK_TABLE_VERSION) {
      this.db.run("DROP TABLE IF EXISTS search_links");
      this.db.run("UPDATE search_documents SET mtime_ns = NULL WHERE scope != 'chats'");
    }
    this.db.run(
      "CREATE TABLE IF NOT EXISTS search_links (" +
        "doc_id TEXT NOT NULL, ordinal INTEGER NOT NULL, target TEXT NOT NULL, heading TEXT, " +
        "kind TEXT NOT NULL, target_id TEXT, line INTEGER, excerpt TEXT, " +
        "PRIMARY KEY (doc_id, ordinal))",
    );
    this.db.run("CREATE INDEX IF NOT EXISTS search_links_target ON search_links (target_id)");
    this.db.run(
      "INSERT INTO search_meta (key, value) VALUES ('links', ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [LINK_TABLE_VERSION],
    );
    this.db.run(
      `CREATE VIRTUAL TABLE IF NOT EXISTS search_chunks USING fts5(` +
        `text, doc_id UNINDEXED, line_start UNINDEXED, line_end UNINDEXED, ` +
        `tokenize = '${this.tokenizer}')`,
    );
    this.db.run(
      "INSERT INTO search_meta (key, value) VALUES ('tokenizer', ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [this.tokenizer],
    );
  }

  put(document: IndexedDocument): void {
    writeImmediate(this.db, () => {
      this.db.run("DELETE FROM search_chunks WHERE doc_id = ?", [document.id]);
      this.db.run("DELETE FROM search_fields WHERE doc_id = ?", [document.id]);
      this.db.run("DELETE FROM search_links WHERE doc_id = ?", [document.id]);
      this.db.run(
        "INSERT INTO search_documents " +
          "(id, scope, owner, file, path, directory, name, title, text, fields, line_count, digest, mtime_ms, mtime_ns, size) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET scope = excluded.scope, owner = excluded.owner, " +
          "file = excluded.file, path = excluded.path, directory = excluded.directory, " +
          "name = excluded.name, title = excluded.title, text = excluded.text, " +
          "fields = excluded.fields, line_count = excluded.line_count, digest = excluded.digest, " +
          "mtime_ms = excluded.mtime_ms, mtime_ns = excluded.mtime_ns, size = excluded.size",
        [
          document.id,
          document.scope,
          document.owner,
          document.file ?? null,
          document.path ?? null,
          document.directory,
          document.name,
          document.title,
          document.text,
          JSON.stringify(document.fields),
          document.lineCount,
          document.digest,
          document.mtimeMs ?? null,
          document.mtimeNs ?? null,
          document.size ?? null,
        ],
      );
      const field = this.db.query(
        "INSERT OR IGNORE INTO search_fields (doc_id, key, value) VALUES (?, ?, ?)",
      );
      for (const [key, values] of Object.entries(document.fields)) {
        for (const value of values) field.run(document.id, key, value);
      }
      const chunk = this.db.query(
        "INSERT INTO search_chunks (text, doc_id, line_start, line_end) VALUES (?, ?, ?, ?)",
      );
      for (const piece of chunksOf(document.text)) {
        chunk.run(piece.text, document.id, piece.lineStart, piece.lineEnd);
      }
      const link = this.db.query(
        "INSERT INTO search_links (doc_id, ordinal, target, heading, kind, target_id, line, excerpt) " +
          "VALUES (?, ?, ?, ?, ?, NULL, ?, ?)",
      );
      (document.links ?? []).forEach((entry, ordinal) => {
        link.run(
          document.id,
          ordinal,
          entry.target,
          entry.heading ?? null,
          entry.kind,
          entry.line ?? null,
          entry.excerpt ?? null,
        );
      });
    });
  }

  remove(id: string): void {
    writeImmediate(this.db, () => {
      this.db.run("DELETE FROM search_chunks WHERE doc_id = ?", [id]);
      this.db.run("DELETE FROM search_fields WHERE doc_id = ?", [id]);
      this.db.run("DELETE FROM search_links WHERE doc_id = ?", [id]);
      // A link to a note that is gone is kept, with no target, so the note
      // that appears at that name takes it on the next resolution.
      this.db.run("UPDATE search_links SET target_id = NULL WHERE target_id = ?", [id]);
      this.db.run("DELETE FROM search_documents WHERE id = ?", [id]);
    });
  }

  get(id: string): IndexedDocument | undefined {
    const row = this.db
      .query<DocumentRow, [string]>(
        "SELECT id, scope, owner, file, path, directory, name, title, text, fields, " +
          "line_count, digest, mtime_ms, mtime_ns, size FROM search_documents WHERE id = ?",
      )
      .get(id);
    return row === null ? undefined : documentOf(row);
  }

  keys(): readonly DocumentKey[] {
    return this.db
      .query<KeyRow, []>("SELECT id, scope, owner, file, path FROM search_documents ORDER BY id")
      .all()
      .map((row) => ({
        id: row.id,
        scope: scopeOf(row.scope),
        owner: row.owner,
        ...(row.file === null ? {} : { file: row.file }),
        ...(row.path === null ? {} : { path: row.path }),
      }));
  }

  about(scope: SearchScope, owner: string, directory: string): IndexedDocument | undefined {
    const row = this.db
      .query<DocumentRow, [string, string, string]>(
        "SELECT id, scope, owner, file, path, directory, name, title, text, fields, " +
          "line_count, digest, mtime_ms, mtime_ns, size FROM search_documents " +
          "WHERE scope = ? AND owner = ? AND directory = ? AND name = '_about.md' LIMIT 1",
      )
      .get(scope, owner, directory);
    return row === null ? undefined : documentOf(row);
  }

  allLinks(): readonly StoredNoteLink[] {
    return this.db
      .query<LinkRow, []>(
        "SELECT doc_id, ordinal, target, heading, kind, target_id, line, excerpt FROM search_links " +
          "ORDER BY doc_id, ordinal",
      )
      .all()
      .map(linkOf);
  }

  linksTo(targetId: string): readonly StoredNoteLink[] {
    return this.db
      .query<LinkRow, [string]>(
        "SELECT doc_id, ordinal, target, heading, kind, target_id, line, excerpt FROM search_links " +
          "WHERE target_id = ? ORDER BY doc_id, ordinal",
      )
      .all(targetId)
      .map(linkOf);
  }

  setLinkTargets(updates: readonly NoteLinkTarget[]): void {
    if (updates.length === 0) return;
    writeImmediate(this.db, () => {
      const update = this.db.query(
        "UPDATE search_links SET target_id = ? WHERE doc_id = ? AND ordinal = ?",
      );
      for (const entry of updates) {
        update.run(entry.targetId ?? null, entry.docId, entry.ordinal);
      }
    });
  }

  search(query: BackendQuery): readonly BackendHit[] {
    const terms = queryTerms(query.text);
    if (terms.length === 0) return [];
    const long = terms.filter((term) => characterLength(term) >= 3);
    const short = terms.filter((term) => characterLength(term) < 3);
    const found = new Map<string, BackendHit>();
    const keyOf = (hit: BackendHit): string => (query.chunks === true ? `${hit.id}:${hit.lineStart}` : hit.id);
    // A tokenizer other than trigram is only used to measure it; the substring
    // fallback is what makes trigram's short-query gap harmless.
    const fallback = this.tokenizer === "trigram" && short.length > 0;
    if (long.length > 0) {
      for (const hit of this.matchFts(query, long)) found.set(keyOf(hit), hit);
    }
    if (fallback) {
      for (const hit of this.matchSubstring(query, short)) {
        const before = found.get(keyOf(hit));
        if (before === undefined || hit.score > before.score) found.set(keyOf(hit), hit);
      }
    } else if (long.length === 0) {
      // A non-trigram backend still asks FTS for its short terms.
      for (const hit of this.matchFts(query, short)) found.set(keyOf(hit), hit);
    }
    return [...found.values()]
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
      .slice(0, query.limit);
  }

  close(): void {
    this.db.close();
  }

  /** The scope, owner and frontmatter conditions every query shares. */
  private filters(query: BackendQuery): { readonly sql: readonly string[]; readonly params: readonly string[] } {
    const sql: string[] = [];
    const params: string[] = [];
    if (query.document !== undefined) {
      sql.push("d.id = ?");
      params.push(query.document);
    }
    const places = query.scopes.map(() => "?").join(", ");
    sql.push(`d.scope IN (${places})`);
    params.push(...query.scopes);
    if (query.document === undefined && query.scopes.some((scope) => scope !== "wiki")) {
      // The wiki is shared; a bot's memory and chats are only the ones whose
      // owner is the bot's working directory.
      sql.push("(d.scope = 'wiki' OR d.owner = ?)");
      params.push(query.owner);
    }
    for (const [key, value] of Object.entries(query.fields ?? {})) {
      const values = typeof value === "string" ? [value] : value;
      if (values.length === 0) continue;
      const list = values.map(() => "?").join(", ");
      sql.push(
        "EXISTS (SELECT 1 FROM search_fields f WHERE f.doc_id = d.id " +
          `AND f.key = ? AND f.value IN (${list}))`,
      );
      params.push(key.toLowerCase(), ...values);
    }
    return { sql, params };
  }

  private matchFts(query: BackendQuery, terms: readonly string[]): readonly BackendHit[] {
    const filter = this.filters(query);
    const sql =
      "SELECT d.id AS id, search_chunks.line_start AS line_start, " +
      "search_chunks.line_end AS line_end, search_chunks.text AS text, " +
      "bm25(search_chunks) AS rank FROM search_chunks " +
      "JOIN search_documents d ON d.id = search_chunks.doc_id " +
      `WHERE search_chunks MATCH ? AND ${filter.sql.join(" AND ")} ` +
      "ORDER BY rank LIMIT ?";
    const rows = this.db
      .query<MatchRow, (string | number)[]>(sql)
      .all(ftsQuery(terms), ...filter.params, query.limit * 4);
    return rows.map((row) => ({
      id: row.id,
      lineStart: row.line_start,
      lineEnd: row.line_end,
      text: row.text,
      score: -row.rank,
    }));
  }

  /**
   * Trigram cannot match fewer than three characters. These terms are found by
   * scanning the chunks the caller may see with `instr`, the documented
   * fallback; it is slower and bounded by the same scope and field filters.
   */
  private matchSubstring(query: BackendQuery, terms: readonly string[]): readonly BackendHit[] {
    const filter = this.filters(query);
    const any = terms.map(() => "instr(lower(search_chunks.text), lower(?)) > 0").join(" OR ");
    const sql =
      "SELECT d.id AS id, search_chunks.line_start AS line_start, " +
      "search_chunks.line_end AS line_end, search_chunks.text AS text, 0 AS rank " +
      "FROM search_chunks JOIN search_documents d ON d.id = search_chunks.doc_id " +
      `WHERE (${any}) AND ${filter.sql.join(" AND ")} ` +
      "ORDER BY d.id LIMIT ?";
    const rows = this.db
      .query<MatchRow, (string | number)[]>(sql)
      .all(...terms, ...filter.params, query.limit * 4);
    return rows.map((row) => {
      const text = row.text.toLocaleLowerCase();
      let at = -1;
      for (const term of terms) {
        const found = text.indexOf(term.toLocaleLowerCase());
        if (found >= 0 && (at < 0 || found < at)) at = found;
      }
      // Earlier is better, and a shorter chunk is a tighter answer.
      const score = 1 / (1 + Math.max(0, at)) + (terms.length === 1 ? 0.5 : 0);
      return {
        id: row.id,
        lineStart: row.line_start,
        lineEnd: row.line_end,
        text: row.text,
        score,
      };
    });
  }
}
