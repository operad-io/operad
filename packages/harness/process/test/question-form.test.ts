/**
 * A harness's own question as the kernel's form (ADR 0026 D6): the shared
 * mapping from a harness's questions, and the line a program and its host
 * exchange for one form.
 */

import { expect, test } from "bun:test";
import {
  answerFor,
  answerText,
  askFormLine,
  askFormRequest,
  askQuestions,
  formRequest,
  isSkipped,
} from "../src/index.ts";

test("a harness's question becomes a kernel question with a stable id", () => {
  expect(
    askQuestions([
      {
        id: "loader",
        text: "How should it load?",
        header: "Loader",
        choices: [
          { label: "Built-in", description: "use the built-in loader" },
          { label: "Other" },
          { label: "" },
        ],
      },
      { id: "", text: "What name?", freeText: true, multiple: true },
    ]),
  ).toEqual([
    {
      id: "loader",
      text: "How should it load?",
      header: "Loader",
      choices: [{ label: "Built-in", description: "use the built-in loader" }],
      freeText: true,
    },
    { id: "q2", text: "What name?", multiple: true, freeText: true },
  ]);
});

test("an empty or repeated id gets one that names one question", () => {
  const form = askQuestions([
    { id: "", text: "One?" },
    { id: "", text: "Two?" },
    { id: "q1", text: "Three?" },
  ]);
  expect(form.map((question) => question.id)).toEqual(["q1", "q2", "q1-2"]);
});

test("a question with no text is left out, so no answer could match it", () => {
  expect(askQuestions([{ id: "a", text: "   " }])).toEqual([]);
});

test("a harness's long text is cut to the kernel's bounds, not refused", () => {
  const form = askQuestions([
    {
      id: "a",
      text: "x".repeat(700),
      header: "h".repeat(60),
      choices: [{ label: "l".repeat(120), description: "d".repeat(400) }],
    },
  ]);
  const question = form[0];
  expect(question?.text.length).toBe(500);
  expect(question?.text.endsWith("…")).toBe(true);
  expect(question?.header?.length).toBe(40);
  expect(question?.choices?.[0]?.label.length).toBe(80);
  expect(question?.choices?.[0]?.description?.length).toBe(280);
});

test("the request carries the form's text and no choices of its own", () => {
  const form = askQuestions([
    { id: "a", text: "One?" },
    { id: "b", text: "Two?" },
  ]);
  const request = formRequest(form, { session: "s1" }, { graceSecs: 30 });
  expect(request).toEqual({
    prompt: "One?\n\nTwo?",
    questions: form,
    graceSecs: 30,
    resume: { session: "s1" },
  });
  expect(request.choices).toBeUndefined();
});

test("the answer to one question is its labels and free text", () => {
  const answers = [
    { id: "a", choices: ["Built-in"] },
    { id: "b", skipped: true as const },
    { id: "c", text: "typed" },
  ];
  expect(answerText(answerFor(answers, "a"))).toBe("Built-in");
  expect(isSkipped(answerFor(answers, "b"))).toBe(true);
  expect(answerText(answerFor(answers, "c"))).toBe("typed");
  expect(isSkipped(answerFor(answers, "missing"))).toBe(true);
});

test("the ask_form line carries the questions and the session", () => {
  const line = JSON.stringify({
    type: "ask_form",
    id: 3,
    questions: [{ id: "a", text: "One?", choices: [{ label: "X" }] }],
    session: "s1",
  });
  expect(askFormLine(line)).toEqual({
    id: 3,
    questions: [{ id: "a", text: "One?", choices: [{ label: "X" }] }],
    session: "s1",
  });
  expect(askFormLine(JSON.stringify({ type: "ask_form", id: 1, questions: [] }))).toBeUndefined();
  expect(askFormLine(JSON.stringify({ type: "ask_call", id: 1 }))).toBeUndefined();
  expect(askFormLine("not json")).toBeUndefined();
});

test("a form's ctx.ask request resumes the session and asks the form", () => {
  expect(askFormRequest({ id: 1, questions: [{ id: "a", text: "One?" }], session: "s1" })).toEqual({
    prompt: "One?",
    questions: [{ id: "a", text: "One?" }],
    resume: { session: "s1" },
  });
  expect(askFormRequest({ id: 2, questions: [{ id: "a", text: "One?" }], session: null })).toEqual({
    prompt: "One?",
    questions: [{ id: "a", text: "One?" }],
    onTimeout: "reject_once",
  });
});
