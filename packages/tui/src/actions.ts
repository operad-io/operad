/**
 * The action half of the reducer: the main action, the `:` palette, bound keys,
 * the note input and the confirmation. Everything here is a pure function of the
 * state; the shell sends the request this code leaves in `actionRequest`.
 */

import type { ViewAction } from "@operad-io/engine";
import { sanitize } from "./sanitize.ts";
import type { TuiBinding, TuiInput, TuiState } from "./state.ts";
import { graphemes } from "./wrap.ts";

/** The key that runs the main action when the plugin binds none to it. */
export const MAIN_KEY = "a";

/**
 * Every key the TUI uses itself for navigation and control (lower case). A
 * plugin default or a `keys.json` entry on one of these is dropped when the
 * bindings are resolved; `handleKey` never looks a binding up for them.
 */
export const RESERVED_KEYS: readonly string[] = [
  "enter", "return", "escape", "esc", "tab",
  "up", "down", "left", "right", "arrowup", "arrowdown", "arrowleft", "arrowright",
  "pageup", "page-up", "prior", "pagedown", "page-down", "next",
  "home", "end", "space", " ",
  "[", "]", ":", "?", "/",
  "b", "f", "g", "j", "k", "n", "p", "q", "r",
  "1", "2", "3", "4", "5", "6", "7", "8", "9",
];

/** Is `key` one the TUI keeps for itself? Letters match in either case. */
export function isReserved(key: string): boolean {
  const lowered = key.toLowerCase();
  // handleKey ignores every Ctrl or Meta chord, so none can be bound.
  return RESERVED_KEYS.includes(lowered) || CHORD.test(lowered);
}

const CHORD = /^(ctrl|control|meta|cmd|command|alt|option|opt|super)[-+].|^\^./;

/** The bindings that may run actions, and the footer line naming those dropped. */
export function resolveBindings(bindings: readonly TuiBinding[]): {
  readonly bindings: readonly TuiBinding[];
  readonly notice: string | undefined;
} {
  const kept = bindings.filter((binding) => !isReserved(binding.key));
  const dropped = bindings.filter((binding) => isReserved(binding.key));
  return {
    bindings: kept,
    notice:
      dropped.length === 0
        ? undefined
        : sanitize(
            `reserved keys ignored: ${dropped
              .map((b) => `${b.key} (${b.action}, ${b.source})`)
              .join(", ")}`,
          ),
  };
}

/** The palette's groups, in the order they are shown. */
export const PALETTE_GROUPS = ["actions", "tui"] as const;
export type TuiPaletteGroup = (typeof PALETTE_GROUPS)[number];

/** One line of the palette. */
export interface TuiPaletteEntry {
  readonly group: TuiPaletteGroup;
  /** `<plugin>:<action>` for an action; the command's words for the TUI. */
  readonly name: string;
  /** One line that says what the entry does; search reads it too. */
  readonly title: string;
  /** Set on a TUI command: what the reducer runs. */
  readonly command?: TuiCommand | undefined;
  readonly key: string | undefined;
  readonly needsNote: boolean;
  readonly confirm: boolean;
}

/** The key that should reach `bindings`: a shifted letter is upper case. */
export function keyLabel(key: string, shift: boolean): string {
  return shift && /^[a-z]$/i.test(key) ? key.toUpperCase() : key;
}

/** The binding for a key; a user binding beats a plugin default. */
export function bindingFor(
  bindings: readonly TuiBinding[],
  key: string,
  source?: "plugin" | "user",
): TuiBinding | undefined {
  const found = bindings.filter(
    (binding) => binding.key === key && (source === undefined || binding.source === source),
  );
  return found.find((binding) => binding.source === "user") ?? found[0];
}

