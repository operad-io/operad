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
import { entryHint, paletteEntries } from "../actions.ts";
import { chunksOfLine } from "../markdown.ts";
import { TUI_PALETTE, resolvePalette, toRgba, type TuiPalette } from "../theme.ts";
import { sanitize } from "../sanitize.ts";
import { displayWidth, graphemes } from "../wrap.ts";
import {
  KEY_LIST,
  activeSection,
  activeTab,
  LIST_WIDTH,
  LIST_X,
  RIGHT_X,
  bodyHeight,
  filterHeader,
  footerText,
  noticeText,
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
export function paletteFor(theme: TuiTheme, name = "auto"): TuiPalette {
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
    if (index > 0) chunks.push(chunk("   "));
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
    chunk(` ${"─".repeat(Math.max(0, state.width - 2))}`, palette.weak),
  ]);
}

function dividerContent(state: TuiState, palette: TuiPalette): StyledText {
  return styled([
    chunk(Array.from({ length: bodyHeight(state) }, () => "│").join("\n"), palette.weak),
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
function glyph(row: TuiRow, palette: TuiPalette): TextChunk {
  if (row.error !== undefined) return chunk("✗", palette.error);
  const mark = rowMark(row);
  // A mark this client does not know (a newer server) draws as plain.
  const shown = mark === "none" ? undefined : MARK_GLYPHS[mark];
  if (shown !== undefined) return chunk(shown.char, palette[shown.colour]);
  if (/^(done|merged)$/i.test(row.state)) return chunk("✓", palette.ok);
  return chunk("○", palette.weak);
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

function rowText(row: TuiRow, kind: TuiTab["kind"]): string {
  if (kind !== "type") {
    return row.openable === false && row.title !== "" ? row.title : row.id;
  }
  const { short, slug } = splitId(bareId(row.id));
  if (row.error !== undefined || slug === "") return short;
  return `${short} ${slug}`;
}

function rowLine(
  row: TuiRow,
  kind: TuiTab["kind"],
  selected: boolean,
  palette: TuiPalette,
  width: number,
): TextChunk[] {
  return [
    chunk(selected ? "❯" : " ", palette.accent),
    chunk(" "),
    glyph(row, palette),
    chunk(" "),
    chunk(
      fit(rowText(row, kind), width - 4),
      selected ? palette.accent : undefined,
      undefined,
      selected ? palette.tint : undefined,
    ),
    chunk("\n"),
  ];
}

/** The columns a list row has, marker and glyph included. */
function listCells(state: TuiState): number {
  return twoPane(state) ? LIST_WIDTH : Math.max(1, state.width - LIST_X - 1);
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
    return styled([chunk(message, palette.weak)]);
  }
  const width = listCells(state);
  const chunks: TextChunk[] = [];
  const window = listWindow(tab.list, bodyHeight(state));
  tab.list.rows.slice(window.start, window.end).forEach((row, offset) => {
    chunks.push(
      ...rowLine(row, tab.kind, window.start + offset === tab.list.cursor, palette, width),
    );
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
  chunks.push(chunk(rule.trimEnd(), palette.weak));
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
  if (object === undefined) return styled([chunk("select an object", palette.weak)]);
  const section = activeSection(state);
  const width = sectionWidth(state);
  return styled([
    ...objectHeader(object, palette, width),
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

/** The palette or the note input, drawn in the box; undefined when neither is open. */
function inputContent(state: TuiState, palette: TuiPalette): StyledText | undefined {
  const input = state.input;
  if (input === undefined || input.kind === "confirm") return undefined;
  const bar = "▏";
  if (input.kind === "note") {
    const chunks: TextChunk[] = [
      chunk(`${input.action} · note${input.required ? " (required)" : ""}\n`, palette.accent, TextAttributes.BOLD),
      chunk(`${input.text}${bar}\n`),
      chunk("enter sends · shift-enter or ctrl-j adds a line · esc cancels", palette.weak),
    ];
    return styled(chunks);
  }
  const chunks: TextChunk[] = [chunk(`: ${input.query}${bar}\n`, palette.accent)];
  const entries = paletteEntries(state);
  if (state.object === undefined) {
    chunks.push(chunk("no object is selected", palette.weak));
  } else if (entries.length === 0) {
    chunks.push(chunk("no action matches", palette.weak));
  }
  entries.forEach((entry, at) => {
    const hint = entryHint(entry);
    chunks.push(chunk(at === input.cursor ? "❯ " : "  ", palette.accent));
    chunks.push(chunk(entry.name, at === input.cursor ? palette.accent : undefined));
    chunks.push(chunk(hint === "" ? "\n" : `  ${hint}\n`, palette.weak));
  });
  return styled(chunks);
}

/** The line count the box needs for the input it draws. */
function inputLines(state: TuiState): number {
  const input = state.input;
  if (input?.kind === "note") return input.text.split("\n").length + 2;
  if (input?.kind === "palette") return Math.max(1, paletteEntries(state).length) + 1;
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
  /** The `?` key list, the one place a closed box is drawn. */
  readonly overlay: StyledText | undefined;
}

/** The styled text of every area for one state; the view only places it. */
export function drawState(state: TuiState, themeName = "auto"): TuiDrawing {
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
    overlay: state.keys ? keyContent(palette) : inputContent(state, palette),
  };
}

/** What the view exposes to the app. */
export interface TuiView {
  render(state: TuiState): void;
  destroy(): void;
}

/** Builds the render tree once and updates it on every state. */
export function createTuiView(ctx: CliRenderer, themeName = "auto"): TuiView {
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
    width: LIST_X + LIST_WIDTH,
    flexShrink: 0,
    paddingLeft: LIST_X,
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
    paddingLeft: RIGHT_X - LIST_X - LIST_WIDTH - 1,
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
  const overlayBox = new BoxRenderable(ctx, {
    id: "operad-keys",
    position: "absolute",
    left: 2,
    top: 2,
    width: 60,
    height: KEY_LIST.length + 4,
    border: true,
    borderStyle: "rounded",
    borderColor: toRgba(TUI_PALETTE.dark.rule),
    paddingX: 1,
    visible: false,
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
  overlayBox.add(overlay);
  body.add(listPane);
  body.add(divider);
  body.add(rightPane);
  root.add(header);
  root.add(headerRule);
  root.add(body);
  root.add(footerRule);
  root.add(footer);
  root.add(overlayBox);

  return {
    render(state: TuiState): void {
      const palette = paletteFor(state.theme, themeName);
      const wide = twoPane(state);
      const drawing = drawState(state, themeName);

      header.content = drawing.header;
      headerRule.content = drawing.rule;
      footerRule.content = drawing.rule;
      footer.content = drawing.footer;

      listPane.width = wide ? LIST_X + LIST_WIDTH : "100%";
      // On a narrow screen the open object takes the place of the list.
      const showObject = state.object !== undefined;
      listPane.visible = wide || !showObject;
      divider.visible = wide;
      rightPane.visible = wide || showObject;
      rightPane.paddingLeft = wide ? RIGHT_X - LIST_X - LIST_WIDTH - 1 : LIST_X;

      list.content = drawing.list;
      divider.content = drawing.divider;
      right.content = drawing.right;

      overlayBox.visible = drawing.overlay !== undefined;
      overlayBox.borderColor = toRgba(palette.rule);
      overlayBox.width = Math.max(10, Math.min(60, state.width - 4));
      const wanted = state.keys ? KEY_LIST.length + 4 : inputLines(state) + 2;
      overlayBox.height = Math.max(3, Math.min(wanted, state.height - 3));
      if (drawing.overlay !== undefined) overlay.content = drawing.overlay;

      root.requestRender();
    },
    destroy(): void {
      root.destroyRecursively();
    },
  };
}
