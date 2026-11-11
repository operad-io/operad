/**
 * The OpenTUI view: it turns one `TuiState` into boxes and styled text. It owns
 * no state, reads no clock and calls no client; every change arrives through
 * `render(state)`.
 */

import {
  BoxRenderable,
  StyledText,
  TextAttributes,
  TextRenderable,
  type CliRenderer,
  type TextChunk,
} from "@opentui/core";
import type { RowMark } from "@operad-io/engine";
import { allowedText } from "../args.ts";
import { confirmText, entryDetail, matchPositions, paletteEntries, settingText, type TuiPaletteEntry } from "../actions.ts";
import { chunksOfLine } from "../markdown.ts";
import {
  TUI_PALETTE,
  resolvePalette,
  toRgba,
  type ThemeSelection,
  type TuiPalette,
} from "../theme.ts";
import { sanitize } from "../sanitize.ts";
import { displayWidth, graphemes, wrapText } from "../wrap.ts";
import {
  CHILD_ROWS,
  HELP_LINES,
  KEY_GROUPS,
  KEY_LIST,
  ROW_INDENT,
  activeSection,
  bareId,
  cancelledRow,
  childProgress,
  displayChildren,
  rowDetail,
  rowName,
  activeTab,
  LIST_HEAD,
  dividerX,
  listWidth,
  rightX,
  LIST_X,
  bodyHeight,
  filterHeader,
  footerSegments,
  helpViewport,
  noticeText,
  pageEntries,
  pagePosition,
  sectionLayout,
  sectionWidth,
  listWindow,
  sectionViewport,
  statusText,
  twoPane,
  type TuiChildEntry,
  type TuiObject,
  rowMark,
  type TuiRow,
  type TuiSection,
  type TuiState,
  type TuiTab,
  type TuiTheme,
} from "../state.ts";

export { TUI_PALETTE, type TuiPalette };

/** The palette a state's theme names. */
export function paletteFor(theme: TuiTheme, name: string | ThemeSelection = "auto"): TuiPalette {
  if (typeof name !== "string") return name.palette ?? resolvePalette(name.name, theme);
  return resolvePalette(name, theme);
}

function chunk(
  text: string,
  color?: string,
  attributes?: number,
  background?: string,
): TextChunk {
  return {
    __isChunk: true,
    // Whatever reaches the screen is cleaned here too, so a string that came
    // by another way than the reducer cannot carry a control character.
    text: sanitize(text),
    ...(color === undefined ? {} : { fg: toRgba(color) }),
    ...(background === undefined ? {} : { bg: toRgba(background) }),
    ...(attributes === undefined ? {} : { attributes }),
  };
}

function styled(chunks: readonly TextChunk[]): StyledText {
  return new StyledText([...chunks]);
}

/** The last lists stay visible but weak while the server does not answer. */
function dimmed(text: StyledText, on: boolean, palette: TuiPalette): StyledText {
  if (!on) return text;
  const fg = toRgba(palette.weak);
  return new StyledText(text.chunks.map((part) => ({ ...part, fg })));
}

/** Cuts `text` to `width` display cells, ending in `…` when it was cut. */
export function fit(text: string, width: number): string {
  const clean = sanitize(text).replace(/\n/g, " ");
  if (width <= 0) return "";
  let total = 0;
  const all = graphemes(clean);
  for (const char of all) total += displayWidth(char);
  if (total <= width) return clean;
  let out = "";
  let used = 0;
  for (const char of all) {
    const next = displayWidth(char);
    if (used + next > width - 1) break;
    out += char;
    used += next;
  }
  return `${out}…`;
}

/** The count a tab shows after its name, when it has one. */
function tabCount(tab: TuiTab): number | undefined {
  if (tab.kind === "plugin" && !tab.list.loaded) return undefined;
  return tab.list.rows.length;
}

/** Cuts a line of chunks to `width` cells; the cut chunk ends in `…`. */
function truncateChunks(chunks: readonly TextChunk[], width: number): TextChunk[] {
  const out: TextChunk[] = [];
  let left = width;
  for (const part of chunks) {
    if (left <= 0) break;
    const cells = displayWidth(part.text);
    if (cells <= left) {
      out.push(part);
      left -= cells;
      continue;
    }
    out.push({ ...part, text: fit(part.text, left) });
    break;
  }
  return out;
}

function headerContent(state: TuiState, palette: TuiPalette): StyledText {
  const chunks: TextChunk[] = [
    chunk(" "),
    chunk("operad", palette.text, TextAttributes.BOLD),
    chunk("   "),
  ];
  state.tabs.forEach((tab, index) => {
    if (index > 0) chunks.push(chunk(" │ ", palette.weak));
    const active = index === state.active;
    const count = tabCount(tab);
    chunks.push(
      chunk(
        count === undefined ? tab.title : `${tab.title} ${count}`,
        active ? palette.accent : palette.weak,
        active ? TextAttributes.BOLD : TextAttributes.NONE,
      ),
    );
    const extra = active ? filterHeader(tab) : undefined;
    if (extra !== undefined) {
      chunks.push(chunk(extra.filter, palette.accent));
      if (extra.hidden !== "") chunks.push(chunk(extra.hidden, palette.weak));
    }
  });
  return styled(truncateChunks(chunks, state.width));
}

/** A thin horizontal rule from column 1 to the last column but one. */
function ruleContent(state: TuiState, palette: TuiPalette): StyledText {
  return styled([
    chunk(` ${"─".repeat(Math.max(0, state.width - 2))}`, palette.rule),
  ]);
}

/** The divider's colour: the weak text colour, far clearer against the background than the rule. */
export function dividerColour(palette: TuiPalette): string {
  return palette.weak;
}

