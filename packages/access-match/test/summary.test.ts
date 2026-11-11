import { expect, test } from "bun:test";
import { firstErrorLine, messageSummary, secretValuesOf, summarizeCall } from "../src/index.ts";

const CWD = "/work";

test("a bash call summarizes to its command on one line, cut at 500 characters", () => {
  expect(summarizeCall({}, "Bash", { command: "make\n  test" }, CWD)).toBe("make test");
  const cut = summarizeCall({}, "bash", { command: `echo ${"x".repeat(900)}` }, CWD);
  expect(cut?.length).toBe(500);
});

test("a bash call keeps its lines when the log asks for them, still cut at 500 characters", () => {
  expect(summarizeCall({}, "Bash", { command: "python3 - <<'EOF'\n  print(1)  \n\nEOF" }, CWD, { keepLines: true })).toBe("python3 - <<'EOF'\nprint(1)\n\nEOF");
  expect(summarizeCall({}, "Bash", { command: "\nmake\ntest\n" }, CWD, { keepLines: true })).toBe("\nmake\ntest\n");
  const cut = summarizeCall({}, "bash", { command: `echo a\n${"x".repeat(900)}` }, CWD, { keepLines: true });
  expect(cut?.length).toBe(500);
  expect(summarizeCall({}, "Read", { file_path: "/w/a\nb" }, CWD, { keepLines: true })).toBe("/w/a b");
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

const NOT_SHOWN = "<command not shown: could not read it safely>";
const ENV = { OPERAD_API_KEY: "key-value-123", MY_PASSWORD: "pw-value-456", SHORT_TOKEN: "abc", HOME: "/home/someone" };

// One row per rule: the command a worker ran -> what the log says.
const COMMANDS: readonly (readonly [string, string, string])[] = [
  // rule 1: known secret values are masked wherever they appear
  ["env secret by value", "curl -H key-value-123 x", "curl -H *** x"],
  ["env secret in a second place", "echo pw-value-456 pw-value-456", "echo *** ***"],
  ["env secret under 6 characters stays", "echo abc", "echo abc"],
  ["store secret by value", "echo from-the-store", "echo ***"],
  ["env value of a name that is not secret stays", "ls /home/someone", "ls /home/someone"],
  // rule 2: leading assignments keep the name, value shown as ***
  ["uppercase assignment", "A_KEY=abc make", "A_KEY=*** make"],
  ["lowercase assignment", "token=supersecret make test", "token=*** make test"],
  ["several assignments", "A=1 b='x y' c=\"p q\" make", "A=*** b=*** c=*** make"],
  ["quoted fragments", "token='super secret'\"more\" make test", "token=*** make test"],
  ["escaped space", "token=super\\ secret make test", "token=*** make test"],
  ["assignment after the command word is not leading", "make X=1", "make X=1"],
  ["unbalanced single quote", "echo 'oops", NOT_SHOWN],
  ["unbalanced double quote", "A=1 echo \"oops", NOT_SHOWN],
  ["trailing backslash", "A=1 echo \\", NOT_SHOWN],
  // rule 3: constructs the reader does not understand
  ["command substitution", "token=$(printf supersecret) make test", NOT_SHOWN],
  ["backticks", "token=`printf supersecret` make", NOT_SHOWN],
  ["process substitution", "x=<(cat f) make", NOT_SHOWN],
  ["heredoc", "x=<<EOF make", NOT_SHOWN],
  ["arithmetic", "x=$((1+2)) make", NOT_SHOWN],
  // rule 4: nothing else is redacted by pattern
  ["a substitution outside an assignment", "echo $(whoami) AWS_SECRET=zzz", "echo $(whoami) AWS_SECRET=zzz"],
  ["a flag that looks like a token", "tool --token=abcdef", "tool --token=abcdef"],
];

for (const [label, command, shown] of COMMANDS) {
  test(`bash command: ${label}`, () => {
    expect(summarizeCall({}, "Bash", { command }, CWD, { env: ENV, secrets: ["from-the-store"] })).toBe(shown);
  });
}

test("a secret is also masked in a path summary", () => {
  expect(summarizeCall({}, "Read", { file_path: "/w/key-value-123.txt" }, CWD, { env: ENV })).toBe("/w/***.txt");
});

test("the process environment is the default", () => {
  process.env["OPERAD_TEST_SUMMARY_TOKEN"] = "process-env-value";
  try {
    expect(summarizeCall({}, "Bash", { command: "echo process-env-value" }, CWD)).toBe("echo ***");
  } finally {
    delete process.env["OPERAD_TEST_SUMMARY_TOKEN"];
  }
});

test("a store's values are read, and an unreadable store has none", async () => {
  const store = {
    names: async () => ["a", "b"],
    get: async (name: string) => (name === "a" ? { reveal: () => "va" } : undefined),
  };
  expect(await secretValuesOf(store)).toEqual(["va"]);
  expect(await secretValuesOf({ names: async () => { throw new Error("x"); }, get: async () => undefined })).toEqual([]);
});

test("a call the profile denies is logged as denied, never its arguments or reason", () => {
  const profile = { denyPaths: ["/secrets"], denyCommands: ["rm"] };
  expect(summarizeCall(profile, "Read", { file_path: "/secrets/k" }, CWD)).toBe("Read denied by the access profile (rule: /secrets)");
  expect(summarizeCall(profile, "Bash", { command: "rm -rf /w" }, CWD)).toBe("Bash denied by the access profile (rule: rm)");
  expect(summarizeCall(profile, "Grep", { pattern: "x", path: "/secrets" }, CWD)).toBe("Grep denied by the access profile (rule: /secrets)");
});

test("an error shows its first non-empty line and a message its first 300 characters", () => {
  expect(firstErrorLine("\n\nboom\nmore")).toBe("boom");
  expect(firstErrorLine(42)).toBeUndefined();
  expect(firstErrorLine("   ")).toBeUndefined();
  expect(messageSummary("a\n\nb")).toBe("a b");
  expect(messageSummary("  ")).toBeUndefined();
  expect(messageSummary("y".repeat(400))?.length).toBe(300);
});

test("an error line masks secret values, from the store and from the environment", () => {
  expect(firstErrorLine("bad token store-secret-1\nmore", { secrets: ["store-secret-1"], env: {} })).toBe("bad token ***");
  expect(firstErrorLine("OPERAD_API_TOKEN=abcdef123", { env: { OPERAD_API_TOKEN: "abcdef123" } })).toBe("OPERAD_API_TOKEN=***");
});
