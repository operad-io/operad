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

/** One line of the palette. */
export interface TuiPaletteEntry {
  /** `<plugin>:<action>`. */
  readonly name: string;
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

/** Does `query` match `name` as a subsequence? Lower is better; -1 is none. */
export function fuzzyScore(query: string, name: string): number {
  const wanted = query.toLowerCase().replace(/\s+/g, "");
  if (wanted === "") return 0;
  const text = name.toLowerCase();
  let at = 0;
  let first = -1;
  let last = -1;
  for (const char of graphemes(wanted)) {
    const found = text.indexOf(char, at);
    if (found < 0) return -1;
    if (first < 0) first = found;
    last = found;
    at = found + char.length;
  }
  // A tight match near the start of the name ranks first.
  return (last - first) * 100 + first;
}

/** The palette's lines for the typed query, best match first. */
export function paletteEntries(state: TuiState): readonly TuiPaletteEntry[] {
  const object = state.object;
  if (object === undefined) return [];
  const query = state.input?.kind === "palette" ? state.input.query : "";
  return object.actions
    .map((action, order) => ({ action, order, score: fuzzyScore(query, action.name) }))
    .filter((item) => item.score >= 0)
    .sort((a, b) => a.score - b.score || a.order - b.order)
    .map(({ action }) => ({
      name: action.name,
      key: keyOf(state.bindings, action),
      needsNote: action.note !== undefined,
      confirm: action.confirm,
    }));
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
      const chosen = entries[Math.min(input.cursor, entries.length - 1)];
      return chosen === undefined ? state : startAction({ ...state, input: undefined }, chosen.name);
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

/** The server refused (or the network failed): show it verbatim. */
export function actionFailed(
  state: TuiState,
  status: number | undefined,
  message: string,
): TuiState {
  const line = status === undefined ? message : `${status} ${message}`;
  return { ...withNotice(state, line), acting: false, actionRequest: undefined };
}

/** The footer line a confirmation asks, in red. */
export function confirmText(state: TuiState): string | undefined {
  const input = state.input;
  return input?.kind === "confirm"
    ? `${input.action} ${bareId(input.id)}? [y/N]`
    : undefined;
}