/** The dim title over the list: the page name, and a type list's filter. */
function listTitle(tab: TuiTab | undefined, palette: TuiPalette, width: number): TextChunk[] {
  if (tab === undefined) return [];
  const extra = filterHeader(tab);
  // Cut to the list width: a wrapped title would push the last row out of the pane.
  const title = fit(`${tab.title.toUpperCase()}${extra?.filter ?? ""}`, Math.max(1, width));
  return [chunk(title, palette.weak), chunk("\n")];
}

function dividerContent(state: TuiState, palette: TuiPalette): StyledText {
  return styled([
    chunk(Array.from({ length: bodyHeight(state) }, () => "│").join("\n"), dividerColour(palette)),
  ]);
}

/** The columns a row under a group is indented. */
const GROUP_INDENT = 2;

type MarkColour = "weak" | "accent" | "run" | "ok" | "error";

/** One single-cell character and colour role per mark. */
export const MARK_GLYPHS: Readonly<
  Record<RowMark, { readonly char: string; readonly colour: MarkColour }>
> = {
  todo: { char: "○", colour: "weak" },
  blocked: { char: "◌", colour: "weak" },
  retry_wait: { char: "◷", colour: "weak" },
  paused: { char: "‖", colour: "weak" },
  proposed: { char: "+", colour: "accent" },
  starting: { char: "◔", colour: "run" },
  running: { char: "◐", colour: "run" },
  reconciling: { char: "↻", colour: "run" },
  checking: { char: "⌕", colour: "run" },
  rework_pending: { char: "↩", colour: "accent" },
  waiting: { char: "●", colour: "accent" },
  integrating: { char: "⑂", colour: "run" },
  ready_to_merge: { char: "◉", colour: "ok" },
  done: { char: "✓", colour: "ok" },
  failed: { char: "✗", colour: "error" },
  cancelled: { char: "⊘", colour: "weak" },
  broken: { char: "!", colour: "error" },
};

/** The glyph and colour of a list row. */
function glyph(row: TuiRow, palette: TuiPalette, tint?: string): TextChunk {
  if (row.error !== undefined) return chunk("✗", palette.error, undefined, tint);
  const mark = rowMark(row);
  // A mark this client does not know (a newer server) draws as plain.
  const shown = mark === "none" ? undefined : MARK_GLYPHS[mark];
  if (shown !== undefined) return chunk(shown.char, palette[shown.colour], undefined, tint);
  if (/^(done|merged)$/i.test(row.state)) return chunk("✓", palette.ok, undefined, tint);
  return chunk("○", palette.weak, undefined, tint);
}

/** One object: its line, its dim line, both tinted to the pane's edge when selected. */
function drawRow(
  row: TuiRow,
  selected: boolean,
  palette: TuiPalette,
  width: number,
  titles = true,
  place: { readonly indent?: number; readonly folder?: boolean } = {},
): TextChunk[] {
  const indent = place.indent ?? 0;
  const tint = selected ? palette.tint : undefined;
  const room = Math.max(0, width - ROW_INDENT - indent);
  const name = row.unnamed === true && row.title !== "" ? row.title : rowName(row);
  const head = fit(name, room);
  const left = room - displayWidth(head);
  const title =
    !titles || row.unnamed === true || row.title === "" || left < 4
      ? ""
      : fit(row.title, left - 2);
  const first = title === "" ? head : `${head}  `;
  const pad1 = " ".repeat(Math.max(0, room - displayWidth(first) - displayWidth(title)));
  const detail = fit(rowDetail(row), room);
  const pad2 = " ".repeat(Math.max(0, room - displayWidth(detail)));
  const fill = (text: string): TextChunk[] =>
    text === "" || !selected ? [] : [chunk(text, undefined, undefined, tint)];
  return [
    chunk(selected ? "❯" : " ", palette.accent, undefined, tint),
    chunk(" ", undefined, undefined, tint),
    ...(indent === 0 ? [] : [chunk(" ".repeat(indent), undefined, undefined, tint)]),
    place.folder === true ? folder(row, palette, tint) : glyph(row, palette, tint),
    chunk(" ", undefined, undefined, tint),
    chunk(first, selected ? palette.accent : palette.text, undefined, tint),
    ...(title === "" ? [] : [chunk(title, palette.text, undefined, tint)]),
    ...fill(pad1),
    chunk("\n"),
    chunk(" ".repeat(ROW_INDENT + indent), undefined, undefined, tint),
    ...(detail === "" ? [] : [chunk(detail, palette.weak, undefined, tint)]),
    ...fill(pad2),
    chunk("\n"),
  ];
}

/** The folder icon of a repository group: one cell, in the colour its row's mark has when that is the running colour. */
const FOLDER = "▤";

function folder(row: TuiRow, palette: TuiPalette, tint?: string): TextChunk {
  const mark = rowMark(row);
  const running = mark !== "none" && MARK_GLYPHS[mark]?.colour === "run";
  return chunk(FOLDER, running ? palette.run : palette.weak, undefined, tint);
}

/** The columns a list row has, marker and glyph included. */
function listCells(state: TuiState): number {
  return twoPane(state) ? listWidth(state) : Math.max(1, state.width - LIST_X - 1);
}

