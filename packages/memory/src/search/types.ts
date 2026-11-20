/** The shapes the full-text index and the search tool share. */

/** What a search may cover. */
export const SEARCH_SCOPES = ["wiki", "memory", "chats"] as const;

/** One place a search reaches. */
export type SearchScope = (typeof SEARCH_SCOPES)[number];

/** The FTS5 tokenizer the index is built with. */
export type TokenizerName = "trigram" | "unicode61";

/** Frontmatter values, as text: a filter compares text to text. */
export type FrontmatterValue = string;

/** One document's frontmatter, each key with all of its values. */
export type DocumentFields = Readonly<Record<string, readonly FrontmatterValue[]>>;

/** One document as the backend stores it. */
export interface IndexedDocument {
  readonly id: string;
  readonly scope: SearchScope;
  /** The bot whose memory or chat this is; empty for the wiki. */
  readonly owner: string;
  /** The file the document was read from, for a file document. */
  readonly file?: string | undefined;
  /** The path shown to a reader: relative to the wiki or the bot's memory. */
  readonly path?: string | undefined;
  /** The document's directory inside its root, empty at the root. */
  readonly directory: string;
  /** The file name inside its directory, empty for a chat. */
  readonly name: string;
  readonly title: string;
  /** The searchable text without its frontmatter. */
  readonly text: string;
  readonly fields: DocumentFields;
  readonly lineCount: number;
  readonly digest: string;
  readonly mtimeMs?: number | undefined;
  /** The modification time with nanosecond precision, as text. */
  readonly mtimeNs?: string | undefined;
  readonly size?: number | undefined;
}

/** What a backend needs to know about a document without reading it. */
export interface DocumentKey {
  readonly id: string;
  readonly scope: SearchScope;
  readonly owner: string;
  readonly file?: string | undefined;
  readonly path?: string | undefined;
}

/** One chunk a backend matched, before the service adds the document around it. */
export interface BackendHit {
  readonly id: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly text: string;
  readonly score: number;
}

/** What one backend query holds. The caller has already restricted the scopes. */
export interface BackendQuery {
  readonly text: string;
  readonly scopes: readonly SearchScope[];
  /** The bot asking: only its memory and its chats are reachable. */
  readonly owner: string;
  readonly fields?: Readonly<Record<string, string | readonly string[]>> | undefined;
  readonly limit: number;
}

/**
 * The small interface another engine implements to replace SQLite FTS5. The
 * service owns indexing, scopes and the shape of a result; a backend owns
 * storage and matching.
 */
export interface SearchBackend {
  readonly tokenizer: TokenizerName;
  /** Writes one document whole, replacing an older version with the same id. */
  put(document: IndexedDocument): void;
  remove(id: string): void;
  get(id: string): IndexedDocument | undefined;
  /** Every document's key, so the indexer can remove what is gone. */
  keys(): readonly DocumentKey[];
  search(query: BackendQuery): readonly BackendHit[];
  /** The `_about.md` of one directory inside one scope, when there is one. */
  about(scope: SearchScope, owner: string, directory: string): IndexedDocument | undefined;
  close(): void;
}

/** What a person or a bot asks the service. */
export interface SearchRequest {
  readonly text: string;
  /** The working directory of the bot asking; its memory and chats are its own. */
  readonly cwd: string;
  readonly scopes?: readonly SearchScope[] | undefined;
  readonly fields?: Readonly<Record<string, string | readonly string[]>> | undefined;
  readonly limit?: number | undefined;
}

/** One search result. */
export interface SearchHit {
  readonly id: string;
  readonly scope: SearchScope;
  readonly title: string;
  readonly path?: string | undefined;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly snippet: string;
  readonly score: number;
  readonly fields: DocumentFields;
}

/** A directory's description, returned next to the hits found inside it. */
export interface AboutDocument {
  readonly id: string;
  readonly title: string;
  readonly text: string;
}

/** The answer to one search. */
export interface SearchResult {
  readonly query: string;
  readonly scopes: readonly SearchScope[];
  readonly hits: readonly SearchHit[];
  readonly about: readonly AboutDocument[];
}

/** What `read` asks for. Line numbers start at 1. */
export interface ReadRequest {
  readonly id: string;
  readonly from?: number | undefined;
  readonly to?: number | undefined;
}

/** One document, or the requested part of it. */
export interface ReadResult {
  readonly id: string;
  readonly scope: SearchScope;
  readonly title: string;
  readonly path?: string | undefined;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly totalLines: number;
  readonly text: string;
  readonly fields: DocumentFields;
}

/** A search or read that cannot be answered. */
export class SearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchError";
  }
}

/** Whether a value is one of the three scopes. */
export function isSearchScope(value: unknown): value is SearchScope {
  return value === "wiki" || value === "memory" || value === "chats";
}
