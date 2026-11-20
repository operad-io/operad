/**
 * The wiki as read-only objects: one type for its folders and one for its
 * notes. The objects are a projection of the Markdown directory, rebuilt from
 * it before the first read and again on every directory change a running
 * `serve` watches. The wiki files remain the only copy of anything; a note's
 * content is read from its file when a client opens the section.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ViewError,
  type JsonValue,
  type ObjectRow,
  type ObjectStore,
  type ObjectViews,
  type SectionContent,
  type StoredObject,
  type ViewContext,
  type ViewSection,
} from "@operad-io/engine";
import { parseNoteLinksWithPositions, resolveNoteLink, normaliseNotePath } from "./links.ts";
import { splitMarkdown, titleFromName, titleOf } from "./search/frontmatter.ts";
import { openMemorySearch, untrustedFields, type MemorySearch } from "./search/service.ts";
import type { Backlink } from "./search/types.ts";
import { wikiDirectory } from "./memory.ts";

/** The object type of a wiki folder; its title is `Wiki`. */
export const WIKI_FOLDER_TYPE = "wiki";

/** The object type of a wiki note. */
export const WIKI_NOTE_TYPE = "note";

/** The section that holds a note's Markdown. */
export const WIKI_CONTENT_SECTION = "content";

/** The section that lists the notes linking to a note; absent when none do. */
export const WIKI_BACKLINKS_SECTION = "backlinks";

/** The most characters one page of a long note holds. */
export const WIKI_PAGE_CHARS = 20_000;

/** A note as the projection stores it. */
interface NoteData {
  readonly path: string;
  readonly title: string;
  readonly parent?: string | undefined;
  readonly mtimeMs: number;
  readonly untrusted: boolean;
  readonly removed: boolean;
  readonly backlinks: readonly BacklinkData[];
}

/** One note that links to a note, as the Backlinks section returns it. */
interface BacklinkData {
  /** The full object id a client opens (`note:<path>`). */
  readonly object: string;
  readonly path: string;
  readonly title: string;
  readonly target: string;
  readonly heading?: string | undefined;
  readonly kind: "wikilink" | "markdown";
  readonly line: number;
  readonly excerpt: string;
  readonly untrusted: boolean;
}

/** A folder as the projection stores it. */
interface FolderData {
  readonly path: string;
  readonly title: string;
  readonly parent?: string | undefined;
  readonly noteCount: number;
  readonly removed: boolean;
}

/** One link in a note's content, with the note it points at when resolved. */
interface LinkData {
  readonly target: string;
  readonly heading?: string | undefined;
  readonly kind: "wikilink" | "markdown";
  /** The full object id of the target note; absent while nothing matches it. */
  readonly object?: string | undefined;
}