function listContent(
  state: TuiState,
  tab: TuiTab | undefined,
  palette: TuiPalette,
): StyledText {
  if (tab === undefined) return styled([chunk("no tabs", palette.weak)]);
  if (tab.list.rows.length === 0) {
    const message = !tab.list.loaded
      ? "loading…"
      : tab.kind === "pending"
        ? "nothing waits for you"
        : tab.filters !== undefined && tab.filter !== undefined
          ? `nothing ${tab.filter} in ${tab.title.toLowerCase()}`
          : `nothing in ${tab.title.toLowerCase()}`;
    return styled([chunk("\n"), ...listTitle(tab, palette, listCells(state)), chunk(message, palette.weak)]);
  }
  const width = listCells(state);
  const chunks: TextChunk[] = [chunk("\n"), ...listTitle(tab, palette, width)];
  const window = listWindow(tab.list, Math.max(1, bodyHeight(state) - LIST_HEAD));
  const titles = tab.kind !== "plugin";
  const grouped = tab.list.rows.some((row) => row.group !== undefined);
  tab.list.rows.slice(window.start, window.end).forEach((row, offset) => {
    if (offset > 0) chunks.push(chunk("\n"));
    if (row.group !== undefined) {
      chunks.push(...drawRow(row.group, false, palette, width, titles, { folder: true }));
      chunks.push(chunk("\n"));
    }
    chunks.push(
      ...drawRow(row, window.start + offset === tab.list.cursor, palette, width, titles, {
        indent: grouped && row.bare !== true ? GROUP_INDENT : 0,
        ...(row.bare === true ? { folder: true } : {}),
      }),
    );
  });
  if (tab.list.loading) chunks.push(chunk("loading more…\n", palette.weak));
  if (tab.list.error !== undefined) {
    chunks.push(chunk(fit(tab.list.error, width), palette.error));
  }
  return styled(chunks);
}

/** The line of the frame's top border: the row's id, state, badge and note. */
function objectLabel(row: TuiRow): string {
  return [bareId(row.id), row.state, row.badge ?? "", row.note ?? ""]
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join(" · ");
}

/** The top border of the page's frame, with the row's line cut to fit. */
function frameTop(label: string, width: number, palette: TuiPalette): TextChunk[] {
  const shown = fit(label, Math.max(0, width - 4));
  const dashes = Math.max(0, width - 4 - displayWidth(shown));
  return [
    chunk("╭─ ", palette.rule),
    chunk(shown, palette.weak),
    chunk(` ${"─".repeat(dashes)}`, palette.rule),
    chunk("\n"),
  ];
}

function frameBottom(palette: TuiPalette): TextChunk[] {
  return [chunk("╰──", palette.rule), chunk("\n")];
}

/** One line inside the frame's left rail. */
function rail(chunks: readonly TextChunk[], palette: TuiPalette): TextChunk[] {
  return [chunk("│ ", palette.rule), ...chunks, chunk("\n")];
}

/** The colour role of a mark's glyph. */
function markColour(row: TuiRow, palette: TuiPalette): string {
  if (row.error !== undefined) return palette.error;
  const mark = rowMark(row);
  if (mark === "none") {
    return /^(done|merged)$/i.test(row.state) ? palette.ok : palette.weak;
  }
  return palette[MARK_GLYPHS[mark].colour];
}

/**
 * The bar's cells as chunks across `width`: only the done share is filled, the
 * rest of the track stays empty and cancelled children keep their dark red
 * cells last, outside the done / total count.
 */
function progressBar(
  progress: ReturnType<typeof childProgress>,
  width: number,
  palette: TuiPalette,
): TextChunk[] {
  const cancelled =
    progress.entries.filter((entry) => cancelledRow(entry.row)).length +
    progress.hiddenCancelled;
  const cells = progress.total + cancelled;
  if (cells === 0) return [];
  const done = Math.min(progress.done, progress.total);
  const base = Math.floor(width / cells);
  const extra = width % cells;
  const chunks: TextChunk[] = [];
  for (let at = 0; at < cells; at += 1) {
    const count = base + (at < extra ? 1 : 0);
    if (count === 0) continue;
    if (at < done) chunks.push(chunk("█".repeat(count), palette.ok));
    else if (at < progress.total) chunks.push(chunk(" ".repeat(count)));
    else chunks.push(chunk("█".repeat(count), palette.cancelled));
  }
  return chunks;
}

/** The heading under the bar: the type name left, `done / total` right. */
function childHeading(
  type: string,
  done: number,
  total: number,
  width: number,
  palette: TuiPalette,
): TextChunk[] {
  const left = type === "" ? "" : type.toUpperCase();
  const right = `${done} / ${total}`;
  const gap = Math.max(1, width - displayWidth(left) - displayWidth(right));
  return [chunk(fit(`${left}${" ".repeat(gap)}${right}`, width), palette.weak)];
}

/** A child's id without its type or repository. */
function childId(row: TuiRow): string {
  const bare = bareId(row.id);
  const slash = bare.lastIndexOf("/");
  return slash < 0 ? bare : bare.slice(slash + 1);
}

interface ChildColumns {
  /** Where the id column ends, counted from the connector's first cell. */
  readonly end: number;
  readonly state: number;
  readonly badge: number;
}

/** Cells before the id: the connector and its space, then the glyph and its space. */
function leadWidth(entry: TuiChildEntry): number {
  const connector = displayWidth(entry.connector);
  return (connector === 0 ? 0 : connector + 1) + 2;
}

/** The fixed column widths of one child list, so every state starts in one place. */
function childColumns(entries: readonly TuiChildEntry[], width: number): ChildColumns {
  const end = Math.max(0, ...entries.map((entry) => leadWidth(entry) + displayWidth(childId(entry.row))));
  const lead = Math.max(0, ...entries.map(leadWidth));
  const state = Math.max(0, ...entries.map((entry) => displayWidth(entry.row.state)));
  const badge = Math.max(0, ...entries.map((entry) => displayWidth(entry.row.badge ?? "")));
  // cursor, the lead, id, state and badge, with one space between columns.
  const fixed = 2 + 1 + state + (badge === 0 ? 0 : badge + 1);
  return { end: Math.min(end, Math.max(lead + 4, width - fixed)), state, badge };
}

function padTo(text: string, width: number): string {
  const shown = fit(text, width);
  return shown + " ".repeat(Math.max(0, width - displayWidth(shown)));
}

