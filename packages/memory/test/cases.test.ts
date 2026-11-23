import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryPluginStore, PluginRegistry } from "@operad-io/engine";
import {
  CaseError,
  CASES_DIRECTORY,
  SCORES_FILE,
  approveCaseProposal,
  caseProposalItems,
  createMemoryPlugin,
  findMisses,
  isCorrection,
  loadCases,
  normalised,
  parseCase,
  programAnswerer,
  proposeCases,
  readScores,
  rejectCaseProposal,
  runScore,
  scoreAnswer,
  scoreText,
  type MemoryCase,
} from "../src/index.ts";

const EXAMPLES = fileURLToPath(new URL("../examples", import.meta.url));
const CASES = join(EXAMPLES, "cases");
const MEMORY = join(EXAMPLES, "memory");
const ECHO = fileURLToPath(new URL("./fixtures/answer-program.ts", import.meta.url));

const roots: string[] = [];

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "memory-cases-"));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function clock(start: number): () => number {
  let now = start;
  return () => (now += 1000);
}

const base = {
  get home(): string {
    return scratch();
  },
  casesDir: CASES,
  memory: MEMORY,
  record: false,
  now: clock(0),
};

describe("the case format", () => {
  test("the synthetic example set loads", () => {
    const cases = loadCases(CASES);
    expect(cases.map((entry) => entry.id)).toEqual(["cat-name", "lisbon-date", "not-in-memory", "old-hotel"]);
  });

  test("a case without phrases, with a bad kind or a bad id is refused", () => {
    const good = { id: "a", kind: "miss", question: "q", answer: { include: ["x"] } };
    expect(parseCase(good, "a.json").context).toEqual([]);
    expect(() => parseCase({ ...good, answer: { include: [] } }, "a.json")).toThrow(CaseError);
    expect(() => parseCase({ ...good, kind: "other" }, "a.json")).toThrow("kind");
    expect(() => parseCase({ ...good, id: "A b" }, "a.json")).toThrow("id");
    expect(() => parseCase({ ...good, context: [{ role: "bot", text: "x" }] }, "a.json")).toThrow("context");
  });

  test("a case file whose id differs from its name is refused", () => {
    const dir = scratch();
    writeFileSync(join(dir, "b.json"), JSON.stringify({ id: "a", kind: "miss", question: "q", answer: { include: ["x"] } }));
    expect(() => loadCases(dir)).toThrow("must match the file name");
  });

  test("the shipped schema names the same required fields", () => {
    const schema = JSON.parse(readFileSync(fileURLToPath(new URL("../memory-case.schema.json", import.meta.url)), "utf8")) as {
      required: string[];
    };
    expect(schema.required).toEqual(["id", "kind", "question", "answer"]);
  });
});

describe("scoring by exact phrases", () => {
  const found: MemoryCase = parseCase(
    { id: "a", kind: "miss", question: "q", answer: { include: ["14 March", "Gate B12"], avoid: ["March 4th"] } },
    "a.json",
  );

  test("case, spaces and punctuation do not matter", () => {
    expect(normalised("Gate  B-12!")).toBe("gateb12");
    expect(scoreAnswer("it leaves 14 march, gate b-12", found).passed).toBe(true);
  });

  test("a missing fact fails and is named", () => {
    const score = scoreAnswer("it starts 14 March", found);
    expect(score.passed).toBe(false);
    expect(score.missing).toEqual(["Gate B12"]);
  });

  test("repeating the wrong answer fails even when every fact is there", () => {
    const score = scoreAnswer("14 March, Gate B12, not March 4th", found);
    expect(score.passed).toBe(false);
    expect(score.repeated).toEqual(["March 4th"]);
  });

  test("Chinese phrases match without spaces", () => {
    const zh = parseCase({ id: "z", kind: "miss", question: "q", answer: { include: ["星期二 下午"] } }, "z.json");
    expect(scoreAnswer("兽医在星期二下午", zh).passed).toBe(true);
  });
});

