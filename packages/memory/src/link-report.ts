/**
 * The link check the nightly tidy reads: broken links with their source line,
 * notes nothing links to, targets that several notes already name, and cheap
 * suggestions where a note mentions another note's title without linking it.
 * It answers from the link table, so a caller refreshes the index first; it
 * writes nothing and keeps no state of its own.
 */

import { parseNoteLinksWithPositions, withoutCode } from "./links.ts";
import type { MemorySearch } from "./search/service.ts";
import type { DocumentKey, IndexedDocument, LinkQuery } from "./search/types.ts";

/** How many unlinked mentions one report suggests at most. */
export const UNLINKED_MENTION_LIMIT = 20;

/** A link whose target no note has, with the line that writes it. */
export interface BrokenNoteLink {
  /** The note that writes the link, inside its scope. */
  readonly path: string;
  /** The 1-based line in the source note. */
  readonly line: number;
  /** The target as the note wrote it. */
  readonly target: string;
}

/** A target several notes link to while no note has that name. */
export interface WantedTarget {
  readonly target: string;
  /** How many different notes link to it. */
  readonly notes: number;
}

/** A source note that names another note's title without linking it. */
export interface UnlinkedMention {
  /** The note whose body contains the title. */
  readonly path: string;
  /** The title of the note that is not linked. */
  readonly title: string;
  /** The path of the note that is not linked. */
  readonly target: string;
}

/** The four lists a tidy reads about the links in one scope. */
export interface LinkReport {
  readonly broken: readonly BrokenNoteLink[];
  readonly orphans: readonly string[];
  readonly wanted: readonly WantedTarget[];
  readonly unlinked: readonly UnlinkedMention[];
}

/** A report with nothing to look at, for a tidy with no link table to read. */
export const EMPTY_LINK_REPORT: LinkReport = {
  broken: [],
  orphans: [],
  wanted: [],
  unlinked: [],
};

function inQuery(document: DocumentKey, query: LinkQuery): boolean {
  if (document.scope !== "wiki" && document.scope !== "memory") return false;
  if (query.scope !== undefined && document.scope !== query.scope) return false;
  if (query.owner !== undefined && document.owner !== query.owner) return false;
  return true;
}

/** Whether a note is a structural page rather than one an orphan check names. */
function structural(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return (
    name === "index.md" ||
    name === "instructions.md" ||
    name === "_about.md" ||
    path.startsWith("log/")
  );
}

/** The 1-based line of an offset in a note's body. */
function lineAt(text: string, at: number): number {
  let line = 1;
  for (let index = 0; index < at; index += 1) {
    if (text[index] === "\n") line += 1;
  }
  return line;
}

/**
 * The link lists for one scope, or one owner's memory. The index must have
 * been refreshed; links stored before a refresh still name their old targets.
 */
export function linkReport(
  search: MemorySearch,
  query: LinkQuery = {},
  unlinkedLimit = UNLINKED_MENTION_LIMIT,
): LinkReport {
  const notes = search.backend
    .keys()
    .filter((key) => key.file !== undefined && key.path !== undefined && inQuery(key, query))
    .sort((left, right) => (left.path ?? "").localeCompare(right.path ?? ""));
  const byId = new Map(notes.map((note) => [note.id, note]));
  const links = search.backend.allLinks().filter((link) => byId.has(link.docId));

  const linked = new Set<string>();
  const linkedBySource = new Map<string, Set<string>>();
  const sourcesByTarget = new Map<string, Set<string>>();
  const broken: BrokenNoteLink[] = [];
  const lines = new Map<string, readonly number[]>();

  for (const link of links) {
    if (link.targetId !== undefined) {
      if (link.targetId !== link.docId) linked.add(link.targetId);
      const targets = linkedBySource.get(link.docId) ?? new Set<string>();
      targets.add(link.targetId);
      linkedBySource.set(link.docId, targets);
      continue;
    }
    const source = byId.get(link.docId);
    if (source?.path === undefined) continue;

    let sourceLines = lines.get(link.docId);
    if (sourceLines === undefined) {
      const document = search.backend.get(link.docId);
      sourceLines =
        document === undefined
          ? []
          : parseNoteLinksWithPositions(document.text).map((place) =>
              lineAt(document.text, place.at),
            );
      lines.set(link.docId, sourceLines);
    }
    broken.push({
      path: source.path,
      line: sourceLines[link.ordinal] ?? 1,
      target: link.target,
    });

    const sources = sourcesByTarget.get(link.target) ?? new Set<string>();
    sources.add(link.docId);
    sourcesByTarget.set(link.target, sources);
  }

  broken.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.line - right.line ||
      left.target.localeCompare(right.target),
  );

  const orphans = notes
    .filter((note) => note.path !== undefined && !structural(note.path) && !linked.has(note.id))
    .map((note) => note.path ?? note.id);

  const wanted = [...sourcesByTarget.entries()]
    .filter(([, sources]) => sources.size >= 3)
    .map(([target, sources]) => ({ target, notes: sources.size }))
    .sort((left, right) => right.notes - left.notes || left.target.localeCompare(right.target));

  const unlinked: UnlinkedMention[] = [];
  if (unlinkedLimit > 0) {
    const targets = notes
      .map((note) => ({ note, document: search.backend.get(note.id) }))
      .filter(
        (entry): entry is { note: DocumentKey; document: IndexedDocument } =>
          entry.document !== undefined,
      );
    for (const source of targets) {
      if (source.note.path === undefined) continue;
      const body = withoutCode(source.document.text);
      const already = linkedBySource.get(source.note.id) ?? new Set<string>();
      for (const target of targets) {
        if (target.note.id === source.note.id || target.note.path === undefined) continue;
        if (already.has(target.note.id)) continue;
        const title = target.document.title;
        if (title.length === 0 || !body.includes(title)) continue;
        unlinked.push({
          path: source.note.path,
          title,
          target: target.note.path,
        });
        if (unlinked.length >= unlinkedLimit) break;
      }
      if (unlinked.length >= unlinkedLimit) break;
    }
  }

  return { broken, orphans, wanted, unlinked };
}