/** One child row: connector, glyph, id, state, badge, note and `also after`. */
function childRow(
  entry: TuiChildEntry,
  selected: boolean,
  palette: TuiPalette,
  width: number,
  columns: ChildColumns,
): TextChunk[] {
  const row = entry.row;
  const tint = selected ? palette.tint : undefined;
  const colour = markColour(row, palette);
  const mark = rowMark(row);
  const glyph =
    mark === "none"
      ? /^(done|merged)$/i.test(row.state)
        ? "✓"
        : "○"
      : MARK_GLYPHS[mark].char;
  const state = padTo(row.state, columns.state);
  const badge = columns.badge === 0 ? "" : padTo(row.badge ?? "", columns.badge);
  const notes = [row.note ?? "", entry.alsoAfter.length === 0 ? "" : `also after ${entry.alsoAfter.join(", ")}`]
    .filter((part) => part !== "");
  const chunks: TextChunk[] = [
    chunk(selected ? "❯ " : "  ", palette.accent, undefined, tint),
    ...(entry.connector === ""
      ? []
      : [chunk(entry.connector + " ", palette.rule, undefined, tint)]),
    chunk(`${glyph} `, colour, undefined, tint),
    chunk(padTo(childId(row), Math.max(0, columns.end - leadWidth(entry))), selected ? palette.accent : palette.text, undefined, tint),
    chunk(" ", undefined, undefined, tint),
    chunk(state, colour, undefined, tint),
    ...(columns.badge === 0
      ? []
      : [chunk(" ", undefined, undefined, tint), chunk(badge, palette.weak, undefined, tint)]),
    ...(notes.length === 0
      ? []
      : [chunk(`  ${notes.join("  ")}`, palette.weak, undefined, tint)]),
  ];
  return truncateChunks(chunks, width);
}

/** The page's next level: the bar, its heading and one aligned line per child. */
function childrenContent(
  object: TuiObject,
  state: TuiState,
  palette: TuiPalette,
  width: number,
): TextChunk[] {
  const children = object.children;
  if (children === undefined || children.rows.length + (children.hidden ?? 0) === 0) {
    return [];
  }
  const progress = childProgress(
    children.rows,
    state.childLayout,
    children.hidden,
    children.hiddenDone,
    children.hiddenCancelled,
  );
  const shown = displayChildren(children.rows, state.childLayout);
  const type = shown[0]?.row.type ?? "";
  const columns = childColumns(shown, width);
  const chunks: TextChunk[] = [
    ...rail(progressBar(progress, width, palette), palette),
    ...rail(childHeading(type, progress.done, progress.total, width, palette), palette),
  ];
  const start = children.cursor >= CHILD_ROWS ? children.cursor - CHILD_ROWS + 1 : 0;
  shown.slice(start, start + CHILD_ROWS).forEach((entry, offset) => {
    const selected = children.focused && start + offset === children.cursor;
    chunks.push(...rail(childRow(entry, selected, palette, width, columns), palette));
  });
  return chunks;
}

function sectionTabs(object: TuiObject, palette: TuiPalette, width: number): TextChunk[] {
  const chunks: TextChunk[] = [];
  let rule = "";
  let used = 0;
  object.sections.forEach((section, index) => {
    const label = `${section.title}${section.live ? " ●" : ""}`;
    const gap = index > 0 ? " · " : "";
    if (used + displayWidth(gap) + displayWidth(label) > width) return;
    const active = index === object.active;
    chunks.push(chunk(gap));
    chunks.push(
      chunk(
        label,
        active ? palette.accent : palette.weak,
        active ? TextAttributes.BOLD : TextAttributes.NONE,
      ),
    );
    rule += `${" ".repeat(displayWidth(gap))}${(active ? "─" : " ").repeat(displayWidth(label))}`;
    used += displayWidth(gap) + displayWidth(label);
  });
  chunks.push(chunk("\n"));
  chunks.push(chunk(rule.trimEnd(), palette.rule));
  chunks.push(chunk("\n"));
  return chunks;
}

function sectionHint(
  section: TuiSection,
  following: boolean,
  palette: TuiPalette,
  width: number,
): TextChunk[] {
  if (section.error !== undefined) {
    return [chunk(`${fit(`${section.error} · r retries`, width)}\n`, palette.error)];
  }
  if (section.loading) return [chunk("loading…\n", palette.weak)];
  if (section.capped && !section.full) {
    return [chunk("Truncated · f loads all of it\n", palette.weak)];
  }
  if (section.live && following) return [chunk("following\n", palette.weak)];
  return [];
}

function sectionContent(
  state: TuiState,
  section: TuiSection | undefined,
  palette: TuiPalette,
): TextChunk[] {
  if (section === undefined) {
    return [chunk(state.object?.loading === true ? "loading…" : "no sections", palette.weak)];
  }
  if (!section.loaded) {
    return [chunk(section.loading ? "loading…" : "not loaded", palette.weak)];
  }
  const viewport = sectionViewport(state);
  const lines = sectionLayout(state, section);
  const start = Math.min(
    Math.max(0, section.scroll),
    Math.max(0, lines.length - 1),
  );
  const chunks: TextChunk[] = [];
  for (const line of lines.slice(start, start + viewport)) {
    chunks.push(...chunksOfLine(line, palette), chunk("\n"));
  }
  return chunks;
}