function parentPath(path: string): string | undefined {
  const at = path.lastIndexOf("/");
  return at < 0 ? undefined : path.slice(0, at);
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function removedFlag(value: unknown): boolean {
  return value === true;
}

function folderOf(object: StoredObject): FolderData {
  const data = object.data;
  const parent = textOf(data["parent"]);
  return {
    path: textOf(data["path"]) ?? object.id,
    title: textOf(data["title"]) ?? basename(object.id),
    ...(parent === undefined ? {} : { parent }),
    noteCount: numberField(data["noteCount"]),
    removed: removedFlag(data["removed"]),
  };
}

function noteOf(object: StoredObject): NoteData {
  const data = object.data;
  const parent = textOf(data["parent"]);
  const backlinks = Array.isArray(data["backlinks"])
    ? data["backlinks"].filter((entry): entry is BacklinkData => {
        if (typeof entry !== "object" || entry === null) return false;
        const record = entry as Record<string, unknown>;
        return (
          typeof record["object"] === "string" &&
          typeof record["path"] === "string" &&
          typeof record["title"] === "string" &&
          typeof record["target"] === "string" &&
          (record["kind"] === "wikilink" || record["kind"] === "markdown") &&
          typeof record["line"] === "number" &&
          typeof record["excerpt"] === "string" &&
          typeof record["untrusted"] === "boolean"
        );
      })
    : [];
  return {
    path: textOf(data["path"]) ?? object.id,
    title: textOf(data["title"]) ?? basename(object.id),
    ...(parent === undefined ? {} : { parent }),
    mtimeMs: numberField(data["mtimeMs"]),
    untrusted: removedFlag(data["untrusted"]),
    removed: removedFlag(data["removed"]),
    backlinks,
  };
}

function noteCountText(count: number): string {
  return `${count} ${count === 1 ? "note" : "notes"}`;
}

function modifiedText(mtimeMs: number): string {
  return mtimeMs > 0 ? new Date(mtimeMs).toISOString() : "";
}

function noteRow(object: StoredObject): ObjectRow {
  const note = noteOf(object);
  const modified = modifiedText(note.mtimeMs);
  const noteLine = note.untrusted
    ? `${modified}${modified.length === 0 ? "" : " "}(untrusted)`
    : modified;
  return {
    id: object.id,
    title: note.title,
    state: note.removed ? "removed" : "open",
    ...(noteLine.length === 0 ? {} : { note: noteLine }),
    ...(note.parent === undefined || note.removed ? {} : { parent: note.parent }),
  };
}

function folderRow(object: StoredObject): ObjectRow {
  const folder = folderOf(object);
  return {
    id: object.id,
    title: folder.title,
    state: folder.removed ? "removed" : "open",
    note: noteCountText(folder.noteCount),
    ...(folder.parent === undefined || folder.removed ? {} : { parent: folder.parent }),
  };
}

/** Whether a path a client named is a path inside the wiki, as an id. */
export function wikiObjectPath(id: string): string | undefined {
  if (isAbsolute(id) || id.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(id)) return undefined;
  return normaliseNotePath(id);
}

/** The folder path an id names; a path outside the wiki is refused. */
export function resolveWikiFolderId(id: string): string | undefined {
  const path = wikiObjectPath(id);
  if (path === undefined) {
    throw new ViewError("args", `"${id}" is not a path inside the wiki`);
  }
  return /\.(?:md|markdown)$/iu.test(path) ? undefined : path;
}

/** The note path an id names; a path outside the wiki is refused. */
export function resolveWikiNoteId(id: string): string | undefined {
  const path = wikiObjectPath(id);
  if (path === undefined) {
    throw new ViewError("args", `"${id}" is not a path inside the wiki`);
  }
  return /\.(?:md|markdown)$/iu.test(path) ? path : undefined;
}

/** The file an id names under `root`, or undefined when it leaves the wiki. */
export function wikiNoteFile(root: string, id: string): string | undefined {
  const path = wikiObjectPath(id);
  if (path === undefined) return undefined;
  const file = resolve(root, path);
  const rel = relative(root, file);
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return file;
}

interface ScannedNote {
  readonly path: string;
  readonly file: string;
  readonly title: string;
  readonly mtimeMs: number;
  readonly untrusted: boolean;
}

interface WikiScan {
  readonly folders: readonly string[];
  readonly notes: readonly ScannedNote[];
}

/** Every folder and Markdown note under the wiki, hidden directories left out. */
function scanWiki(root: string): WikiScan {
  const folders: string[] = [];
  const notes: ScannedNote[] = [];
  const visit = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const file = join(directory, entry.name);
      if (entry.isDirectory()) {
        const path = relative(root, file).split(sep).join("/");
        folders.push(path);
        visit(file);
        continue;
      }
      if (!entry.isFile() || !/\.(?:md|markdown)$/iu.test(entry.name)) continue;
      let raw: string;
      let stat;
      try {
        raw = readFileSync(file, "utf8");
        stat = statSync(file);
      } catch {
        continue;
      }
      const { fields, body } = splitMarkdown(raw);
      notes.push({
        path: relative(root, file).split(sep).join("/"),
        file,
        title: titleOf({}, body, titleFromName(entry.name)),
        mtimeMs: stat.mtimeMs,
        untrusted: untrustedFields(fields),
      });
    }
  };
  visit(root);
  return { folders, notes };
}

