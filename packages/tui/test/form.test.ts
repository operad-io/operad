/**
 * A pending question with an address, a device code and a secret answer
 * (ADR 0014 D7): the TUI shows the address and the code, masks the secret, and
 * answers the question with `answers`.
 */

import { describe, expect, test } from "bun:test";
import type { PendingItem } from "@operad-io/engine";
import { initialState, reduce, type TuiState, type TuiStateEvent } from "../src/state.ts";
import { drawState } from "../src/view/index.ts";

function pending(questions: NonNullable<PendingItem["questions"]>, choices: readonly string[] = []): TuiState {
  const item: PendingItem = {
    runId: "run-1",
    flow: "bot:login",
    step: "login",
    prompt: "Sign in",
    choices,
    waitId: "wait:1",
    actions: [],
    questions,
  };
  return reduce(initialState({ width: 120, height: 30, theme: "dark" }), {
    type: "pending",
    items: [item],
  });
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

function overlayText(state: TuiState): string {
  const overlay = drawState(state).overlay;
  if (overlay === undefined) throw new Error("no overlay");
  return overlay.chunks.map((chunk) => chunk.text).join("");
}

const SECRET = "http://localhost:1455/auth/callback?code=secret-code&state=abc";
const QUESTION = {
  id: "redirect",
  text: "Paste the address the browser ended on.",
  url: "https://auth.openai.com/oauth/authorize?state=abc",
  code: "ABCD-1234",
  freeText: true,
  secret: true as const,
};

describe("a pending form with an address, a code and a secret", () => {
  test("shows the address and the code, masks the answer, and sends it as answers", () => {
    let state = pending([QUESTION]);
    expect(state.tabs.find((tab) => tab.kind === "pending")?.list.rows[0]?.answer).toBeDefined();
    state = press(state, "a");
    expect(state.input).toMatchObject({ kind: "form", question: 0 });

    const drawn = overlayText(state);
    expect(drawn).toContain("https://auth.openai.com/oauth/authorize?state=abc");
    expect(drawn).toContain("ABCD-1234");

    state = press(state, { type: "paste", text: SECRET });
    const typed = overlayText(state);
    expect(typed).not.toContain("secret-code");
    expect(typed).toContain("•");
    expect(state.answerRequest).toBeUndefined();

    state = press(state, "enter");
    expect(state.answerRequest).toEqual({
      runId: "run-1",
      waitId: "wait:1",
      answers: [{ id: "redirect", text: SECRET }],
    });
  });

  test("a device code with one choice answers with that choice", () => {
    let state = pending(
      [
        {
          id: "device",
          text: "ABCD-1234",
          url: "https://auth.openai.com/codex/device",
          code: "ABCD-1234",
          choices: [{ label: "Cancel" }],
        },
      ],
      ["Cancel"],
    );
    state = press(state, "a");
    expect(state.input).toMatchObject({ kind: "form", cursor: 0 });
    state = press(state, "enter");
    expect(state.answerRequest).toEqual({
      runId: "run-1",
      waitId: "wait:1",
      answers: [{ id: "device", choices: ["Cancel"] }],
    });
  });

  test("a form of two questions is left to a client that draws all of it", () => {
    const state = pending([
      { id: "a", text: "First?", freeText: true },
      { id: "b", text: "Second?", freeText: true },
    ]);
    expect(state.tabs.find((tab) => tab.kind === "pending")?.list.rows[0]?.answer).toBeUndefined();
  });
});
