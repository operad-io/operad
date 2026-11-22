/**
 * A question's address, code and secret (ADR 0008 D8): the kernel checks the
 * scheme, the lengths and the flags before anyone is asked, then carries them
 * unchanged.
 */

import { describe, expect, test } from "bun:test";
import { normalizeQuestions, questionsProblem } from "../../src/plugin/question-form.ts";

const ONE = { id: "redirect", text: "Paste the address.", freeText: true };

describe("a question's address, code and secret", () => {
  test("an https address, a short code and a secret free-text answer are carried", () => {
    const questions = [
      {
        ...ONE,
        url: "https://auth.openai.com/oauth/authorize?state=abc",
        code: "ABCD-1234",
        secret: true as const,
      },
    ];
    expect(questionsProblem(questions)).toBeUndefined();
    expect(normalizeQuestions(questions)).toEqual(questions);
  });

  test("an address must be an absolute http or https one", () => {
    for (const url of ["javascript:alert(1)", "/auth/authorize", "ftp://example.com/x", "https://"]) {
      expect(questionsProblem([{ ...ONE, url }])).toContain("must be an absolute http or https address");
    }
    expect(questionsProblem([{ ...ONE, url: "http://127.0.0.1:1455/auth/callback" }])).toBeUndefined();
  });

  test("the address and the code are bounded", () => {
    expect(questionsProblem([{ ...ONE, url: `https://example.com/${"a".repeat(2048)}` }])).toContain(
      "at most 2048 characters",
    );
    expect(questionsProblem([{ ...ONE, code: "" }])).toContain("must be a non-empty string");
    expect(questionsProblem([{ ...ONE, code: "a".repeat(81) }])).toContain("at most 80 characters");
  });

  test("a secret answer needs free text", () => {
    expect(questionsProblem([{ id: "key", text: "Paste the key.", secret: true }])).toContain(
      "needs freeText true",
    );
    expect(questionsProblem([{ ...ONE, secret: false }])).toContain("must be true when it is set");
  });
});