/** The key bound to an action, a user binding first. */
export function keyOf(
  bindings: readonly TuiBinding[],
  action: ViewAction,
): string | undefined {
  const mine = bindings.filter((binding) => binding.action === action.name);
  // A key is only the action's key when it still resolves to it.
  const live = mine.filter((binding) => bindingFor(bindings, binding.key)?.action === action.name);
  return (
    live.find((binding) => binding.source === "user")?.key ??
    live[0]?.key
  );
}

function bareId(id: string): string {
  const at = id.indexOf(":");
  return at < 0 ? id : id.slice(at + 1);
}

/** The first available action, the one the footer offers. */
export function mainAction(state: TuiState): ViewAction | undefined {
  return state.object?.actions[0];
}

/** The key the footer shows for the main action. */
export function mainKey(state: TuiState): string | undefined {
  const main = mainAction(state);
  const own = main === undefined ? undefined : keyOf(state.bindings, main);
  if (own !== undefined) return own;
  // `a` runs the main action only while no binding claims it.
  return bindingFor(state.bindings, MAIN_KEY) === undefined ? MAIN_KEY : undefined;
}

/** The characters after which a letter starts a word. */
const WORD_BREAKS = ":-. /";

const HIT = 1;
const RUN = 4;
const WORD_START = 10;

/** The best way `word` is a subsequence of `text`: its score (higher is better) and where it matched. */
function matchWord(
  word: readonly string[],
  text: readonly string[],
): { readonly score: number; readonly at: readonly number[] } | undefined {
  const n = text.length;
  const m = word.length;
  if (m === 0) return { score: 0, at: [] };
  if (m > n) return undefined;
  const start = (i: number): boolean => i === 0 || WORD_BREAKS.includes(text[i - 1] ?? "");
  // best[j][i]: the best score with word[j] matched at text[i]; from[j][i] is the previous index.
  const best: number[][] = [];
  const from: number[][] = [];
  for (let j = 0; j < m; j++) {
    const row: number[] = new Array<number>(n).fill(-1);
    const back: number[] = new Array<number>(n).fill(-1);
    for (let i = j; i < n; i++) {
      if (text[i] !== word[j]) continue;
      const own = HIT + (start(i) ? WORD_START : 0);
      if (j === 0) {
        row[i] = own;
        continue;
      }
      const previous = best[j - 1] ?? [];
      let top = -1;
      let topAt = -1;
      for (let k = j - 1; k < i; k++) {
        const base = previous[k] ?? -1;
        if (base < 0) continue;
        const value = base + (k === i - 1 ? RUN : 0);
        if (value > top) {
          top = value;
          topAt = k;
        }
      }
      if (topAt >= 0) {
        row[i] = top + own;
        back[i] = topAt;
      }
    }
    best.push(row);
    from.push(back);
  }
  const last = best[m - 1] ?? [];
  let end = -1;
  for (let i = 0; i < n; i++) {
    // An earlier end wins a tie, so the match sits near the start.
    if ((last[i] ?? -1) > (last[end] ?? -1)) end = i;
  }
  if (end < 0) return undefined;
  const at: number[] = [];
  for (let j = m - 1, i = end; j >= 0; j--) {
    at.unshift(i);
    i = from[j]?.[i] ?? -1;
  }
  return { score: last[end] ?? 0, at };
}

function unitsOf(text: string): string[] {
  return graphemes(text.toLowerCase());
}

function wordsOf(query: string): string[][] {
  return query
    .split(/\s+/)
    .filter((word) => word !== "")
    .map(unitsOf);
}

/**
 * Does `query` match `name`? A space in the query separates words that may
 * match in any order; each word is a subsequence, best where it starts a word.
 * Lower is better; -1 is no match.
 */
export function fuzzyScore(query: string, name: string): number {
  const words = wordsOf(query);
  if (words.length === 0) return 0;
  const text = unitsOf(name);
  let total = 0;
  for (const word of words) {
    const found = matchWord(word, text);
    if (found === undefined) return -1;
    total += found.score;
  }
  return Math.max(0, 100000 - total * 10) + text.length;
}

