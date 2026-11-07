/**
 * The OpenTUI view: it turns one `TuiState` into boxes and styled text. It owns
 * no state, reads no clock and calls no client; every change arrives through
 * `render(state)`.
 */

import {
  BoxRenderable,
  RGBA,
  StyledText,
  TextAttributes,
  TextRenderable,
  type CliRenderer,
  type TextChunk,
} from "@opentui/core";
import { chunksOfLine, type MarkdownPalette } from "../markdown.ts";
import { sanitize } from "../sanitize.ts";
import {
  KEY_LIST,
  activeSection,
  activeTab,
  footerText,
  sectionLayout,
  listWindow,
  sectionViewport,
  statusText,
  rowMark,
  tabLabel,
  twoPane,
  type TuiObject,
  type TuiRow,
  type TuiSection,
  type TuiState,
  type TuiTab,
  type TuiTheme,
} from "../state.ts";

/** The colours of one theme. The accent values are the app's design tokens. */
export interface TuiPalette extends MarkdownPalette {
  readonly accent: string;
  readonly run: string;
  readonly error: string;
  readonly add: string;
  readonly remove: string;
  readonly weak: string;
  readonly text: string;
}

/** Light and dark palettes; the accent, the run blue and the error red differ. */
export const TUI_PALETTE: Readonly<Record<TuiTheme, TuiPalette>> = {
  light: {
    accent: "#5b3fd0",
    run: "#1f6feb",
    error: "#c62828",
    add: "#1a7f37",
    remove: "#cf222e",
    weak: "#6b7280",
    text: "#1f2937",
  },
  dark: {
    accent: "#a793ff",
    run: "#4f8cff",
    error: "#ff6b6b",
    add: "#7ee787",
    remove: "#ff7b72",
    weak: "#8b8b8b",
    text: "#e6e6e6",
  },
};

/** The palette a state's theme names. */
export function paletteFor(theme: TuiTheme): TuiPalette {
  return TUI_PALETTE[theme];
}

function chunk(
  text: string,
  color?: string,
  attributes?: number,
): TextChunk {
  return {
    __isChunk: true,
    // Whatever reaches the screen is cleaned here too, so a string that came
    // by another way than the reducer cannot carry a control character.
    text: sanitize(text),
    ...(color === undefined ? {} : { fg: RGBA.fromHex(color) }),
    ...(attributes === undefined ? {} : { attributes }),
  };
}

function styled(chunks: readonly TextChunk[]): StyledText {
  return new StyledText([...chunks]);
}

function headerContent(state: TuiState, palette: TuiPalette): StyledText {
  const pending = state.tabs.find((tab) => tab.kind === "pending");
  const running = state.tabs.find((tab) => tab.kind === "running");
  const types = state.tabs.filter((tab) => tab.kind === "type");
  return styled([
    chunk("operad", palette.accent, TextAttributes.BOLD),
    chunk(" ─ Pending ", palette.weak),
    chunk(String(pending?.list.rows.length ?? 0)),
    chunk(" · Running ", palette.weak),
    chunk(String(running?.list.rows.length ?? 0)),
    ...types.flatMap((tab) => [
      chunk(" · ", palette.weak),
      chunk(tab.title),
    ]),
  ]);
}

function tabsContent(state: TuiState, palette: TuiPalette): StyledText {
  const chunks: TextChunk[] = [];
  state.tabs.forEach((tab, index) => {
    if (index > 0) chunks.push(chunk("   "));
    const active = index === state.active;
    chunks.push(
      chunk(
        `${index + 1} ${tabLabel(tab)}`,
        active ? palette.accent : palette.weak,
        active ? TextAttributes.BOLD : TextAttributes.NONE,
      ),
    );
  });
  return styled(chunks);
}

function marker(row: TuiRow, palette: TuiPalette): TextChunk {
  const mark = rowMark(row);
  if (mark === "waiting") {
    return chunk("●", palette.accent, TextAttributes.BOLD);
  }
  if (mark === "running") {
    return chunk("●", palette.run, TextAttributes.BOLD);
  }
  return chunk(" ");
}

function rowLine(
  row: TuiRow,
  selected: boolean,
  palette: TuiPalette,
): TextChunk[] {
  const note = row.note === undefined ? "" : ` · ${row.note}`;
  return [
    chunk(selected ? "›" : " ", selected ? palette.accent : undefined),
    chunk(" "),
    marker(row, palette),
    chunk(" "),
    chunk(row.id),
    chunk("  "),
    chunk(row.title),
    chunk("  "),
    chunk(`${row.state}${note}`, palette.weak),
    ...(row.error === undefined
      ? []
      : [chunk(`\n    ${row.error}`, palette.error)]),
    chunk("\n"),
  ];
}

function listContent(
  tab: TuiTab | undefined,
  palette: TuiPalette,
  available: number,
): StyledText {
  if (tab === undefined) return styled([chunk("no tabs", palette.weak)]);
  if (tab.list.rows.length === 0) {
    const message = tab.list.loaded
      ? `nothing in ${tab.title.toLowerCase()}`
      : "loading…";
    return styled([chunk(message, palette.weak)]);
  }
  const chunks: TextChunk[] = [];
  const window = listWindow(tab.list, available);
  tab.list.rows.slice(window.start, window.end).forEach((row, offset) => {
    chunks.push(
      ...rowLine(row, window.start + offset === tab.list.cursor, palette),
    );
  });
  if (tab.list.loading) chunks.push(chunk("loading more…", palette.weak));
  if (tab.list.error !== undefined) {
    chunks.push(chunk(`\n${tab.list.error}`, palette.error));
  }
  return styled(chunks);
}