function objectContent(state: TuiState, palette: TuiPalette): StyledText {
  const object = state.object;
  if (object === undefined) {
    // An openable cursor row is on the way; a row that names no object, or an empty list, asks.
    const tab = state.tabs[state.active];
    const under = tab?.list.rows[tab.list.cursor];
    const waiting = state.followPending && under !== undefined && under.openable !== false;
    return styled([
      chunk("\n"),
      chunk(waiting ? "loading…" : "select an object", palette.weak),
    ]);
  }
  const section = activeSection(state);
  const width = sectionWidth(state);
  const inside = Math.max(1, width - 2);
  const chunks: TextChunk[] = [
    ...frameTop(objectLabel(object.row), width, palette),
    ...rail([], palette),
  ];
  if (object.row.title !== "") {
    for (const line of wrapText(object.row.title, inside)) {
      chunks.push(...rail([chunk(line, palette.text)], palette));
    }
  }
  const position = pagePosition(section, state);
  const status =
    object.error !== undefined
      ? { text: object.error, colour: palette.error }
      : object.row.error !== undefined
        ? { text: object.row.error, colour: palette.error }
        : object.unavailable !== undefined
          ? { text: object.unavailable, colour: palette.weak }
          : position === undefined
            ? undefined
            : { text: position, colour: palette.accent };
  if (status !== undefined) {
    chunks.push(...rail([chunk(fit(status.text, inside), status.colour)], palette));
  }
  chunks.push(...childrenContent(object, state, palette, inside));
  chunks.push(...frameBottom(palette));
  chunks.push(chunk("\n"));
  chunks.push(...sectionTabs(object, palette, width));
  chunks.push(
    ...(section === undefined
      ? sectionContent(state, section, palette)
      : [
          ...sectionContent(state, section, palette),
          ...sectionHint(section, section.following, palette, width),
        ]),
  );
  return styled(chunks);
}

function keyContent(state: TuiState, palette: TuiPalette): StyledText {
  const width = Math.max(...KEY_LIST.map(([key]) => displayWidth(key)));
  const room = Math.max(1, overlayTextWidth(state) - 2 - width - 2);
  const lines: TextChunk[][] = [[chunk("keys\n", palette.accent, TextAttributes.BOLD)]];
  KEY_GROUPS.forEach((group, at) => {
    if (at > 0) lines.push([chunk("\n")]);
    for (const [key, what] of group) {
      const pad = " ".repeat(Math.max(0, width - displayWidth(key)));
      lines.push([
        chunk(`  ${key}${pad}  `, palette.accent),
        chunk(`${fit(what, room)}\n`, palette.weak),
      ]);
    }
  });
  const rows = helpViewport(state);
  const start = Math.min(Math.max(0, state.helpScroll), Math.max(0, lines.length - rows));
  return styled(lines.slice(start, start + rows).flat());
}

/** One line of the palette's body: a blank, a group label, or an entry. */
type PaletteLine =
  | { readonly kind: "blank" }
  | { readonly kind: "group"; readonly group: string }
  | { readonly kind: "entry"; readonly entry: TuiPaletteEntry; readonly at: number };

/** The palette's body in drawing order: each group label over its entries, a blank line between groups. */
function paletteDisplayLines(entries: readonly TuiPaletteEntry[]): readonly PaletteLine[] {
  const lines: PaletteLine[] = [];
  let last: string | undefined;
  entries.forEach((entry, at) => {
    if (entry.group !== last) {
      if (last !== undefined) lines.push({ kind: "blank" });
      lines.push({ kind: "group", group: entry.group });
      last = entry.group;
    }
    lines.push({ kind: "entry", entry, at });
  });
  return lines;
}

/** The object a palette entry acts on: the open object, for its actions. */
function paletteObject(state: TuiState, entry: TuiPaletteEntry): string {
  return entry.group === "actions" && state.object !== undefined ? bareId(state.object.id) : "";
}

/** What a palette entry says after its name: the command's title, or the action's own detail. */
function paletteDetail(entry: TuiPaletteEntry): string {
  return entry.group === "tui" ? entry.title : entryDetail(entry);
}

interface PaletteColumns {
  readonly name: number;
  readonly object: number;
  readonly detail: number;
  readonly key: number;
  readonly hasObject: boolean;
  readonly hasKey: boolean;
}

/** The cells between two palette columns. */
const PALETTE_GAP = 2;

/** The column widths of a palette at `width` cells: name, object, detail and a right-aligned key. */
function paletteColumns(
  state: TuiState,
  entries: readonly TuiPaletteEntry[],
  width: number,
): PaletteColumns {
  const widest = (texts: readonly string[]): number =>
    texts.reduce((most, text) => Math.max(most, displayWidth(text)), 0);
  let hasObject = entries.some((entry) => paletteObject(state, entry) !== "");
  const hasKey = entries.some((entry) => entry.key !== undefined);
  const keyWidth = hasKey ? Math.min(8, Math.max(1, widest(entries.map((entry) => entry.key ?? "")))) : 0;
  let name = Math.min(26, Math.max(1, widest(entries.map((entry) => entry.name))));
  let object = hasObject ? Math.min(24, widest(entries.map((entry) => paletteObject(state, entry)))) : 0;
  const gaps = 2 + PALETTE_GAP + (hasObject ? PALETTE_GAP : 0) + (hasKey ? PALETTE_GAP + keyWidth : 0);
  let detail = width - gaps - name - object;
  // A long name gives way first, then a long object, so the detail keeps some room.
  const give = (from: number, floor: number): number => {
    const cut = Math.min(from - floor, Math.max(0, 6 - detail));
    detail += cut;
    return from - cut;
  };
  if (detail < 6) name = give(name, 4);
  if (detail < 6) object = give(object, 0);
  if (object === 0 && hasObject) {
    hasObject = false;
    detail += PALETTE_GAP;
  }
  if (detail < 1 && name > 1) name = give(name, 1);
  if (detail < 1) object = give(object, 0);
  return { name, object, detail: Math.max(1, detail), key: keyWidth, hasObject: object > 0, hasKey };
}

