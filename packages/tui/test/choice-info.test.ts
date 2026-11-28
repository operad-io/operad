import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import type { ChoiceInfo, PendingItem } from "@operad-io/engine";
import { initialState, reduce, type TuiState, type TuiStateEvent } from "../src/state.ts";
import { createTuiView, drawState, overlayBox, paletteFor } from "../src/view/index.ts";
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
  const HINT = "operad pending prints this command on one line";

  function item(extra: Partial<PendingItem> = {}): PendingItem {
    return {
      runId: "run-1",
      flow: "flow",
      step: "ask",
      prompt: "Run the command below.",
      command,
      choices: ["first", "second"],
      waitId: "wait:1",
      actions: [],
      ...extra,
    };
  }

  function listed(width: number, height: number, extra: Partial<PendingItem> = {}): TuiState {
    return reduce(initialState({ width, height, theme: "dark" }), { type: "pending", items: [item(extra)] });
  }

  /** The overlay's lines above the choices, and the rest. */
  function overlay(state: TuiState): { readonly head: string[]; readonly rest: string[] } {
    const text = (drawState(state).overlay?.chunks ?? []).map((chunk) => chunk.text).join("");
    const lines = text.split("\n");
    const first = lines.findIndex((line) => line.startsWith("❯ "));
    return { head: lines.slice(0, first), rest: lines.slice(first) };
  }

  function boxOf(state: TuiState): { readonly width: number; readonly height: number } {
    const box = overlayBox(state);
    if (box === undefined) throw new Error("no box");
    return box;
  }

  test("a terminal wide enough widens the box and keeps the command on one line", async () => {
    const width = command.length + 4;
    const state = press(listed(width, 30), "a");
    expect(boxOf(state).width).toBe(width);
    expect(overlay(state).head).toEqual(["Run the command below.", command]);

    const setup = await createTestRenderer({ width, height: 30 });
    try {
      const view = createTuiView(setup.renderer);
      view.render(state);
      await setup.renderOnce();
      expect(setup.captureCharFrame().split("\n").some((line) => line.includes(command))).toBe(true);
      view.destroy();
    } finally {
      await setup.dispose();
    }
  });

  test("a command wider than the terminal is wrapped whole, and the box says where it is on one line", () => {
    for (const width of [120, 50]) {
      const state = press(listed(width, 30), "a");
      const box = boxOf(state);
      expect(box.width).toBe(width);
      const { head, rest } = overlay(state);
      expect(head[0]).toBe("Run the command below.");
      const hint = head.findIndex((line) => line.startsWith("operad pending"));
      const shown = head.slice(1, hint);
      expect(shown.length).toBeGreaterThan(1);
      expect(shown.join("").replaceAll(" ", "")).toBe(command.replaceAll(" ", ""));
      expect(head.slice(hint).join(" ")).toBe(HINT);
      for (const line of head) expect(line.length).toBeLessThanOrEqual(box.width - 4);
      expect(rest.slice(0, 2)).toEqual(["❯ first", "  second"]);
      expect(box.height).toBe(head.length + rest.length + 4);
    }
  });

  test("a long question is wrapped to the box, not clipped", () => {
    const prompt = `Choose a provider. ${"Another sentence follows here. ".repeat(5)}Then run the command below.`;
    const state = press(listed(60, 30, { prompt, command: "tool auth login" }), "a");
    const box = boxOf(state);
    const { head, rest } = overlay(state);
    expect(head.at(-1)).toBe("tool auth login");
    expect(head.length).toBeGreaterThan(3);
    expect(head.slice(0, -1).join(" ").replaceAll(/ +/g, " ")).toBe(prompt);
    for (const line of head) expect(line.length).toBeLessThanOrEqual(box.width - 4);
    expect(box.height).toBe(head.length + rest.length + 4);
  });

  test("a short terminal cuts the question, and keeps the command, a choice and the keys in the box", () => {
    const prompt = "A sentence of the question. ".repeat(20);
    const state = press(listed(60, 10, { prompt, command: "tool auth login" }), "a");
    const { head, rest } = overlay(state);
    expect(head.at(-1)).toBe("tool auth login");
    expect(head.at(-2)?.endsWith("…")).toBe(true);
    expect(rest).toEqual(["❯ first", "j/k or arrows move · enter answers · esc cancels"]);
    expect(boxOf(state).height).toBe(10);
    expect(head.length + rest.length).toBe(10 - 4);
  });

  test("the Pending row says first where the command is read", () => {
    const row = listed(120, 30).tabs[0]?.list.rows[0];
    expect(row?.detail?.[0]).toBe("a shows the command");
    const named = listed(120, 30, {
      row: { id: "chat:c1", title: "Chat", state: "open", waiting: true, running: false },
      object: "chat:c1",
    }).tabs[0]?.list.rows[0];
    expect(named?.detail?.[0]).toBe("a shows the command");
    expect(named?.note).toBe("a shows the command · Run the command below.");
    const text = drawState(listed(60, 30)).list.chunks.map((chunk) => chunk.text).join("");
    expect(text).toContain("a shows the command");
  });

  test("a Pending row whose command `a` does not show names operad pending", () => {
    const row = listed(120, 30, { choices: [] }).tabs[0]?.list.rows[0];
    expect(row?.detail?.[0]).toBe("operad pending shows the command");
    const plain = listed(120, 30, { command: undefined }).tabs[0]?.list.rows[0];
    expect(plain?.detail?.join(" ")).not.toContain("command");
  });
});