function backlinkData(entries: readonly Backlink[]): readonly BacklinkData[] {
  return entries.map((entry) => ({
    object: `${WIKI_NOTE_TYPE}:${entry.path}`,
    path: entry.path,
    title: entry.title,
    target: entry.target,
    ...(entry.heading === undefined ? {} : { heading: entry.heading }),
    kind: entry.kind,
    line: entry.line,
    excerpt: entry.excerpt,
    untrusted: entry.untrusted,
  }));
}

async function putIfChanged(
  store: ObjectStore,
  type: string,
  id: string,
  data: Readonly<Record<string, unknown>>,
): Promise<void> {
  const current = await store.get(type, id);
  if (current !== undefined && JSON.stringify(current.data) === JSON.stringify(data)) return;
  await store.put(type, id, data, "memory");
}

async function markRemoved(
  store: ObjectStore,
  type: string,
  seen: ReadonlySet<string>,
): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await store.list(type, { ...(cursor === undefined ? {} : { cursor }) });
    for (const object of page.objects) {
      if (seen.has(object.id) || object.data["removed"] === true) continue;
      await store.put(type, object.id, { ...object.data, removed: true }, "memory");
    }
    cursor = page.next;
  } while (cursor !== undefined);
}

/**
 * Brings the wiki objects up to date with the Markdown directory, using the
 * link table for a note's backlinks. With a search given, the caller owns it;
 * without one, this opens and closes its own.
 */
export async function syncWikiObjects(
  store: ObjectStore,
  home: string,
  settings: Readonly<Record<string, JsonValue>> = {},
  search: MemorySearch | undefined = undefined,
): Promise<void> {
  const root = wikiDirectory(home, settings);
  const scanned = scanWiki(root);
  const own = search ?? openMemorySearch(home, settings);
  try {
    await own.refresh(store);
    const counts = new Map<string, number>();
    for (const note of scanned.notes) {
      let parent = parentPath(note.path);
      while (parent !== undefined) {
        counts.set(parent, (counts.get(parent) ?? 0) + 1);
        parent = parentPath(parent);
      }
    }

    const seenFolders = new Set<string>();
    for (const path of scanned.folders) {
      const parent = parentPath(path);
      const data: Record<string, unknown> = {
        path,
        title: path.slice(path.lastIndexOf("/") + 1),
        noteCount: counts.get(path) ?? 0,
        removed: false,
      };
      if (parent !== undefined) data["parent"] = parent;
      seenFolders.add(path);
      await putIfChanged(store, WIKI_FOLDER_TYPE, path, data);
    }

    const seenNotes = new Set<string>();
    for (const note of scanned.notes) {
      const backlinks = backlinkData(own.readBacklinks(`wiki:${note.path}`));
      const parent = parentPath(note.path);
      const data: Record<string, unknown> = {
        path: note.path,
        title: note.title,
        mtimeMs: note.mtimeMs,
        untrusted: note.untrusted,
        removed: false,
        backlinks,
      };
      if (parent !== undefined) data["parent"] = parent;
      seenNotes.add(note.path);
      await putIfChanged(store, WIKI_NOTE_TYPE, note.path, data);
    }

    await markRemoved(store, WIKI_FOLDER_TYPE, seenFolders);
    await markRemoved(store, WIKI_NOTE_TYPE, seenNotes);
  } finally {
    if (search === undefined) own.close();
  }
}