/** One palette entry in its columns, the key at the right edge. */
function paletteEntryLine(
  state: TuiState,
  line: Extract<PaletteLine, { readonly kind: "entry" }>,
  columns: PaletteColumns,
  width: number,
  palette: TuiPalette,
): TextChunk[] {
  const { entry, at } = line;
  const input = state.input;
  const query = input?.kind === "palette" ? input.query : "";
  const selected = input?.kind === "palette" && at === input.cursor;
  const shown = fit(entry.name, columns.name);
  const marked = new Set(matchPositions(query, entry));
  const colour = selected ? palette.accent : palette.text;
  const chunks: TextChunk[] = [chunk(selected ? "❯ " : "  ", palette.accent)];
  let used = 0;
  for (const run of nameRuns(shown, marked)) {
    used += displayWidth(run.text);
    chunks.push(
      run.marked
        ? chunk(run.text, palette.accent, TextAttributes.BOLD | TextAttributes.UNDERLINE)
        : chunk(run.text, colour),
    );
  }
  chunks.push(chunk(" ".repeat(Math.max(0, columns.name - used))));
  if (columns.hasObject) {
    const object = fit(paletteObject(state, entry), columns.object);
    chunks.push(chunk(" ".repeat(PALETTE_GAP)));
    chunks.push(chunk(object, palette.weak));
    chunks.push(chunk(" ".repeat(Math.max(0, columns.object - displayWidth(object)))));
  }
  chunks.push(chunk(" ".repeat(PALETTE_GAP)));
  const detail = fit(paletteDetail(entry), columns.detail);
  chunks.push(chunk(detail, palette.weak));
  if (columns.hasKey) {
    chunks.push(chunk(" ".repeat(Math.max(0, columns.detail - displayWidth(detail)) + PALETTE_GAP)));
    const key = fit(entry.key ?? "", columns.key);
    chunks.push(chunk(" ".repeat(Math.max(0, columns.key - displayWidth(key))), undefined));
    chunks.push(chunk(key, palette.text));
  }
  // Keep every entry the same width, so the key column stays at the right edge.
  const drawn = chunks.reduce((sum, part) => sum + displayWidth(part.text), 0);
  if (drawn < width) chunks.push(chunk(" ".repeat(width - drawn)));
  chunks.push(chunk("\n"));
  return chunks;
}

/** The width inside an overlay's frame, its one-cell padding on each side taken. */
function overlayTextWidth(state: TuiState): number {
  return Math.max(1, (overlayBox(state)?.width ?? OVERLAY_WIDTH) - 4);
}

/** An entry's name cut into runs, each wholly matched or wholly not. */
function nameRuns(
  name: string,
  marked: ReadonlySet<number>,
): { readonly text: string; readonly marked: boolean }[] {
  const runs: { text: string; marked: boolean }[] = [];
  graphemes(name).forEach((unit, place) => {
    const on = marked.has(place);
    const last = runs[runs.length - 1];
    if (last !== undefined && last.marked === on) last.text += unit;
    else runs.push({ text: unit, marked: on });
  });
  return runs;
}

/** The palette or the note input, drawn in the box; undefined when neither is open. */
function inputContent(state: TuiState, palette: TuiPalette): StyledText | undefined {
  const input = state.input;
  if (input === undefined || input.kind === "confirm" || input.kind === "setting-confirm") return undefined;
  const bar = "▏";
  if (input.kind === "setting") {
    const { setting, field } = input;
    const chunks: TextChunk[] = [
      chunk(`${sanitize(setting.name)}${setting.scope === "global" ? "" : ` (${sanitize(setting.scope)})`}\n`, palette.accent, TextAttributes.BOLD),
    ];
    if (setting.description !== undefined) chunks.push(chunk(`${sanitize(setting.description)}\n`, palette.weak));
    chunks.push(chunk(`value: ${settingText(setting.value)}\n`, palette.text));
    chunks.push(chunk(`default: ${settingText(setting.default)}\n`, palette.text));
    if (field === undefined) {
      chunks.push(chunk("read-only · esc closes", palette.weak));
    } else if (field.kind === "pick") {
      field.options.forEach((option, at) => {
        chunks.push(chunk(at === input.cursor ? "❯ " : "  ", palette.accent));
        chunks.push(chunk(option.label, at === input.cursor ? palette.accent : palette.text));
        chunks.push(chunk(at === field.current ? "  current\n" : "\n", palette.weak));
      });
      chunks.push(chunk("j/k or arrows move · enter picks · esc cancels", palette.weak));
    } else {
      chunks.push(chunk(`${input.text}${bar}\n`, palette.text));
      chunks.push(chunk("enter sets · esc cancels", palette.weak));
    }
    return styled(chunks);
  }
  if (input.kind === "note") {
    const chunks: TextChunk[] = [
      chunk(`${input.action} · note${input.required ? " (required)" : ""}\n`, palette.accent, TextAttributes.BOLD),
      chunk(`${input.text}${bar}\n`, palette.text),
      chunk("enter sends · shift-enter or ctrl-j adds a line · esc cancels", palette.weak),
    ];
    return styled(chunks);
  }
  if (input.kind === "themes") {
    const chunks: TextChunk[] = [chunk("theme\n", palette.accent)];
    const names = state.themeNames;
    const rows = Math.max(1, (overlayBox(state)?.height ?? 5) - 4 - 1);
    const start = Math.max(0, Math.min(input.cursor - Math.floor(rows / 2), names.length - rows));
    names.slice(start, start + rows).forEach((name, offset) => {
      const at = start + offset;
      chunks.push(chunk(at === input.cursor ? "❯ " : "  ", palette.accent));
      chunks.push(chunk(name, at === input.cursor ? palette.accent : palette.text));
      chunks.push(chunk(name === state.themeCurrent ? "  in use\n" : "\n", palette.weak));
    });
    return styled(chunks);
  }
  if (input.kind === "args") {
    const field = input.fields[input.at];
    const chunks: TextChunk[] = [
      chunk(`${input.action} · ${field?.name ?? ""} (${input.at + 1} of ${input.fields.length})\n`, palette.accent, TextAttributes.BOLD),
    ];
    if (field?.description !== undefined) chunks.push(chunk(`${field.description}\n`, palette.weak));
    if (field?.kind === "pick") {
      field.options.forEach((option, at) => {
        chunks.push(chunk(at === input.cursor ? "❯ " : "  ", palette.accent));
        chunks.push(chunk(option.label, at === input.cursor ? palette.accent : palette.text));
        chunks.push(chunk(at === field.current ? "  current\n" : "\n", palette.weak));
      });
      chunks.push(chunk(
        field.optional === true && input.cursor < 0
          ? "j/k or arrows move · enter leaves it out · esc cancels"
          : "j/k or arrows move · enter picks · esc cancels",
        palette.weak,
      ));
    } else if (field !== undefined) {
      chunks.push(chunk(`${input.text}${bar}\n`, palette.text));
      chunks.push(chunk(`${allowedText(field)}\n`, input.error === undefined ? palette.weak : palette.accent));
      chunks.push(chunk("enter sends · esc cancels", palette.weak));
    }
    return styled(chunks);
  }
  if (input.kind === "pages") {
    const chunks: TextChunk[] = [chunk(`page: ${input.query}${bar}\n`, palette.accent)];
    const pages = pageEntries(state);
    if (pages.length === 0) chunks.push(chunk("no page matches", palette.weak));
    // The box holds fewer lines than a long table of contents: keep the cursor in view.
    const rows = Math.max(1, (overlayBox(state)?.height ?? 5) - 4 - 1);
    const start = Math.max(
      0,
      Math.min(input.cursor - Math.floor(rows / 2), pages.length - rows),
    );
    pages.slice(start, start + rows).forEach((entry, offset) => {
      const at = start + offset;
      chunks.push(chunk(at === input.cursor ? "❯ " : "  ", palette.accent));
      chunks.push(chunk(`${entry.label}\n`, at === input.cursor ? palette.accent : palette.text));
    });
    return styled(chunks);
  }
  const chunks: TextChunk[] = [chunk(`: ${input.query}${bar}\n`, palette.accent), chunk("\n")];
  const entries = paletteEntries(state);
  if (entries.length === 0) {
    chunks.push(chunk("nothing matches", palette.weak));
    return styled(chunks);
  }
  const lines = paletteDisplayLines(entries);
  const columns = paletteColumns(state, entries, overlayTextWidth(state));
  // The input line and the blank line under it stay put; only the body scrolls.
  const rows = Math.max(0, (overlayBox(state)?.height ?? 5) - 4 - 2);
  const selected = lines.findIndex((line) => line.kind === "entry" && line.at === input.cursor);
  const start =
    selected < rows
      ? 0
      : Math.max(0, Math.min(selected - Math.floor(rows / 2), lines.length - rows));
  for (const line of lines.slice(start, start + rows)) {
    if (line.kind === "blank") chunks.push(chunk("\n"));
    else if (line.kind === "group") chunks.push(chunk(`${line.group}\n`, palette.weak));
    else chunks.push(...paletteEntryLine(state, line, columns, overlayTextWidth(state), palette));
  }
  return styled(chunks);
}