/** What a palette entry is called in the list of recent entries. */
export function entryId(entry: Pick<TuiPaletteEntry, "group" | "name">): string {
  return `${entry.group}/${entry.name}`;
}

/** How many entries the palette remembers as the last used. */
export const RECENT_ENTRIES = 5;

/** The matches of one entry: its rank (higher first) and the characters of its name that matched. */
function matchEntry(
  words: readonly (readonly string[])[],
  entry: TuiPaletteEntry,
): { readonly score: number; readonly name: readonly number[] } | undefined {
  const fields = [
    { units: unitsOf(entry.name), bonus: 2000, name: true },
    { units: unitsOf(entry.group), bonus: 1000, name: false },
    { units: unitsOf(entry.title), bonus: 0, name: false },
  ];
  let score = 0;
  const marked = new Set<number>();
  for (const word of words) {
    let top: { score: number; at: readonly number[]; name: boolean } | undefined;
    for (const field of fields) {
      const found = matchWord(word, field.units);
      if (found === undefined) continue;
      const value = found.score + field.bonus;
      if (top === undefined || value > top.score) top = { score: value, at: found.at, name: field.name };
    }
    if (top === undefined) return undefined;
    score += top.score;
    if (top.name) for (const index of top.at) marked.add(index);
  }
  return { score, name: [...marked].sort((a, b) => a - b) };
}

/** The positions (grapheme indexes) in an entry's name that `query` matched. */
export function matchPositions(query: string, entry: TuiPaletteEntry): readonly number[] {
  return matchEntry(wordsOf(query), entry)?.name ?? [];
}

/** What a TUI command does; each is what a key does. */
export type TuiCommand =
  | { readonly kind: "help" | "refresh" | "back" | "quit" }
  | { readonly kind: "go"; readonly tabId: string };

function commandEntries(state: TuiState): readonly TuiPaletteEntry[] {
  const make = (
    name: string,
    title: string,
    key: string | undefined,
    command: TuiCommand,
  ): TuiPaletteEntry => ({
    group: "tui",
    name,
    title,
    key,
    needsNote: false,
    confirm: false,
    command,
  });
  const tabs = state.tabs.map((tab, at) => ({ tab, key: at < 9 ? String(at + 1) : undefined }));
  const go = (kind: "pending" | "running"): TuiPaletteEntry | undefined => {
    const found = tabs.find((item) => item.tab.kind === kind);
    return found === undefined
      ? undefined
      : make(`go to ${kind}`, `show the ${kind} list`, found.key, { kind: "go", tabId: found.tab.id });
  };
  const types = tabs
    .filter((item) => item.tab.kind === "type")
    .map((item) =>
      make(`go to ${item.tab.title}`, `show the list of ${item.tab.title}`, item.key, {
        kind: "go",
        tabId: item.tab.id,
      }),
    );
  return [
    make("help", "show or hide the key list", "?", { kind: "help" }),
    make("refresh", "load the lists again", "r", { kind: "refresh" }),
    ...[go("pending"), go("running")].filter((entry): entry is TuiPaletteEntry => entry !== undefined),
    ...types,
    make("go back", "close the open object", "escape", { kind: "back" }),
    make("quit", "leave the TUI", "q", { kind: "quit" }),
  ];
}