/** Every note path the store holds now, for resolving a link. */
async function notePaths(store: ObjectStore): Promise<readonly string[]> {
  const found: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list(WIKI_NOTE_TYPE, {
      ...(cursor === undefined ? {} : { cursor }),
      limit: 1000,
    });
    for (const object of page.objects) {
      const note = noteOf(object);
      if (!note.removed) found.push(note.path);
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return found;
}

/** The links in a note's body, with the note each one resolves to. */
async function linksIn(store: ObjectStore, source: string, body: string): Promise<readonly LinkData[]> {
  const notes = await notePaths(store);
  return parseNoteLinksWithPositions(body).map(({ at: _at, ...link }) => {
    const target = resolveNoteLink(source, link, notes);
    return {
      target: link.target,
      ...(link.heading === undefined ? {} : { heading: link.heading }),
      kind: link.kind,
      ...(target === undefined ? {} : { object: `${WIKI_NOTE_TYPE}:${target}` }),
    };
  });
}

function escapeLabel(text: string): string {
  return text.replace(/[\\[\]]/gu, "\\$&");
}

function backlinkMarkdown(entries: readonly BacklinkData[]): string {
  return entries
    .map((entry) => {
      const line = entry.line > 0 ? ` line ${entry.line}` : "";
      const mark = entry.untrusted ? " (untrusted)" : "";
      const excerpt = entry.excerpt.length > 0 ? ` — ${entry.excerpt}` : "";
      const href = `operad://objects/${encodeURIComponent(entry.object)}`;
      return `- [${escapeLabel(entry.title)}](${href})${line}${mark}${excerpt}`;
    })
    .join("\n");
}

/** Splits a note's text into pages of at most {@link WIKI_PAGE_CHARS}, at a line when possible. */
function textPages(text: string): readonly string[] {
  if (text.length <= WIKI_PAGE_CHARS) return [text];
  const pages: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + WIKI_PAGE_CHARS);
    if (end < text.length) {
      const at = text.lastIndexOf("\n", end);
      if (at > start) end = at + 1;
    }
    pages.push(text.slice(start, end));
    start = end;
  }
  return pages.length === 0 ? [""] : pages;
}

function pageOf(text: string, cursor: string | undefined): SectionContent {
  const pages = textPages(text);
  const index = cursor === undefined ? 0 : Number(cursor);
  if (!Number.isInteger(index) || index < 0 || index >= pages.length) {
    return { markdown: "" };
  }
  return {
    markdown: pages[index] ?? "",
    ...(index + 1 >= pages.length ? {} : { next: String(index + 1) }),
    ...(pages.length <= 1
      ? {}
      : {
          pages: pages.map((_page, at) => ({
            label: String(at + 1),
            ...(at === 0 ? {} : { cursor: String(at) }),
          })),
        }),
  };
}

async function loadNote(
  ctx: ViewContext,
  object: StoredObject,
  sectionId: string,
  cursor: string | undefined,
): Promise<SectionContent> {
  const note = noteOf(object);
  if (note.removed) throw new Error(`the wiki note "${note.path}" is gone`);
  if (sectionId === WIKI_BACKLINKS_SECTION) {
    return {
      markdown: backlinkMarkdown(note.backlinks),
      data: { backlinks: note.backlinks as unknown as JsonValue },
    };
  }
  if (sectionId !== WIKI_CONTENT_SECTION) return { markdown: "" };
  const root = wikiDirectory(ctx.home, ctx.settings);
  const file = wikiNoteFile(root, note.path);
  if (file === undefined) {
    throw new ViewError("args", `the wiki note "${note.path}" is outside the wiki`);
  }
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw new Error(`the wiki note "${note.path}" cannot be read`);
  }
  const { body } = splitMarkdown(raw);
  const links = await linksIn(ctx.store, note.path, body);
  return {
    ...pageOf(body, cursor),
    data: { links: links as unknown as JsonValue },
  };
}

/** How a wiki folder appears: a row, its children and no actions. */
export const wikiFolderViews: ObjectViews = {
  row: folderRow,
  sections(): readonly ViewSection[] {
    return [];
  },
  load: (): SectionContent => ({ markdown: "" }),
};

/** How a wiki note appears: its content, then its backlinks when it has any. */
export const wikiNoteViews: ObjectViews = {
  row: noteRow,
  sections(object: StoredObject): readonly ViewSection[] {
    const note = noteOf(object);
    if (note.removed) return [];
    return [
      { id: WIKI_CONTENT_SECTION, title: "Note" },
      ...(note.backlinks.length === 0
        ? []
        : [{ id: WIKI_BACKLINKS_SECTION, title: "Backlinks" }]),
    ];
  },
  load: (ctx, object, sectionId, options) =>
    loadNote(ctx, object, sectionId, options.cursor),
};