function confirmContent(state: TuiState, palette: TuiPalette): StyledText | undefined {
  const text = confirmText(state);
  if (text === undefined) return undefined;
  return styled([
    chunk(`${text}\n`, palette.accent, TextAttributes.BOLD),
    chunk("y confirms · any other key cancels", palette.weak),
  ]);
}

/** The widest an overlay gets. */
export const OVERLAY_WIDTH = 80;

/** Where one overlay box sits, border included. */
export interface OverlayBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The box of the open overlay, or undefined. The width is fixed while it is
 * open; the box is centred horizontally. The palette keeps its top at a third
 * of the height so the input line stays put as the matches change; the others
 * are centred vertically.
 */
export function overlayBox(state: TuiState): OverlayBox | undefined {
  const kind = state.keys ? "keys" : state.input?.kind;
  if (kind === undefined) return undefined;
  const width = Math.max(10, Math.min(OVERLAY_WIDTH, state.width - 4));
  const lines = kind === "keys" ? HELP_LINES : kind === "confirm" || kind === "setting-confirm" ? 2 : inputLines(state);
  // Border (2) and a one-cell margin of background (2) around the text.
  const wanted = lines + 4;
  const left = Math.max(0, Math.floor((state.width - width) / 2));
  if (kind === "palette" || kind === "pages" || kind === "themes") {
    const top = Math.floor(state.height / 3);
    return { left, top, width, height: Math.max(5, Math.min(wanted, state.height - top)) };
  }
  const height = Math.max(5, Math.min(wanted, state.height));
  return { left, top: Math.max(0, Math.floor((state.height - height) / 2)), width, height };
}

/** The line count the box needs for the input it draws. */
function inputLines(state: TuiState): number {
  const input = state.input;
  if (input?.kind === "args") {
    const field = input.fields[input.at];
    const body = field?.kind === "pick" ? field.options.length + 1 : 3;
    return body + 1 + (field?.description === undefined ? 0 : 1);
  }
  if (input?.kind === "setting") {
    const { setting, field } = input;
    const body = field?.kind === "pick" ? field.options.length + 1 : 2;
    return 3 + (setting.description === undefined ? 0 : 1) + body;
  }
  if (input?.kind === "note") return input.text.split("\n").length + 2;
  if (input?.kind === "palette") {
    const entries = paletteEntries(state);
    return entries.length === 0 ? 3 : 2 + paletteDisplayLines(entries).length;
  }
  if (input?.kind === "themes") return Math.max(1, state.themeNames.length) + 1;
  if (input?.kind === "pages") return Math.max(1, pageEntries(state).length) + 1;
  return 0;
}

/** Everything one state draws, as styled text, before any terminal sees it. */
export interface TuiDrawing {
  readonly header: StyledText;
  readonly rule: StyledText;
  readonly divider: StyledText;
  readonly list: StyledText;
  readonly right: StyledText;
  readonly footer: StyledText;
  /** The `?` key list, the palette, the note or the confirmation, drawn in a filled box. */
  readonly overlay: StyledText | undefined;
}