describe("running the set", () => {
  test("against the example memory, what is stored passes and what is not stored fails", async () => {
    const run = await runScore(base);
    const byId = new Map(run.scores.map((score) => [score.id, score]));
    expect(byId.get("lisbon-date")?.passed).toBe(true);
    expect(byId.get("cat-name")?.passed).toBe(true);
    expect(byId.get("old-hotel")?.passed).toBe(true);
    expect(byId.get("not-in-memory")?.missing).toEqual(["X1234567"]);
    expect(run.record).toMatchObject({ total: 4, passed: 3, score: 0.75 });
  });

  test("a window that drops a message leaves it to the search of the record", async () => {
    const wide = await runScore({ ...base, window: 6 });
    const narrow = await runScore({ ...base, window: 0 });
    // The Porto hotel is only in the chat; with no window it is found by search, not shown.
    expect(wide.scores.find((score) => score.id === "old-hotel")?.passed).toBe(true);
    expect(narrow.scores.find((score) => score.id === "old-hotel")?.passed).toBe(true);
  });

  test("a message the window drops and the search cannot find is lost", async () => {
    const dir = scratch();
    writeFileSync(
      join(dir, "lost.json"),
      JSON.stringify({
        id: "lost",
        kind: "miss",
        context: [{ role: "user", text: "The locker code is 4417." }, { role: "assistant", text: "ok" }],
        question: "zzz qqq",
        answer: { include: ["4417"] },
      }),
    );
    expect((await runScore({ ...base, casesDir: dir, window: 2 })).record.passed).toBe(1);
    expect((await runScore({ ...base, casesDir: dir, window: 0 })).record.passed).toBe(0);
  });

  test("the memory index is cut at its limit", async () => {
    const dir = scratch();
    const memory = join(dir, "memory");
    mkdirSync(memory);
    writeFileSync(join(memory, "index.md"), `${"filler ".repeat(1200)}\nthe key phrase is tulip\n`);
    mkdirSync(join(dir, "cases"));
    writeFileSync(
      join(dir, "cases", "cut.json"),
      JSON.stringify({ id: "cut", kind: "miss", question: "zzz", answer: { include: ["tulip"] } }),
    );
    const run = await runScore({ ...base, casesDir: join(dir, "cases"), memory });
    expect(run.record.passed).toBe(0);
  });

  test("a change to the memory moves the score and the report names the case", async () => {
    const home = scratch();
    const first = await runScore({ ...base, home, record: true });
    const memory = join(scratch(), "memory");
    mkdirSync(join(memory, "topics"), { recursive: true });
    writeFileSync(join(memory, "index.md"), "# Memory index\n");
    const second = await runScore({ ...base, home, memory, record: true });
    expect(second.record.passed).toBeLessThan(first.record.passed);
    expect(second.previous?.passed).toBe(first.record.passed);
    const text = scoreText(second);
    expect(text).toContain("now fails: lisbon-date");
    expect(text).toContain("the settings differ");
  });

  test("the history in the home grows by one line per run and holds no case text", async () => {
    const home = scratch();
    const now = clock(1_000_000);
    await runScore({ ...base, home, record: true, now });
    await runScore({ ...base, home, record: true, now });
    await runScore({ ...base, home, record: false, now });
    const history = readScores(home);
    expect(history.map((entry) => entry.at)).toEqual([1_001_000, 1_002_000]);
    expect(history[1]?.settings).toMatchObject({ bot: "default", window: 6, answerer: "recall" });
    const raw = readFileSync(join(home, SCORES_FILE), "utf8");
    expect(raw).not.toContain("Lisbon");
    expect(scoreText(await runScore({ ...base, home, record: false, now }))).toContain("no change");
  });

  test("a program can stand in for the answerer", async () => {
    const dir = scratch();
    writeFileSync(
      join(dir, "p.json"),
      JSON.stringify({ id: "p", kind: "miss", question: "What is the code?", answer: { include: ["blue heron"] } }),
    );
    const run = await runScore({
      ...base,
      casesDir: dir,
      answerer: programAnswerer(["bun", ECHO]),
      answererName: "answer-program",
    });
    expect(run.record.passed).toBe(1);
    expect(run.record.settings.answerer).toBe("answer-program");
  });

  test("a program that fails stops the run", async () => {
    await expect(runScore({ ...base, answerer: programAnswerer(["bun", ECHO, "--fail"]) })).rejects.toThrow("code 3");
  });

  test("the command runs the same set, with the home's history", async () => {
    const root = scratch();
    const home = join(root, "home");
    mkdirSync(home);
    const registry = new PluginRegistry([createMemoryPlugin()], {
      home,
      cwd: root,
      store: new MemoryPluginStore({ root: join(root, "plugins") }),
      settings: { memory: {} },
      onLog: () => undefined,
    });
    const run = await registry.runCommand(["memory", "score", "--cases", CASES, "--memory", MEMORY, "--window", "3"], { cwd: root });
    expect(String(run?.value)).toContain("memory score: 3/4 (75%)");
    expect(readScores(home)[0]?.settings.window).toBe(3);
    await expect(registry.runCommand(["memory", "score", "--cases", CASES, "--nope"], { cwd: root })).rejects.toThrow("does not take");
  });
});

