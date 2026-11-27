import { describe, expect, test } from "bun:test";
import type { ChoiceInfo, PendingItem } from "@operad-io/engine";
import { initialState, reduce, type TuiState, type TuiStateEvent } from "../src/state.ts";
import { drawState, overlayBox, paletteFor } from "../src/view/index.ts";
import { toRgba } from "../src/theme.ts";

function question(choices: readonly string[], choiceInfo?: Readonly<Record<string, ChoiceInfo>>): TuiState {
  const item: PendingItem = {
    runId: "run-1",
    flow: "flow",
    step: "ask",
    prompt: "Approve?",
    choices,
    waitId: "wait:1",
    actions: [],
    ...(choiceInfo === undefined ? {} : { choiceInfo }),
  };
  return reduce(initialState({ width: 120, height: 30, theme: "dark" }), { type: "pending", items: [item] });
}

function press(state: TuiState, ...keys: (string | TuiStateEvent)[]): TuiState {
  let next = state;
  for (const key of keys) {
    next =
      typeof key === "string"
        ? reduce(next, { type: "key", key, ...(key.length === 1 ? { text: key } : {}) })
        : reduce(next, key);
  }
  return next;
}

const typeText = (text: string): TuiStateEvent[] =>
  [...text].map((char) => ({ type: "key", key: char === " " ? "space" : char, text: char }));

function part(state: TuiState, text: string): { readonly text: string; readonly fg?: unknown } {
  const overlay = drawState(state).overlay;
  if (overlay === undefined) throw new Error("no overlay");
  const found = overlay.chunks.find((chunk) => chunk.text === text);
  if (found === undefined) throw new Error(`no part "${text}"`);
  return found;
}

function colourOf(state: TuiState, text: string): string {
  const fg = part(state, text).fg as { toInts(): number[] } | undefined;
  return fg === undefined ? "" : fg.toInts().join(",");
}

const INFO: Readonly<Record<string, ChoiceInfo>> = {
  allow: { label: "Allow once", hint: "Run this call once in the main clone.", role: "primary" },
  keep: { label: "Keep", hint: "Leave the branch alone." },
  deny: { label: "Deny", hint: "Refuse this call.", role: "destructive" },
  discard: { label: "Discard", hint: "Throw the branch away.", role: "destructive" },
};

describe("a question whose choices say what they are", () => {
  test("each line shows its label and hint, the primary is selected, and a destructive line is in the error colour", () => {
    let state = question(["deny", "keep", "allow", "discard"], INFO);
    state = press(state, "a");
    expect(state.input).toMatchObject({ kind: "answer", cursor: 2 });

    const palette = paletteFor(state.theme, "auto");
    expect(colourOf(state, "Allow once")).toBe(toRgba(palette.accent).toInts().join(","));
    expect(colourOf(state, "Keep")).toBe(toRgba(palette.text).toInts().join(","));
    expect(colourOf(state, "Deny")).toBe(toRgba(palette.error).toInts().join(","));
    expect(colourOf(state, "Discard")).toBe(toRgba(palette.error).toInts().join(","));
    for (const hint of [
      "Run this call once in the main clone.",
      "Leave the branch alone.",
      "Refuse this call.",
      "Throw the branch away.",
    ]) {
      expect(colourOf(state, `  ${hint}`)).toBe(toRgba(palette.weak).toInts().join(","));
    }
  });

  test("a choice whose note is required opens the note input before it answers", () => {
    let state = question(["merge", "rework"], {
      merge: { label: "Merge" },
      rework: { label: "Rework", note: "required" },
    });
    state = press(state, "a", "down", "enter");
    expect(state.input).toMatchObject({
      kind: "note",
      action: "Rework",
      required: true,
      answer: { choice: "rework" },
    });

    state = press(state, ...typeText("the tests fail"), "enter");
    expect(state.input).toMatchObject({ kind: "note", sending: true, required: true });
    expect(state.answerRequest).toEqual({
      runId: "run-1",
      waitId: "wait:1",
      choice: "rework",
      note: "the tests fail",
    });
  });

  test("a choice whose note is optional offers the note input and answers without one on Enter", () => {
    let state = question(["merge"], { merge: { label: "Merge", note: "optional" } });
    state = press(state, "a", "enter");
    expect(state.input).toMatchObject({ kind: "note", action: "Merge", required: false });
    state = press(state, "enter");
    expect(state.answerRequest).toEqual({ runId: "run-1", waitId: "wait:1", choice: "merge" });

    let noted = question(["merge"], { merge: { label: "Merge", note: "optional" } });
    noted = press(noted, "a", "enter", ...typeText("looks good"), "enter");
    expect(noted.answerRequest).toEqual({
      runId: "run-1",
      waitId: "wait:1",
      choice: "merge",
      note: "looks good",
    });
  });

  test("without choice info the list is the raw choices, starts at the first and answers at once", () => {
    let state = question(["yes", "no"]);
    state = press(state, "a");
    expect(state.input).toMatchObject({ kind: "answer", cursor: 0 });
    expect(part(state, "yes").text).toBe("yes");
    state = press(state, "enter");
    expect(state.answerRequest).toEqual({ runId: "run-1", waitId: "wait:1", choice: "yes" });
  });
});

describe("a question that carries a command", () => {
  const command = `/home/someone/${"a-long-directory/".repeat(6)}bin/tool auth login some-provider`;

  function asked(width: number): TuiState {
    const item: PendingItem = {
      runId: "run-1",
      flow: "flow",
      step: "ask",
      prompt: "Run the command below.",
      command,
      choices: ["first", "second"],
      waitId: "wait:1",
      actions: [],
    };
    const state = reduce(initialState({ width, height: 30, theme: "dark" }), { type: "pending", items: [item] });
    return press(state, "a");
  }

  test("shows all of it under the prompt, wrapped to the box, with every choice still in the box", () => {
    for (const width of [120, 50]) {
      const state = asked(width);
      const box = overlayBox(state);
      if (box === undefined) throw new Error("no box");
      const text = (drawState(state).overlay?.chunks ?? []).map((chunk) => chunk.text).join("");
      const lines = text.split("\n");
      expect(lines[0]).toBe("Run the command below.");
      const first = lines.findIndex((line) => line.startsWith("❯ "));
      const shown = lines.slice(1, first);
      expect(shown.length).toBeGreaterThan(1);
      expect(shown.join("").replaceAll(" ", "")).toBe(command.replaceAll(" ", ""));
      for (const line of shown) expect(line.length).toBeLessThanOrEqual(box.width - 4);
      expect(lines.slice(first, first + 2)).toEqual(["❯ first", "  second"]);
      expect(box.height).toBe(lines.length + 4);
    }
  });
});
