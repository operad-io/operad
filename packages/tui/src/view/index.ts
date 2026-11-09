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
import { confirmText, entryHint, matchPositions, paletteEntries } from "../actions.ts";
import { chunksOfLine } from "../markdown.ts";
import {
  TUI_PALETTE,
  resolvePalette,
  toRgba,
  type ThemeSelection,
  type TuiPalette,
} from "../theme.ts";
import { sanitize } from "../sanitize.ts";
import { displayWidth, graphemes } from "../wrap.ts";
import {
  KEY_LIST,
  activeSection,
  activeTab,
  LIST_HEAD,
  dividerX,
  listWidth,
  rightX,
  LIST_X,
  bodyHeight,
  filterHeader,
  footerText,
  noticeText,
  pageEntries,
  pagePosition,
  sectionLayout,
  sectionWidth,
  listWindow,
  sectionViewport,
  statusText,
  twoPane,
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
  if (tab.kind === "type" && !tab.list.loaded) return undefined;
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
    if (index > 0) chunks.push(chunk(" · ", palette.weak));
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
function listTitle(tab: TuiTab | undefined, palette: TuiPalette): TextChunk[] {
  if (tab === undefined) return [];
  const extra = filterHeader(tab);
  return [chunk(`${tab.title.toUpperCase()}${extra?.filter ?? ""}`, palette.weak), chunk("\n")];
}

function dividerContent(state: TuiState, palette: TuiPalette): StyledText {
  return styled([
    chunk(Array.from({ length: bodyHeight(state) }, () => "│").join("\n"), dividerColour(palette)),
  ]);
}

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

/** The row id without its type: `item:T-1-x` is `T-1-x`. */
function bareId(id: string): string {
  const at = id.indexOf(":");
  return at < 0 ? id : id.slice(at + 1);
}

/** The short id and the slug of an id like `T-0031-tui-object`. */
function splitId(id: string): { readonly short: string; readonly slug: string } {
  const match = /^([A-Za-z]+-\d+)-(.+)$/.exec(id);
  if (match === null) return { short: id, slug: "" };
  return { short: match[1] ?? id, slug: match[2] ?? "" };
}

/** The short id and slug of a row, without its type or repository. */
function rowName(row: TuiRow): string {
  const bare = bareId(row.id);
  const { short, slug } = splitId(bare.slice(bare.lastIndexOf("/") + 1));
  if (row.error !== undefined || slug === "") return short;
  return `${short} ${slug}`;
}

/** The parts of a row's dim line: state and badge, then the note, unless the row says. */
function rowDetail(row: TuiRow): string {
  const parts =
    row.detail ?? [`${row.state}${row.badge === undefined ? "" : ` ${row.badge}`}`, row.note ?? ""];
  return parts
    .map((part) => sanitize(part).replace(/\n/g, " ").trim())
    .filter((part) => part !== "")
    .join(" · ");
}

/** The columns before a row's text: marker, glyph and their spaces. */
const ROW_INDENT = 4;

/** One object: its line, its dim line, both tinted to the pane's edge when selected. */
function drawRow(
  row: TuiRow,
  selected: boolean,
  palette: TuiPalette,
  width: number,
): TextChunk[] {
  const tint = selected ? palette.tint : undefined;
  const room = Math.max(0, width - ROW_INDENT);
  const name = row.unnamed === true && row.title !== "" ? row.title : rowName(row);
  const head = fit(name, room);
  const left = room - displayWidth(head);
  const title =
    row.unnamed === true || row.title === "" || left < 4 ? "" : fit(row.title, left - 2);
  const first = title === "" ? head : `${head}  `;
  const pad1 = " ".repeat(Math.max(0, room - displayWidth(first) - displayWidth(title)));
  const detail = fit(rowDetail(row), room);
  const pad2 = " ".repeat(Math.max(0, room - displayWidth(detail)));
  const fill = (text: string): TextChunk[] =>
    text === "" || !selected ? [] : [chunk(text, undefined, undefined, tint)];
  return [
    chunk(selected ? "❯" : " ", palette.accent, undefined, tint),
    chunk(" ", undefined, undefined, tint),
    glyph(row, palette, tint),
    chunk(" ", undefined, undefined, tint),
    chunk(first, selected ? palette.accent : palette.text, undefined, tint),
    ...(title === "" ? [] : [chunk(title, palette.text, undefined, tint)]),
    ...fill(pad1),
    chunk("\n"),
    chunk(" ".repeat(ROW_INDENT), undefined, undefined, tint),
    ...(detail === "" ? [] : [chunk(detail, palette.weak, undefined, tint)]),
    ...fill(pad2),
    chunk("\n"),
  ];
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
        : tab.kind === "type"
          ? tab.filters !== undefined && tab.filter !== undefined
            ? `no ${tab.filter} ${tab.title.toLowerCase()}s`
            : `no ${tab.title.toLowerCase()} yet`
          : `nothing in ${tab.title.toLowerCase()}`;
    return styled([chunk("\n"), ...listTitle(tab, palette), chunk(message, palette.weak)]);
  }
  const width = listCells(state);
  const chunks: TextChunk[] = [chunk("\n"), ...listTitle(tab, palette)];
  const window = listWindow(tab.list, Math.max(1, bodyHeight(state) - LIST_HEAD));
  tab.list.rows.slice(window.start, window.end).forEach((row, offset) => {
    if (offset > 0) chunks.push(chunk("\n"));
    chunks.push(...drawRow(row, window.start + offset === tab.list.cursor, palette, width));
  });
  if (tab.list.loading) chunks.push(chunk("loading more…\n", palette.weak));
  if (tab.list.error !== undefined) {
    chunks.push(chunk(fit(tab.list.error, width), palette.error));
  }
  return styled(chunks);
}