function objectHeader(object: TuiObject, palette: TuiPalette): TextChunk[] {
  const row = object.row;
  const note = row.note === undefined ? "" : ` · ${row.note}`;
  return [
    marker(row, palette),
    chunk(" "),
    chunk(row.id, palette.text, TextAttributes.BOLD),
    chunk("  "),
    chunk(row.title),
    chunk("  "),
    chunk(`${row.state}${note}`, palette.weak),
    chunk("\n"),
    ...(object.error === undefined
      ? []
      : [chunk(`${object.error}\n`, palette.error)]),
    ...(object.unavailable === undefined
      ? []
      : [chunk(`${object.unavailable}\n`, palette.weak)]),
  ];
}

function sectionTabs(object: TuiObject, palette: TuiPalette): TextChunk[] {
  const chunks: TextChunk[] = [];
  object.sections.forEach((section, index) => {
    if (index > 0) chunks.push(chunk("  "));
    const active = index === object.active;
    chunks.push(
      chunk(
        `${active ? "[" : " "}${section.title}${section.live ? " ●" : ""}${active ? "]" : " "}`,
        active ? palette.accent : palette.weak,
        active ? TextAttributes.BOLD : TextAttributes.NONE,
      ),
    );
  });
  chunks.push(chunk("\n"));
  return chunks;
}

function sectionHint(
  section: TuiSection,
  following: boolean,
  palette: TuiPalette,
): TextChunk[] {
  if (section.error !== undefined) {
    return [chunk(`${section.error}\n`, palette.error)];
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
  return styled([
    ...objectHeader(object, palette),
    ...sectionTabs(object, palette),
    ...(section === undefined
      ? sectionContent(state, section, palette)
      : [
          ...sectionContent(state, section, palette),
          ...sectionHint(section, section.following, palette),
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

/** Everything one state draws, as styled text, before any terminal sees it. */
export interface TuiDrawing {
  readonly header: StyledText;
  readonly tabs: StyledText;
  readonly list: StyledText;
  readonly right: StyledText;
  readonly footer: StyledText;
}

/** The styled text of every area for one state; the view only places it. */
export function drawState(state: TuiState): TuiDrawing {
  const palette = paletteFor(state.theme);
  const wide = twoPane(state);
  const status = statusText(state);
  return {
    header: headerContent(state, palette),
    tabs: tabsContent(state, palette),
    footer:
      status === undefined
        ? styled([chunk(footerText(state), palette.weak)])
        : styled([chunk(status, palette.error)]),
    // The header, the tab line and the footer take three lines.
    list:
      state.keys && !wide
        ? keyContent(palette)
        : listContent(activeTab(state), palette, state.height - 3),
    right: state.keys ? keyContent(palette) : objectContent(state, palette),
  };
}

/** What the view exposes to the app. */
export interface TuiView {
  render(state: TuiState): void;
  destroy(): void;
}

/** Builds the render tree once and updates it on every state. */
export function createTuiView(ctx: CliRenderer): TuiView {
  const root = new BoxRenderable(ctx, {
    id: "operad-tui",
    width: "100%",
    height: "100%",
    flexDirection: "column",
  });
  ctx.root.add(root);

  const header = new TextRenderable(ctx, {
    id: "operad-header",
    height: 1,
    flexShrink: 0,
    wrapMode: "none",
    truncate: true,
  });
  const tabs = new TextRenderable(ctx, {
    id: "operad-tabs",
    height: 1,
    flexShrink: 0,
    wrapMode: "none",
    truncate: true,
  });
  const body = new BoxRenderable(ctx, {
    id: "operad-body",
    width: "100%",
    flexGrow: 1,
    flexDirection: "row",
  });
  const listPane = new BoxRenderable(ctx, {
    id: "operad-list-pane",
    height: "100%",
    width: "40%",
    paddingX: 1,
  });
  const list = new TextRenderable(ctx, {
    id: "operad-list",
    width: "100%",
    height: "100%",
    wrapMode: "none",
    truncate: true,
  });
  const rightPane = new BoxRenderable(ctx, {
    id: "operad-right-pane",
    height: "100%",
    flexGrow: 1,
    padding: 1,
    border: true,
    borderStyle: "rounded",
    borderColor: TUI_PALETTE.dark.weak,
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
  const footer = new TextRenderable(ctx, {
    id: "operad-footer",
    height: 1,
    flexShrink: 0,
    wrapMode: "none",
    truncate: true,
  });

  listPane.add(list);
  rightPane.add(right);
  body.add(listPane);
  body.add(rightPane);
  root.add(header);
  root.add(tabs);
  root.add(body);
  root.add(footer);

  return {
    render(state: TuiState): void {
      const palette = paletteFor(state.theme);
      const wide = twoPane(state);
      const drawing = drawState(state);

      header.content = drawing.header;
      tabs.content = drawing.tabs;
      footer.content = drawing.footer;

      listPane.width = wide ? "40%" : "100%";

      const keys = state.keys;
      const object = state.object;
      // On a narrow screen the open object fills the body in the same wrapping
      // text renderable the right pane uses; the list's renderable truncates.
      const showObject = object !== undefined && !keys;
      listPane.visible = wide || !showObject;
      rightPane.visible = wide || showObject;
      rightPane.borderColor = palette.weak;

      list.content = drawing.list;
      right.content = drawing.right;

      root.requestRender();
    },
    destroy(): void {
      root.destroyRecursively();
    },
  };
}