/** The footer: keys in the text colour, their hints weak, separated by a dot. */
function footerContent(state: TuiState, palette: TuiPalette): StyledText {
  const chunks: TextChunk[] = [chunk(" ")];
  footerSegments(state).forEach((segment, at) => {
    if (at > 0) chunks.push(chunk(" · ", palette.weak));
    if (segment.key !== undefined) chunks.push(chunk(`${segment.key} `, palette.text));
    chunks.push(chunk(segment.hint, palette.weak));
  });
  return styled(truncateChunks(chunks, Math.max(1, state.width - 2)));
}

/** The styled text of every area for one state; the view only places it. */
export function drawState(
  state: TuiState,
  themeName: string | ThemeSelection = "auto",
): TuiDrawing {
  const palette = paletteFor(state.theme, themeName);
  const tab = activeTab(state);
  const rowError = tab?.list.rows[tab.list.cursor]?.error;
  const notice = noticeText(state);
  const status = notice ?? statusText(state) ?? rowError;
  const width = Math.max(1, state.width - 3);
  return {
    header: headerContent(state, palette),
    rule: ruleContent(state, palette),
    divider: dividerContent(state, palette),
    footer:
      status === undefined
        ? footerContent(state, palette)
        : styled([chunk(` ${fit(status, width)}`, palette.error)]),
    list: dimmed(
      listContent(state, activeTab(state), palette),
      state.connection === "unreachable",
      palette,
    ),
    right: objectContent(state, palette),
    overlay: state.keys
      ? keyContent(state, palette)
      : (inputContent(state, palette) ?? confirmContent(state, palette)),
  };
}

/** What the view exposes to the app. */
export interface TuiView {
  render(state: TuiState): void;
  destroy(): void;
}

/** Builds the render tree once and updates it on every state. */
export function createTuiView(
  ctx: CliRenderer,
  theme: string | ThemeSelection | (() => ThemeSelection) = "auto",
): TuiView {
  const root = new BoxRenderable(ctx, {
    id: "operad-tui",
    width: "100%",
    height: "100%",
    flexDirection: "column",
  });
  ctx.root.add(root);

  const line = (id: string): TextRenderable =>
    new TextRenderable(ctx, {
      id,
      height: 1,
      flexShrink: 0,
      wrapMode: "none",
      truncate: true,
    });
  const header = line("operad-header");
  const headerRule = line("operad-header-rule");
  const footerRule = line("operad-footer-rule");
  const footer = line("operad-footer");
  const body = new BoxRenderable(ctx, {
    id: "operad-body",
    width: "100%",
    flexGrow: 1,
    flexDirection: "row",
  });
  const listPane = new BoxRenderable(ctx, {
    id: "operad-list-pane",
    height: "100%",
    width: "100%",
    flexShrink: 0,
    paddingLeft: LIST_X,
    paddingRight: 1,
  });
  const list = new TextRenderable(ctx, {
    id: "operad-list",
    width: "100%",
    height: "100%",
    wrapMode: "none",
    truncate: true,
  });
  const divider = new TextRenderable(ctx, {
    id: "operad-divider",
    width: 1,
    height: "100%",
    flexShrink: 0,
    wrapMode: "none",
  });
  const rightPane = new BoxRenderable(ctx, {
    id: "operad-right-pane",
    height: "100%",
    flexGrow: 1,
    paddingLeft: 1,
  });
  const right = new TextRenderable(ctx, {
    id: "operad-right",
    width: "100%",
    height: "100%",
    // The section is wrapped by `sectionWidth` before it reaches this
    // renderable, so a wrapped row must stay one row here.
    wrapMode: "none",
    truncate: true,
  });
  // The one closed box: the key list floats over the body.
  const overlayPane = new BoxRenderable(ctx, {
    id: "operad-keys",
    position: "absolute",
    left: 2,
    top: 2,
    width: 60,
    height: HELP_LINES + 4,
    border: true,
    borderStyle: "rounded",
    borderColor: toRgba(TUI_PALETTE.dark.rule),
    paddingX: 1,
    paddingY: 1,
    visible: false,
    shouldFill: true,
  });
  const overlay = new TextRenderable(ctx, {
    id: "operad-keys-text",
    width: "100%",
    height: "100%",
    wrapMode: "none",
    truncate: true,
  });

  listPane.add(list);
  rightPane.add(right);
  overlayPane.add(overlay);
  body.add(listPane);
  body.add(divider);
  body.add(rightPane);
  root.add(header);
  root.add(headerRule);
  root.add(body);
  root.add(footerRule);
  root.add(footer);
  root.add(overlayPane);

  return {
    render(state: TuiState): void {
      const themeName = typeof theme === "function" ? theme() : theme;
      const palette = paletteFor(state.theme, themeName);
      const wide = twoPane(state);
      const drawing = drawState(state, themeName);

      header.content = drawing.header;
      headerRule.content = drawing.rule;
      footerRule.content = drawing.rule;
      footer.content = drawing.footer;

      listPane.width = wide ? dividerX(state) : "100%";
      // On a narrow screen the open object takes the place of the list.
      const showObject = state.object !== undefined;
      listPane.visible = wide || !showObject;
      divider.visible = wide;
      rightPane.visible = wide || showObject;
      rightPane.paddingLeft = wide ? rightX(state) - dividerX(state) - 1 : LIST_X;

      list.content = drawing.list;
      divider.content = drawing.divider;
      right.content = drawing.right;

      overlayPane.visible = drawing.overlay !== undefined;
      overlayPane.borderColor = toRgba(palette.rule);
      overlayPane.backgroundColor = toRgba(palette.background);
      const place = overlayBox(state);
      if (place !== undefined) {
        overlayPane.left = place.left;
        overlayPane.top = place.top;
        overlayPane.width = place.width;
        overlayPane.height = place.height;
      }
      if (drawing.overlay !== undefined) overlay.content = drawing.overlay;

      root.requestRender();
    },
    destroy(): void {
      root.destroyRecursively();
    },
  };
}