function objectHeader(
  object: TuiObject,
  palette: TuiPalette,
  width: number,
  position?: string | undefined,
): TextChunk[] {
  const row = object.row;
  const note = row.note === undefined ? "" : ` · ${row.note}`;
  const badge = row.badge === undefined ? "" : ` ${row.badge}`;
  const title = row.title === "" || row.title === row.id ? "" : `  ${row.title}`;
  const third =
    object.error !== undefined
      ? chunk(fit(object.error, width), palette.error)
      : row.error !== undefined
        ? chunk(fit(row.error, width), palette.error)
        : object.unavailable !== undefined
        ? chunk(fit(object.unavailable, width), palette.weak)
        : position !== undefined
          ? chunk(fit(position, width), palette.accent)
          : chunk("");
  return [
    chunk(fit(`${bareId(row.id)}${title}`, width), palette.text, TextAttributes.BOLD),
    chunk("\n"),
    chunk(fit(`${row.state}${badge}${note}`, width), palette.weak),
    chunk("\n"),
    third,
    chunk("\n"),
  ];
}

function sectionTabs(object: TuiObject, palette: TuiPalette, width: number): TextChunk[] {
  const chunks: TextChunk[] = [];
  let rule = "";
  let used = 0;
  object.sections.forEach((section, index) => {
    const label = `${section.title}${section.live ? " ●" : ""}`;
    const gap = index > 0 ? "  " : "";
    if (used + gap.length + label.length > width) return;
    const active = index === object.active;
    chunks.push(chunk(gap));
    chunks.push(
      chunk(
        label,
        active ? palette.accent : palette.weak,
        active ? TextAttributes.BOLD : TextAttributes.NONE,
      ),
    );
    rule += `${" ".repeat(gap.length)}${(active ? "─" : " ").repeat(label.length)}`;
    used += gap.length + label.length;
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
    return styled([chunk("\n"), chunk("select an object", palette.weak)]);
  }
  const section = activeSection(state);
  const width = sectionWidth(state);
  return styled([
    chunk("\n"),
    ...objectHeader(object, palette, width, pagePosition(section)),
    ...sectionTabs(object, palette, width),
    ...(section === undefined
      ? sectionContent(state, section, palette)
      : [
          ...sectionContent(state, section, palette),
          ...sectionHint(section, section.following, palette, width),
        ]),
  ]);
}

function keyContent(palette: TuiPalette): StyledText {
  const chunks: TextChunk[] = [chunk("keys\n", palette.accent, TextAttributes.BOLD)];
  for (const [key, what] of KEY_LIST) {
    chunks.push(chunk(`  ${key}`, palette.accent));
    chunks.push(chunk(`  ${what}\n`, palette.weak));
  }
  return styled(chunks);
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
  if (input === undefined || input.kind === "confirm") return undefined;
  const bar = "▏";
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
  const chunks: TextChunk[] = [chunk(`: ${input.query}${bar}\n`, palette.accent)];
  const entries = paletteEntries(state);
  if (entries.length === 0) chunks.push(chunk("nothing matches", palette.weak));
  // The box holds fewer lines than a long list: keep the cursor in view.
  const rows = Math.max(1, (overlayBox(state)?.height ?? 5) - 4 - 1);
  const start = Math.max(0, Math.min(input.cursor - Math.floor(rows / 2), entries.length - rows));
  entries.slice(start, start + rows).forEach((entry, offset) => {
    const at = start + offset;
    const hint = entryHint(entry);
    chunks.push(chunk(at === input.cursor ? "❯ " : "  ", palette.accent));
    chunks.push(chunk(`${entry.group.padEnd(7)} `, palette.weak));
    const marked = new Set(matchPositions(input.query, entry));
    const colour = at === input.cursor ? palette.accent : palette.text;
    for (const run of nameRuns(entry.name, marked)) {
      chunks.push(
        run.marked
          ? chunk(run.text, palette.accent, TextAttributes.BOLD | TextAttributes.UNDERLINE)
          : chunk(run.text, colour),
      );
    }
    chunks.push(chunk(hint === "" ? "\n" : `  ${hint}\n`, palette.weak));
  });
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
  const lines = kind === "keys" ? KEY_LIST.length + 1 : kind === "confirm" ? 2 : inputLines(state);
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
  if (input?.kind === "note") return input.text.split("\n").length + 2;
  if (input?.kind === "palette") return Math.max(1, paletteEntries(state).length) + 1;
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
        ? styled([chunk(` ${fit(footerText(state), width)}`, palette.weak)])
        : styled([chunk(` ${fit(status, width)}`, palette.error)]),
    list: dimmed(
      listContent(state, activeTab(state), palette),
      state.connection === "unreachable",
      palette,
    ),
    right: objectContent(state, palette),
    overlay: state.keys
      ? keyContent(palette)
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
    height: KEY_LIST.length + 5,
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
