import { expect, test } from "bun:test";
import { firstErrorLine, messageSummary, summarizeCall } from "../src/index.ts";

const CWD = "/work";

test("a bash call summarizes to its command on one line, cut at 500 characters", () => {
  expect(summarizeCall({}, "Bash", { command: "make\n  test" }, CWD)).toBe("make test");
  const cut = summarizeCall({}, "bash", { command: `echo ${"x".repeat(900)}` }, CWD);
  expect(cut?.length).toBe(500);
});

test("file tools summarize to their path, never their content", () => {
  expect(summarizeCall({}, "Read", { file_path: "/w/a.ts" }, CWD)).toBe("/w/a.ts");
  expect(summarizeCall({}, "edit", { path: "/w/b.ts", oldText: "SECRET", newText: "X" }, CWD)).toBe("/w/b.ts");
  expect(summarizeCall({}, "Write", { file_path: "/w/c.ts", content: "BODY" }, CWD)).toBe("/w/c.ts");
});

test("another tool shows its main argument, or nothing", () => {
  expect(summarizeCall({}, "Grep", { pattern: "needle", path: "/w" }, CWD)).toBe("/w");
  expect(summarizeCall({}, "WebFetch", { url: "https://example.com" }, CWD)).toBe("https://example.com");
  expect(summarizeCall({}, "TodoWrite", { todos: [] }, CWD)).toBeUndefined();
  expect(summarizeCall({}, "Bash", "not an object", CWD)).toBeUndefined();
});

test("a call the profile refuses is redacted, and environment values never show", () => {
  expect(summarizeCall({ denyPaths: ["/secrets"] }, "Read", { file_path: "/secrets/k" }, CWD)).toBe("[redacted]");
  expect(summarizeCall({}, "Bash", { command: "A_KEY=abc B=\"x y\" make; Z_1='q' run" }, CWD)).toBe(
    "A_KEY=… B=… make; Z_1=… run",
  );
});

test("lowercase environment values never show", () => {
  expect(summarizeCall({}, "Bash", { command: "token=supersecret make test" }, CWD)).toBe("token=… make test");
});

test("an environment value of shell-quoted fragments is hidden whole", () => {
  expect(summarizeCall({}, "Bash", { command: `token='super secret'"more" make test` }, CWD)).toBe("token=… make test");
});

test("an error shows its first non-empty line and a message its first 300 characters", () => {
  expect(firstErrorLine("\n\nboom\nmore")).toBe("boom");
  expect(firstErrorLine(42)).toBeUndefined();
  expect(firstErrorLine("   ")).toBeUndefined();
  expect(messageSummary("a\n\nb")).toBe("a b");
  expect(messageSummary("  ")).toBeUndefined();
  expect(messageSummary("y".repeat(400))?.length).toBe(300);
});
