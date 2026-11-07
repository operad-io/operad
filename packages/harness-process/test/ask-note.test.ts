import { expect, test } from "bun:test";
import { ASK_NOTE_TEMPLATE, askNote } from "../src/index.ts";

test("the paragraph is fixed and names the question and the answer", () => {
  expect(ASK_NOTE_TEMPLATE).toBe("You asked: {prompt}. The answer is: {answer}. Continue.");
  expect(askNote({ prompt: "Run rm -rf build?", choice: "yes" })).toBe(
    "You asked: Run rm -rf build?. The answer is: yes. Continue.",
  );
  expect(askNote({ prompt: "Q", choice: "yes", note: "but be careful" })).toBe(
    "You asked: Q. The answer is: yes - but be careful. Continue.",
  );
});

test("text in an answer that looks like a placeholder is kept as it is", () => {
  expect(askNote({ prompt: "{answer}", choice: "$&" })).toBe(
    "You asked: {answer}. The answer is: $&. Continue.",
  );
});

test("params without an answer have no paragraph", () => {
  expect(askNote(undefined)).toBeUndefined();
  expect(askNote({ prompt: "Q" })).toBeUndefined();
  expect(askNote("yes")).toBeUndefined();
});
