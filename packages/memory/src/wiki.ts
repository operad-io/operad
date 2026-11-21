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
import { placedNoteLinks, resolveNoteLink, normaliseNotePath, noteLookup } from "./links.ts";
import { splitMarkdown, titleFromName, titleOf } from "./search/frontmatter.ts";
import { untrustedFields, type MemorySearch } from "./search/service.ts";
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
  readonly links: readonly NoteLinkData[];
  /** Whether the stored data has a links list, so an index from before it is read again. */
  readonly linksKnown: boolean;
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

/** A link as the projection keeps it, with the place a backlink will show. */
interface NoteLinkData {
  readonly target: string;
  readonly heading?: string | undefined;
  readonly kind: "wikilink" | "markdown";
  readonly line: number;
  readonly excerpt: string;
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
  const rawLinks = data["links"];
  const linksKnown = Array.isArray(rawLinks);
  const links = linksKnown
    ? rawLinks.filter((entry): entry is NoteLinkData => {
        if (typeof entry !== "object" || entry === null) return false;
        const record = entry as Record<string, unknown>;
        return (
          typeof record["target"] === "string" &&
          (record["heading"] === undefined || typeof record["heading"] === "string") &&
          (record["kind"] === "wikilink" || record["kind"] === "markdown") &&
          typeof record["line"] === "number" &&
          typeof record["excerpt"] === "string" &&
          (record["object"] === undefined || typeof record["object"] === "string")
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
    links,
    linksKnown,
  };
}

function noteCountText(count: number): string {
  return `${count} ${count === 1 ? "note" : "notes"}`;
}

/**
 * A note's modification time as `YYYY-MM-DD HH:mm` in the given time zone, or
 * the process's local zone when none is given; empty for a zero time.
 */
export function wikiModifiedText(mtimeMs: number, timeZone?: string): string {
  if (mtimeMs <= 0) return "";
  const parts = new Intl.DateTimeFormat("en-GB", {
    ...(timeZone === undefined ? {} : { timeZone }),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(mtimeMs));
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
}

function noteRow(object: StoredObject): ObjectRow {
  const note = noteOf(object);
  const modified = wikiModifiedText(note.mtimeMs);
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

/** The folder path an id names; whether the wiki holds that folder is the caller's lookup. */
export function resolveWikiFolderId(id: string): string | undefined {
  const path = wikiObjectPath(id);
  if (path === undefined) {
    throw new ViewError("args", `"${id}" is not a path inside the wiki`);
  }
  return path;
}

/** The note path an id names; whether the wiki holds that note is the caller's lookup. */
export function resolveWikiNoteId(id: string): string | undefined {
  const path = wikiObjectPath(id);
  if (path === undefined) {
    throw new ViewError("args", `"${id}" is not a path inside the wiki`);
  }
  return path;
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
  readonly links: readonly NoteLinkData[];
}

interface WikiScan {
  readonly folders: readonly string[];
  readonly notes: readonly ScannedNote[];
}

/**
 * Every folder and Markdown note under the wiki, hidden directories left out.
 * A note whose modification time matches the projection is not read again: its
 * title, mark and links are already stored.
 */
function scanWiki(root: string, known: ReadonlyMap<string, NoteData>): WikiScan {
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
      let stat;
      try {
        stat = statSync(file);
      } catch {
        continue;
      }
      const path = relative(root, file).split(sep).join("/");
      const before = known.get(path);
      if (before !== undefined && before.linksKnown && before.mtimeMs === stat.mtimeMs) {
        notes.push({
          path,
          file,
          title: before.title,
          mtimeMs: stat.mtimeMs,
          untrusted: before.untrusted,
          links: before.links,
        });
        continue;
      }
      let raw: string;
      try {
        raw = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const { fields, body } = splitMarkdown(raw);
      notes.push({
        path,
        file,
        title: titleOf({}, body, titleFromName(entry.name)),
        mtimeMs: stat.mtimeMs,
        untrusted: untrustedFields(fields),
        links: placedNoteLinks(body).map(({ at: _at, ...link }) => link),
      });
    }
  };
  visit(root);
  folders.sort((left, right) => left.localeCompare(right));
  notes.sort((left, right) => left.path.localeCompare(right.path));
  return { folders, notes };
}

/** The notes the store still shows, by path, so a reader does not scan them again. */
async function projectedNotes(store: ObjectStore): Promise<ReadonlyMap<string, NoteData>> {
  const found = new Map<string, NoteData>();
  let cursor: string | undefined;
  do {
    const page = await store.list(WIKI_NOTE_TYPE, {
      ...(cursor === undefined ? {} : { cursor }),
      limit: 1000,
    });
    for (const object of page.objects) {
      const note = noteOf(object);
      if (!note.removed) found.set(note.path, note);
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return found;
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

/** The links each note writes, resolved, and the backlinks they give their targets. */
function projectLinks(notes: readonly ScannedNote[]): {
  readonly links: ReadonlyMap<string, readonly NoteLinkData[]>;
  readonly backlinks: ReadonlyMap<string, readonly BacklinkData[]>;
} {
  const lookup = noteLookup(notes.map((note) => note.path));
  const links = new Map<string, readonly NoteLinkData[]>();
  const backlinks = new Map<string, BacklinkData[]>();
  for (const note of notes) {
    const resolved = note.links.map((link): NoteLinkData => {
      const target = resolveNoteLink(note.path, link, lookup);
      return {
        target: link.target,
        ...(link.heading === undefined ? {} : { heading: link.heading }),
        kind: link.kind,
        line: link.line,
        excerpt: link.excerpt,
        ...(target === undefined ? {} : { object: `${WIKI_NOTE_TYPE}:${target}` }),
      };
    });
    links.set(note.path, resolved);
    for (const link of resolved) {
      const target = link.object?.slice(WIKI_NOTE_TYPE.length + 1);
      if (target === undefined || target === note.path) continue;
      const found = backlinks.get(target) ?? [];
      found.push({
        object: `${WIKI_NOTE_TYPE}:${note.path}`,
        path: note.path,
        title: note.title,
        target: link.target,
        ...(link.heading === undefined ? {} : { heading: link.heading }),
        kind: link.kind,
        line: link.line,
        excerpt: link.excerpt,
        untrusted: note.untrusted,
      });
      backlinks.set(target, found);
    }
  }
  return { links, backlinks };
}

/**
 * Brings the wiki objects up to date with the Markdown directory. The scan and
 * the links in it are the projection's own, so a list or get does not read the
 * search index. With a search given, the caller owns it and this refreshes the
 * index too; a list or get passes none.
 */
export async function syncWikiObjects(
  store: ObjectStore,
  home: string,
  settings: Readonly<Record<string, JsonValue>> = {},
  search: MemorySearch | undefined = undefined,
): Promise<void> {
  const root = wikiDirectory(home, settings);
  const scanned = scanWiki(root, await projectedNotes(store));
  const projected = projectLinks(scanned.notes);
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
    const parent = parentPath(note.path);
    const data: Record<string, unknown> = {
      path: note.path,
      title: note.title,
      mtimeMs: note.mtimeMs,
      untrusted: note.untrusted,
      removed: false,
      backlinks: projected.backlinks.get(note.path) ?? [],
      links: projected.links.get(note.path) ?? [],
    };
    if (parent !== undefined) data["parent"] = parent;
    seenNotes.add(note.path);
    await putIfChanged(store, WIKI_NOTE_TYPE, note.path, data);
  }

  await markRemoved(store, WIKI_FOLDER_TYPE, seenFolders);
  await markRemoved(store, WIKI_NOTE_TYPE, seenNotes);
  if (search !== undefined) await search.refresh(store);
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
  let note = noteOf(object);
  if (note.removed) throw new Error(`the wiki note "${note.path}" is gone`);
  const root = wikiDirectory(ctx.home, ctx.settings);
  const file = wikiNoteFile(root, note.path);
  if (file !== undefined) {
    let mtimeMs: number | undefined;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      mtimeMs = undefined;
    }
    if (
      mtimeMs !== undefined &&
      mtimeMs !== note.mtimeMs &&
      ctx.refreshedObject !== undefined
    ) {
      // The folder type owns the scan that projects the notes too.
      await ctx.refreshedObject(WIKI_FOLDER_TYPE, note.path);
      const refreshed = await ctx.store.get(WIKI_NOTE_TYPE, note.path);
      if (refreshed !== undefined) note = noteOf(refreshed);
      if (note.removed) throw new Error(`the wiki note "${note.path}" is gone`);
    }
  }
  if (sectionId === WIKI_BACKLINKS_SECTION) {
    return {
      markdown: backlinkMarkdown(note.backlinks),
      data: { backlinks: note.backlinks as unknown as JsonValue },
    };
  }
  if (sectionId !== WIKI_CONTENT_SECTION) return { markdown: "" };
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
  const links: readonly LinkData[] = note.links.map(
    ({ line: _line, excerpt: _excerpt, ...link }) => link,
  );
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