/** The palette's lines for the typed query: groups in order, best match first inside one. */
export function paletteEntries(state: TuiState): readonly TuiPaletteEntry[] {
  const object = state.object;
  const query = state.input?.kind === "palette" ? state.input.query : "";
  const actions: readonly TuiPaletteEntry[] =
    object === undefined
      ? []
      : object.actions.map((action) => ({
          group: "actions",
          name: action.name,
          title: `${action.name} on ${bareId(object.id)}`,
          key: keyOf(state.bindings, action),
          needsNote: action.note !== undefined,
          confirm: action.confirm,
        }));
  const words = wordsOf(query);
  const rank = (entries: readonly TuiPaletteEntry[]): readonly TuiPaletteEntry[] =>
    entries
      .map((entry, order) => ({ entry, order, found: matchEntry(words, entry) }))
      .filter((item) => item.found !== undefined)
      // Equal scores keep the order the entries were listed in.
      .sort((a, b) => (b.found?.score ?? 0) - (a.found?.score ?? 0) || a.order - b.order)
      .map((item) => item.entry);
  const all = [...rank(actions), ...rank(commandEntries(state))];
  if (words.length > 0) return all;
  // With no query the last used entries come first, the latest first.
  const used = state.recent
    .map((id) => all.find((entry) => entryId(entry) === id))
    .filter((entry): entry is TuiPaletteEntry => entry !== undefined)
    .slice(0, RECENT_ENTRIES);
  return [...used, ...all.filter((entry) => !used.includes(entry))];
}

/** The state after an entry ran: it is now the latest of the recent ones. */
export function remember(state: TuiState, entry: TuiPaletteEntry): TuiState {
  const id = entryId(entry);
  return { ...state, recent: [id, ...state.recent.filter((one) => one !== id)].slice(0, RECENT_ENTRIES) };
}

/** The entry the palette cursor is on. */
export function chosenEntry(state: TuiState): TuiPaletteEntry | undefined {
  const input = state.input;
  if (input?.kind !== "palette") return undefined;
  const entries = paletteEntries(state);
  return entries[Math.min(input.cursor, entries.length - 1)];
}