function say(store: MemoryPluginStore, chat: string, id: string, role: "user" | "assistant", text: string): void {
  store.append({
    type: "chat.message",
    object: { type: "chat", id: chat },
    cause: "test",
    data: { id, role, text, from: { via: "cli", id: "person" }, attachments: [], source: { kind: "cli", ref: null } },
  });
}

async function chatRig(): Promise<{ home: string; store: MemoryPluginStore }> {
  const root = scratch();
  const store = new MemoryPluginStore({ root: join(root, "plugins") });
  await store.put("chat", "c1", { title: "trip", cwd: root }, "test");
  say(store, "c1", "m1", "user", "I booked the hotel.");
  say(store, "c1", "m2", "assistant", "Great.");
  say(store, "c1", "m3", "user", "What is the hotel called?");
  say(store, "c1", "m4", "assistant", "Hotel Sol.");
  say(store, "c1", "m5", "user", "No, it is Casa Azul.");
  say(store, "c1", "m6", "assistant", "Sorry.");
  say(store, "c1", "m7", "user", "Thanks, that is fine.");
  return { home: join(root, "home"), store };
}

describe("proposing cases from the chat record", () => {
  test("a correction is found with its question and context; thanks is not one", async () => {
    const { store } = await chatRig();
    expect(isCorrection("No, it is Casa Azul.")).toBe(true);
    expect(isCorrection("不对，是 Casa Azul")).toBe(true);
    expect(isCorrection("Nothing else, thanks")).toBe(false);
    const { chatMessages } = await import("../src/search/sources.ts");
    const found = findMisses("c1", chatMessages(store, "c1"));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      message: "m5",
      question: "What is the hotel called?",
      wrong: "Hotel Sol.",
      context: [
        { role: "user", text: "I booked the hotel." },
        { role: "assistant", text: "Great." },
      ],
    });
  });

  test("extraction only proposes: no case file until approval, and it is not repeated", async () => {
    const { home, store } = await chatRig();
    const made = await proposeCases(store, { home, now: () => 5 });
    expect(made).toHaveLength(1);
    expect(existsSync(join(home, CASES_DIRECTORY))).toBe(false);
    expect(await proposeCases(store, { home, now: () => 6 })).toEqual([]);
    const items = await caseProposalItems(store);
    expect(items.map((item) => item.object?.id)).toEqual([...made]);
  });

  test("approving with phrases writes a case the runner can load; the item leaves pending", async () => {
    const { home, store } = await chatRig();
    const [id] = await proposeCases(store, { home, now: () => 5 });
    if (id === undefined) throw new Error("nothing proposed");
    await expect(approveCaseProposal(store, home, id, "  \n", "")).rejects.toThrow("answer.include");
    expect(existsSync(join(home, CASES_DIRECTORY))).toBe(false);
    await approveCaseProposal(store, home, id, "Casa Azul", "Hotel Sol");
    const [made] = loadCases(join(home, CASES_DIRECTORY));
    expect(made).toMatchObject({
      id,
      kind: "correction",
      question: "What is the hotel called?",
      answer: { include: ["Casa Azul"], avoid: ["Hotel Sol"] },
    });
    expect(await caseProposalItems(store)).toEqual([]);
    expect(await approveCaseProposal(store, home, id, "x", "")).toContain("already approved");
  });

  test("rejecting writes no case and the correction is not proposed again", async () => {
    const { home, store } = await chatRig();
    const [id] = await proposeCases(store, { home, now: () => 5 });
    if (id === undefined) throw new Error("nothing proposed");
    await rejectCaseProposal(store, id);
    expect(existsSync(join(home, CASES_DIRECTORY))).toBe(false);
    expect(await proposeCases(store, { home, now: () => 6 })).toEqual([]);
    expect(await caseProposalItems(store)).toEqual([]);
  });

  test("a correction that is already a case is not proposed", async () => {
    const { home, store } = await chatRig();
    const [id] = await proposeCases(store, { home, now: () => 5 });
    if (id === undefined) throw new Error("nothing proposed");
    await approveCaseProposal(store, home, id, "Casa Azul", "");
    const again = await chatRig();
    mkdirSync(join(again.home, CASES_DIRECTORY), { recursive: true });
    writeFileSync(join(again.home, CASES_DIRECTORY, `${id}.json`), "{}");
    expect(await proposeCases(again.store, { home: again.home, now: () => 5 })).toEqual([]);
  });
});