/** The words after an entry: its key and what it asks. */
export function entryHint(entry: TuiPaletteEntry): string {
  return [
    entry.key,
    entry.needsNote ? "needs a note" : undefined,
    entry.confirm ? "asks to confirm" : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
}

function withNotice(state: TuiState, notice: string): TuiState {
  return { ...state, notice: sanitize(notice) };
}

/** Runs an action on the open object, or says why it cannot. */
export function startAction(state: TuiState, name: string): TuiState {
  const object = state.object;
  const closed: TuiState = { ...state, input: undefined };
  if (object === undefined) return withNotice(closed, "no object is selected");
  if (state.acting) return withNotice(closed, "the last action has not answered yet");
  const action = object.actions.find((candidate) => candidate.name === name);
  if (action === undefined) {
    return withNotice(closed, `${name} is not available for ${bareId(object.id)}`);
  }
  if (action.note !== undefined) {
    return {
      ...closed,
      input: {
        kind: "note",
        action: action.name,
        id: object.id,
        text: "",
        required: action.noteRequired,
        confirm: action.confirm,
      },
    };
  }
  if (action.confirm) {
    return { ...closed, input: { kind: "confirm", action: action.name, id: object.id } };
  }
  return send(closed, { action: action.name, id: object.id });
}

function send(
  state: TuiState,
  request: { action: string; id: string; note?: string; confirmed?: boolean },
): TuiState {
  return { ...state, input: undefined, acting: true, actionRequest: request };
}

/** `a`, or a bound key: the key that reached the reducer, as a label. */
export function runKey(state: TuiState, label: string): TuiState | undefined {
  const bound = bindingFor(state.bindings, label);
  if (bound !== undefined) return startAction(state, bound.action);
  if (label === MAIN_KEY) {
    const main = mainAction(state);
    return main === undefined
      ? withNotice(state, "no action is available")
      : startAction(state, main.name);
  }
  return undefined;
}

/** The text a key adds to an input, if it adds any. */
export function typed(event: { readonly text?: string | undefined }): string | undefined {
  const text = event.text;
  return text === undefined || text === "" || /[\u0000-\u001f\u007f]/.test(text)
    ? undefined
    : text;
}

export function dropLast(text: string): string {
  const all = graphemes(text);
  all.pop();
  return all.join("");
}

/** A key arrives while the palette, a note or a confirmation is open. */
export function inputKey(
  state: TuiState,
  input: Exclude<TuiInput, { readonly kind: "pages" }>,
  event: {
    readonly key: string;
    readonly text?: string | undefined;
    readonly shift?: boolean | undefined;
    readonly ctrl?: boolean | undefined;
    readonly meta?: boolean | undefined;
  },
): TuiState {
  const key = event.key.toLowerCase();
  const escape = key === "escape" || key === "esc";
  const enter = key === "enter" || key === "return";
  if (input.kind === "confirm") {
    const yes = event.ctrl !== true && event.meta !== true && (key === "y" || event.text === "y" || event.text === "Y");
    if (!yes) return { ...state, input: undefined };
    return send(state, {
      action: input.action,
      id: input.id,
      ...(input.note === undefined ? {} : { note: input.note }),
      confirmed: true,
    });
  }
  if (escape) return { ...state, input: undefined };
  if (input.kind === "palette") {
    const entries = paletteEntries(state);
    const down = key === "down" || key === "arrowdown" || (event.ctrl === true && (key === "n" || key === "j"));
    const up = key === "up" || key === "arrowup" || (event.ctrl === true && (key === "p" || key === "k"));
    if (down || up) {
      const cursor = Math.min(
        Math.max(0, input.cursor + (down ? 1 : -1)),
        Math.max(0, entries.length - 1),
      );
      return { ...state, input: { ...input, cursor } };
    }
    if (enter) {
      const chosen = chosenEntry(state);
      // A command is run by the reducer that owns the state it changes.
      return chosen === undefined || chosen.command !== undefined
        ? state
        : startAction(remember({ ...state, input: undefined }, chosen), chosen.name);
    }
    if (key === "backspace") {
      return { ...state, input: { ...input, query: dropLast(input.query), cursor: 0 } };
    }
    const text = event.ctrl === true || event.meta === true ? undefined : typed(event);
    return text === undefined
      ? state
      : { ...state, input: { ...input, query: input.query + text, cursor: 0 } };
  }
  // A note: Enter sends, Shift-Enter or Ctrl-J adds a line.
  const newline = (enter && event.shift === true) || (event.ctrl === true && (key === "j" || key === "linefeed")) || key === "linefeed";
  if (newline) return { ...state, input: { ...input, text: `${input.text}\n` } };
  if (enter) {
    const note = input.text;
    if (note.trim() === "" && input.required) return withNotice(state, "a note is required");
    if (input.confirm) {
      return {
        ...state,
        input: {
          kind: "confirm",
          action: input.action,
          id: input.id,
          ...(note === "" ? {} : { note }),
        },
      };
    }
    return send(state, {
      action: input.action,
      id: input.id,
      ...(note === "" ? {} : { note }),
    });
  }
  if (key === "backspace") return { ...state, input: { ...input, text: dropLast(input.text) } };
  const text = event.ctrl === true || event.meta === true ? undefined : typed(event);
  return text === undefined ? state : { ...state, input: { ...input, text: input.text + text } };
}

/**
 * The server refused (or the network failed): show the line itself. The status
 * is for logs, never for the person; a plugin's own field prefix ("confirm: ")
 * is dropped too.
 */
export function actionFailed(state: TuiState, message: string): TuiState {
  return {
    ...withNotice(state, refusalLine(message)),
    acting: false,
    actionRequest: undefined,
  };
}

/** The line a person reads: no status number, no leading `field: `. */
export function refusalLine(message: string): string {
  return message
    .replace(/^\d{3}\s+/, "")
    .replace(/^[a-z][a-z0-9-]*: (?=\S)/, "");
}

/** The footer line a confirmation asks, in red. */
export function confirmText(state: TuiState): string | undefined {
  const input = state.input;
  return input?.kind === "confirm"
    ? `${input.action} ${bareId(input.id)}? [y/N]`
    : undefined;
}
